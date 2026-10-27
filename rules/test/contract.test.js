import { paidInput } from './pay-first-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { StateTransition } from '../../contract/state.js';
import { HeaderHistory, bytesToHex, hash, hashBytes, buildBatch, signRequest, makeRealOp, completeRealOp, cancelRealOp, pendingId } from '../src/index.js';
import { observationFixture } from './observation-fixture.mjs';
const source = process.env.DMW_HEADERS;
// These operation-builder tests supply the operations directly; committee replay
// separately verifies that actual audit outcomes generated those operations.
function operationFile(network, height, observation, ops, hashAt) {
  const f = observationFixture({ network, checkpoint: height + 5, counted: height - 1, table: [], initial: { observation: observation - 1 } });
  const { file } = f.add(height + 5, height, { hashAt }); file.ops.unshift(...ops); return file;
}
test('fungible builders and combined headers apply through all six operations in the actual contract', { skip: !source }, async () => {
  const history = new HeaderHistory((await readFile(source)).subarray(0, 32270 * 80)), checkpoint = 30240, cp = history.get(checkpoint);
  const secret = hashBytes('rules-contract-test-owner'), owner = bytesToHex(ed25519.getPublicKey(secret)), committee = hashBytes('rules-contract-test-committee'), network = 'rules-contract-local';
  const deployment = { network, admin: owner, committee: bytesToHex(secp256k1.getPublicKey(committee)),
    beacon: { checkpoint: { ...cp, chainwork: '1', times: Array.from({ length: 11 }, (_, i) => history.get(checkpoint - 10 + i).time) },
      params: { powLimitBits: 0x1d00ffff, interval: 2016, timespan: 1209600, retarget: true, confirmations: 6, branchDepth: 12 } } };
  const db = new Map(); let sequence = 0;
  async function apply(ops) {
    const height = checkpoint + ++sequence, headers = sequence === 1 ? Array.from({ length: 6 }, (_, i) => checkpoint + 1 + i) : [height + 5];
    const file = operationFile(network, height, sequence, ops, h => history.get(h).hash);
    const result = buildBatch({ network, executionHeight: height, epoch: 0, sequence, lastTo: height - 1, files: [file], headers: headers.map(h => bytesToHex(history.raw(h))) });
    const sig = secp256k1.sign(result.signingDigest, committee, { prehash: false, lowS: true }).toCompactHex();
    const state = new StateTransition(async key => db.get(key) ?? null, deployment);
    assert.equal(await state.transaction('bt', { ...result.batch, sig }, owner), null);
    for (const [key, value] of state.writes) if (value === undefined) db.delete(key); else db.set(key, value);
  }
  await apply([{ op: 'mk', to: owner, asset: 'p0', amount: '12' }, { op: 'mk', to: owner, asset: 'p1', amount: '10' }, { op: 'kv', key: 'rules/version', value: '2' }]);
  const xc = { owner, in: [['p0', '2'], ['p1', '2']], out: [['c1', '2']], nonce: hash('xc'), until: checkpoint + 100 };
  await apply([{ op: 'xc', request: xc, sig: signRequest('xc', network, xc, secret) }]);
  const rq = { owner, asset: 'c1', amount: '2', receive: hash('receive'), nonce: hash('rq'), until: checkpoint + 100, expires: checkpoint + 432 }, id = pendingId(network, rq);
  await apply([makeRealOp({ request: rq, sig: signRequest('rq', network, rq, secret) }, network, checkpoint + 3)]);
  assert.equal(db.get(`m/${id}`).amount, '2');
  await apply([{op:'mp',id}]);
  await apply([{op:'mc',id,permitHash:hash('permit'),payments:[{key:hash('paid-item'),amount:'100',total:'100'}]}]);
  await apply([completeRealOp(id,hash('inscription')+'i0')]);
  assert.equal(db.get(`m/${id}`).s,1); assert.equal(db.get(`m/${id}`).permitHash,hash('permit'));
  assert.equal(db.get(`v/${db.get(`a/${owner}`)}/p0`), '10'); assert.equal(db.get(`v/${db.get(`a/${owner}`)}/c1`), undefined);
});

