import test from 'node:test';
import assert from 'node:assert/strict';
import { Policy } from '../signer/policy.mjs';
import { readPublicWinner, readPublicWinners, verifyPublicMintEvidence } from '../signer/public-claims.mjs';
import { BatchReplay } from '../signer/replay-worker.mjs';
import { rebuildBatch } from '../signer/adapter.mjs';
import { readPublicWinnerBatch } from '../../service/src/public-claim-readers.mjs';
import { hash } from '../../rules/src/core.js';
import { publicPlotId } from '../../rules/src/public-mint.js';
import { publicClaimBatch, publicScanBatch } from './public-claim-batch-fixture.mjs';

function fixture() {
  const id = hash('public-winner'), digest = hash('permit'), asset = 'p2:7', block = '12', publicKey = '02' + hash('committee');
  const at = { revision: '1', counted: '1200', last: { n: '5', to: '1200' } };
  const source = { publicMint: true, owner: null, requestId: id, asset, receiver: 'tap-wallet', request: { asset, block },
    deployment: { privilegePublicKey: publicKey } };
  const funding = { publicMint: true, owner: null, state: 'consumed', permitHash: digest, consumedRoot: hash('paid') }, permit = { digest };
  const records = new Map([[`dc/plot/${asset}/${block}`, id], ['fp/' + id, funding],
    ['fp/public/' + publicPlotId(asset, block), { winner: { id, source, permitHash: digest } }]]);
  const reads = { batchStamp: async () => structuredClone(at), financialRecord: async key => records.get(key) ?? null,
    publicMintPermit: async () => ({ source, funding, permit }) };
  const policy = new Policy({ network: 'permanent-claims', publicKey, reads });
  const proposal = { kind: 'mint', network: 'permanent-claims', version: 'public-v1', id, receiver: source.receiver };
  return { id, asset, block, records, reads, policy, proposal, source, funding, digest };
}

test('signer accepts a public permit only for the accepted public plot and consumed payment', async () => {
  const f = fixture(), approved = await f.policy.approve(f.proposal);
  assert.equal(approved.digest, f.digest);
  assert.ok(approved.slots.includes(`mint/block/${f.asset}/${f.block}`));
});

test('signer refuses an agent-first payment, a different public winner, and a forged public funding record', async () => {
  for (const alter of [
    f => f.records.delete(`dc/plot/${f.asset}/${f.block}`),
    f => { const other = hash('other'); f.records.set(`dc/plot/${f.asset}/${f.block}`, other); f.records.set('fp/' + other, f.funding); },
    f => { f.funding.owner = hash('agent'); },
    f => { f.funding.state = 'open'; },
    f => { f.records.set('fp/public/' + publicPlotId(f.asset, f.block), { winner: { id: f.id, permitHash: hash('wrong') } }); }
  ]) {
    const f = fixture(); alter(f); await assert.rejects(f.policy.approve(f.proposal), /public_(minted|permit_binding)/);
  }
});

test('signer rechecks both public-plot presence and absence rather than trusting supplied claim evidence', async () => {
  const f = fixture(), row = { asset: f.asset, block: f.block, id: f.id };
  assert.equal(await readPublicWinner(f.reads, f.asset, f.block), f.id);
  await verifyPublicMintEvidence([{ publicMintEvidence: [row] }], f.reads);
  await assert.rejects(verifyPublicMintEvidence([{ publicMintEvidence: [{ ...row, id: null }] }], f.reads), /public_mint_evidence_read/);
  f.records.delete(`dc/plot/${f.asset}/${f.block}`);
  await verifyPublicMintEvidence([{ publicMintEvidence: [{ ...row, id: null }] }], f.reads);
  await assert.rejects(verifyPublicMintEvidence([{ publicMintEvidence: [row] }], f.reads), /public_mint_evidence_read/);
  f.records.set(`dc/plot/${f.asset}/${f.block}`, f.id); f.records.delete('fp/' + f.id);
  await assert.rejects(readPublicWinner(f.reads, f.asset, f.block), /public_mint_evidence_missing/);
});

test('signer independently replays a signed agent claim refused as public_minted', async () => {
  const f = publicClaimBatch();
  assert.equal(f.output.file.moves[0].reason, 'public_minted');
  assert.equal((await f.policy.approve(f.proposal)).batch.root, f.proposal.batch.root);
});

