import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSigner } from '../signer/service.mjs';
import { Journal } from '../signer/journal.mjs';
import { fixture, batchFixture, network } from './fixture.mjs';
import { sha256 } from '../signer/crypto.mjs';
import { Committee } from '../../service/src/committee.mjs';
import { Store } from '../../service/src/store.mjs';
import { secp256k1 } from '@noble/curves/secp256k1';

test('lost batch sessions retry fresh bytes-identically while every original digest lock survives restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dmw-batch-attempt-')), b = batchFixture(), members = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i }));
  const servers = [], signers = [], states = [], configs = [], reads = [];
  const secrets = { journalKey: 'local-test', sidecarToken: 'local-test' };
  const store = await Store.open(join(root, 'gateway'));
  t.after(async () => {
    for (const signer of signers) await signer?.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await store.close(); await rm(root, { recursive: true });
  });
  for (let i = 0; i < 3; i++) {
    const f = fixture(); f.data.counted = b.context.counted;
    f.reads.batchContext = async () => b.context; f.reads.tip = async () => ({ tip: 100 });
    f.reads.batchLast = async () => b.context.last; f.reads.batchRoot = async () => null;
    const state = { failPrepare: true, session: null }; states.push(state); reads.push(f.reads);
    const server = createServer(async (req, res) => {
      let bytes = ''; for await (const chunk of req) bytes += chunk; const body = JSON.parse(bytes || '{}');
      if (req.url === '/prepare') {
        if (state.failPrepare) { res.writeHead(409).end('{"error":"session_missing"}'); return; }
        state.session = { id: body.id, status: 'prepared', digest: body.digest };
      }
      if (req.url === '/abort') state.session = null;
      if (req.url === '/go') {
        const signature = secp256k1.sign(state.session.digest, new Uint8Array(32).fill(2), { prehash: false, lowS: true });
        state.session = { ...state.session, status: 'complete', signature: { compact: signature.toCompactHex(), r: String(signature.r), s: String(signature.s), v: signature.recovery } };
      }
      if (req.url === '/result') { res.writeHead(409).end('{"error":"session_missing"}'); return; }
      res.end(JSON.stringify({ public: f.publicKey, epoch: 1, session: state.session }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    const config = { directory: join(root, 'signer-' + i), network, id: members[i].id, epoch: 1, members,
      sidecar: 'http://127.0.0.1:' + server.address().port };
    configs.push(config); signers.push(await createSigner(config, secrets, f.reads));
  }
  const c = new Committee({ store, network, batchRetryMs: 1, signers: members.map(peer => ({ id: peer.id, peer })) });
  c.healthy = async () => c.signers.slice(0, 3);
  let refuseReset = true;
  c.request = async (member, path, body) => {
    if (refuseReset && member.id === 's2' && path === '/retire-batch-attempt') throw Error('committee_http_timeout');
    try { return await signers[Number(member.id.slice(1))].handle(path, body); }
    catch (error) { throw Object.assign(Error('committee_' + error.message), { unreserved: !!error.unreserved }); }
  };
  const key = `batch/${b.proposal.batch.epoch}/${b.proposal.batch.n}`;
  await assert.rejects(c.signature(key, b.proposal), /committee_prepare_incomplete/);
  const original = store.get('ceremonies', key), digest = Buffer.from(b.built.signingDigest).toString('hex');
  await assert.rejects(signers[0].handle('/retire-batch-attempt', { network, id: original.id,
    batch: { ...b.proposal.batch, root: sha256('other') } }), /slot_conflict/);
  await store.put('ceremonies', key, { ...original, started: 0 });
  assert.equal(await c.signature(key, b.proposal), null);
  assert.equal(store.get('ceremonies', key).id, original.id, 'one unreachable peer cannot authorize a fresh attempt');
  refuseReset = false;
  await store.put('ceremonies', key, { ...store.get('ceremonies', key), lastReset: 0 });
  assert.equal(await c.signature(key, b.proposal), null);
  const renewed = store.get('ceremonies', key);
  assert.notEqual(renewed.id, original.id); assert.deepEqual(renewed.proposal, b.proposal);
  assert.deepEqual(renewed.peers, original.peers); assert.equal(renewed.digest, digest);
  assert.equal(store.count('batchCeremonyAttempts'), 1);
  for (let i = 0; i < 3; i++) {
    await signers[i].close(); signers[i] = null;
    const journal = await new Journal(join(configs[i].directory, 'signed.log'), secrets.journalKey, network, members[i].id).load();
    assert.equal(journal.slots.get(key).digest, digest);
    await assert.rejects(journal.reserve([key], sha256('different-batch'), sha256('conflict'), b.proposal.batch), /slot_conflict/);
    await journal.close();
    signers[i] = await createSigner(configs[i], secrets, reads[i]);
    await assert.rejects(signers[i].handle('/go', { id: original.id }), /ceremony_retired/);
    await assert.rejects(signers[i].handle('/prepare', { proposal: b.proposal, ceremony: { id: original.id, epoch: 1, peers: members.slice(0, 3) } }), /ceremony_retired/);
    states[i].failPrepare = false;
  }
  assert.equal(await c.signature(key, b.proposal), null);
  const result = await c.signature(key, b.proposal); assert.equal(result.session, renewed.id);
  assert.equal(secp256k1.verify(result.signature.compact, digest, fixture().publicKey, { prehash: false, lowS: true }), true);
  await assert.rejects(c.signature(key, { ...b.proposal, batch: { ...b.proposal.batch, root: sha256('replacement') } }), /ceremony_proposal_changed/);
  for (const config of configs) {
    const records = (await readFile(join(config.directory, 'signed.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(new Set(records.filter(r => r.type === 'reserve').map(r => r.digest)).size, 1);
    assert.equal(records.filter(r => r.type === 'reserve').length, 2);
    assert.equal(records.filter(r => r.type === 'signed').length, 1);
  }
});