test('rules rebuild a withheld mint batch for the live epoch without extending its signed expiry', async () => {
  const { harness, alice, committee, committeeSecret, deployment } = await import('../../contract/tests/helpers/harness.mjs');
  const h = harness(); await h.mint(['c1']); await h.advance(1);
  const request = { owner: alice.address, asset: 'c1', amount: '1', receive: hash('epoch-receiver'), nonce: hash('epoch-request'), until: 1000, expires: 700 };
  const sig = signRequest('rq', deployment.network, request, alice.secret);
  const op = makeRealOp({ request, sig }, deployment.network, 2), id = pendingId(deployment.network, request);
  const args = { network: deployment.network, sequence: 2, lastTo: 1, files: [operationFile(deployment.network, 2, 2, [op])] };
  const sign = built => ({ ...built.batch, sig: secp256k1.sign(built.signingDigest, committeeSecret, { prehash: false, lowS: true }).toCompactHex() });
  const withheld = sign(buildBatch({ ...args, executionHeight: (await h.state().head()).counted, epoch: await h.state().committeeEpoch() }));
  assert.equal(await h.run('ad_key', { key: committee }), null);
  assert.equal(await h.run('ad_set', { key: 'pending_blocks', value: 2016 }), null);
  await h.advance(432);
  assert.equal(await h.run('ad_apply', { id: 'key' }), null);
  assert.equal(await h.run('ad_apply', { id: 'set/pending_blocks' }), null);
  assert.equal(await h.run('bt', withheld), 'batch_epoch');
  assert.equal(await h.run('bt', { ...withheld, epoch: 1 }), 'batch_signature');
  const epoch = await h.state().committeeEpoch(); assert.equal(epoch, 1);
  const fresh = sign(buildBatch({ ...args, executionHeight: (await h.state().head()).counted, epoch }));
  assert.equal(await h.run('bt', fresh), null);
  assert.equal((await h.state().mint(id)).e, request.expires);
  assert.deepEqual(fresh.ops[0], withheld.ops[0]);
  assert.equal((await h.state().settings()).pending_blocks, 2016);
});

test('100-height recovery and replayed request, payment hold and consumption apply to the actual contract with conserved balances', async () => {
  const { harness, committee, committeeSecret, deployment } = await import('../../contract/tests/helpers/harness.mjs');
  const { observationFixture, requestInput, owner, network } = await import('./observation-fixture.mjs');
  const { parseHeader } = await import('../../contract/tests/helpers/chain.mjs');
  const h = harness({ ...deployment, network }), hashes = new Map([[0, deployment.beacon.checkpoint.hash]]);
  const available = async () => h.state().balance(await h.state().agent(owner), 'p0');
  let tip = 0;
  const advance = async n => { for (const raw of await h.advance(n)) hashes.set(++tip, parseHeader(raw).hash); };
  const hashAt = height => hashes.get(height) ?? null;
  await advance(94); assert.equal(await h.batch([{ op: 'mk', to: owner, asset: 'p0', amount: '30' }]), null);
  const f = observationFixture(), rq = requestInput(committee), id = pendingId(network, rq.request);
  let processed = 0;
  const apply = async () => {
    const last = await h.state().batchLast();
    const built = buildBatch({ network, executionHeight: (await h.state().head()).counted, epoch: 0, sequence: last.n + 1, lastTo: last.to, files: f.files.slice(processed) });
    const sig = secp256k1.sign(built.signingDigest, committeeSecret, { lowS: true, prehash: false }).toCompactHex();
    assert.equal(await h.run('bt', { ...built.batch, sig }), null); processed = f.files.length;
    return built;
  };
  await advance(105); rq.evidence.balance = '33';
  for (let t = 100; t <= 199; t++) f.add(t, t - 5, { hashAt,
    moves: t === 100 ? [{ window: 100, plots: [{ block: 100, patterns: [0] }] }] : [], mintOperations: t === 199 ? [rq] : [] });
  const recovered = await apply(); assert.equal(recovered.batch.from, 95); assert.equal(recovered.batch.to, 194);
  assert.equal((await h.state().mint(id)).e, rq.request.expires); assert.equal(await available(), '30');
  await advance(6);
  const mp=paidInput(rq,{op:'mp',created:194,confirmations:0});mp.evidence.balance='30';
  for(let t=200;t<=205;t++)f.add(t,t-5,{hashAt,mintOperations:t===205?[mp]:[]});
  await apply();assert.equal((await h.state().mint(id)).h,true);assert.equal(await available(),'30');
  await advance(1);
  const mc=paidInput(rq,{created:194});mc.evidence.balance='30';
  f.add(206,201,{hashAt,mintOperations:[mc]});await apply();
  assert.equal((await h.state().mint(id)).s,1);assert.equal(await available(),'30');
  const last=await h.state().batchLast();
  assert.equal(last.n,4);
});