test('signer refuses a rebuilt batch that hides an earlier public mint behind forged absence evidence', async () => {
  const f = publicClaimBatch({ supplied: null, independent: hash('old-public-winner') });
  assert.equal(f.output.file.moves[0].reason, 'accepted');
  await assert.rejects(f.policy.approve(f.proposal), /public_mint_evidence_read/);
});

test('signer replay worker can point-read old public plots independently when evidence is not supplied', async () => {
  const f = publicClaimBatch({ remote: true });
  assert.equal((await f.policy.approve(f.proposal)).batch.root, f.proposal.batch.root);
});

test('signer replays both agent-first refunds and public winners against independent payment evidence', async () => {
  for (const agentFirst of [true, false]) {
    const f = await publicScanBatch({ agentFirst });
    assert.equal(f.output.file.financialOperations[0].evidence.claim.claimed, agentFirst);
    assert.equal((await f.policy.approve(f.proposal)).batch.root, f.proposal.batch.root);
  }
});

test('signer refuses a scan whose payment evidence carries a different claim decision than its replayed operation', async () => {
  const f = await publicScanBatch({ forgedEvidence: true });
  await assert.rejects(f.policy.approve(f.proposal), /financial_effects/);
});

test('every signer repeats bounded independent evidence reads in audit and prepare, including duplicate comparisons', async () => {
  const rows = Array.from({ length: 130 }, (_, i) => ({ asset: 'p2:7', block: String(i), id: null }));
  for (let signer = 0; signer < 5; signer++) {
    let active = 0, peak = 0, count = 0;
    const reads = { financialRecord: async () => { count++; active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return null; } };
    for (let phase = 0; phase < 2; phase++) await verifyPublicMintEvidence([{ publicMintEvidence: [...rows, rows[0]] }], reads);
    assert.equal(count, 260); assert.equal(peak, 8);
    await assert.rejects(verifyPublicMintEvidence([{ publicMintEvidence: [rows[0], { ...rows[0], id: hash('forged') }] }], reads), /public_mint_evidence_read/);
  }
});

test('batched winner reads preserve both draft overlays and two-stage native reads', async () => {
  const id = hash('native'), draft = hash('draft'), at = { counted: '1', last: { n: '0', to: '0' } }, batches = [];
  const base = new Map([['dc/plot/p2:7/1', id], ['fp/' + id, { publicMint: true, owner: null }]]);
  const reads = { financialRecord: async key => base.get(key), financialRecords: async (keys, pin) => {
    assert.deepEqual(pin, at); batches.push(keys); return keys.map(key => base.get(key));
  } };
  const overlay = new Map([['dc/plot/p2:7/2', draft], ['fp/' + draft, { publicMint: true, owner: null }], ['dc/plot/p2:7/3', null]]);
  const store = { hasOverlay: (space, key) => overlay.has(key), get: (space, key) => overlay.get(key) };
  assert.deepEqual(await readPublicWinnerBatch({ reads, store, at }, [['p2:7', '1'], ['p2:7', '2'], ['p2:7', '3']]),
    [{ value: id }, { value: draft }, { value: null }]);
  assert.deepEqual(batches, [['dc/plot/p2:7/1'], ['fp/' + id]]);
  overlay.set('fp/' + id, { publicMint: false, owner: 'agent' });
  assert.deepEqual(await readPublicWinnerBatch({ reads, store, at }, [['p2:7', '1']]), [{ value: null }]);
});

test('signer worker batched fallback reproduces serial signed bytes, digest and roots across predecessor changes', async t => {
  const worker = new BatchReplay(); t.after(() => worker.close());
  for (const supplied of [null, hash('old-public-winner')]) {
    const f = publicClaimBatch({ supplied, remote: true });
    const context = { ...f.context, authority: await f.reads.authority(), publicMintGet: () => supplied };
    const expected = rebuildBatch(f.proposal.network, f.proposal, context), batches = [];
    context.publicMintBatch = pairs => { batches.push(pairs); return readPublicWinners(f.reads, pairs, { counted: context.counted, last: context.last }); };
    const actual = await worker.run(f.proposal.network, f.proposal, context);
    assert.deepEqual(actual.batch, expected.batch); assert.equal(actual.digest, expected.digest); assert.deepEqual(actual.files, expected.files);
    assert.ok(batches.length > 0); assert.ok(batches.every(b => b.length <= 64));
  }
});
