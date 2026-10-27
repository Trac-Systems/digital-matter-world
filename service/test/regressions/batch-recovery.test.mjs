import test from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../../src/pipeline.mjs';
import { Store } from '../../src/store.mjs';
import { Outbox } from '../../src/transport.mjs';
import { MintOperations } from '../../src/operations.mjs';
import { rules } from '../../src/rules.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { heightKey, hash } from '../../src/util.mjs';
import { temp } from '../helpers.mjs';
import { preflightBatch } from '../../../committee/signer/preflight.mjs';
import { fixture } from '../../../committee/test/fixture.mjs';
import { harness, committee, deployment, signedBatch } from '../../../contract/tests/helpers/harness.mjs';
import { observationFixture, requestInput, hashAt, gateway, gatewaySecret, network, owner, secret } from '../../../rules/test/observation-fixture.mjs';

const files = { immutable: async () => {}, json: async () => {}, publish: async output => ({ height: output.file.height, audit: { path: '/test.bin' } }) };
const replay = { run: async (input, history) => rules.processBlock({ ...input, history, hashAt: history.hashAt }), close: async () => {} };
const history = length => ({ length, hashAt, get: h => ({ height: h, nonce: h, bits: 1, hash: hashAt(h) }), field: h => String(h) });
const archivedEvidence = async (store, row) => { const text = await readFile(join(store.directory, 'retired-drafts', row.evidence.id + '.json'), 'utf8'); assert.equal(hash(text), row.evidence.hash); return JSON.parse(text); };
const readsFor = h => ({ batchLast: () => h.state().batchLast(), committeeEpoch: () => h.state().committeeEpoch(),
  counted: async () => (await h.state().head()).counted, batchRoot: async n => h.db.get('bt/' + n) ?? null });

for (const stage of ['unsigned', 'prepared', 'signed']) test(`same-key epoch rotation reconciles a ${stage} draft after restart`, async () => {
  const directory = await temp('epoch-recovery-'), h = harness(); await h.mint(['a']); await h.advance(1);
  let store = await Store.open(directory);
  const old = signedBatch({ n: 2, from: 2, to: 2, deadline: 8, ops: [] }), { sig, ...batch } = old, key = 'batch/0/2';
  const draft = { version: 3, execution: 2, proposal: { batch }, ...(stage === 'signed' ? { signature: sig } : {}) };
  if (stage === 'signed') draft.retainedEvidence = 'x'.repeat(4_500_000);
  await new Pipeline({ store, replay }).saveDraft(draft);
  if (stage !== 'unsigned') await store.put('ceremonies', key, { stage: 'prepared', proposal: draft.proposal });
  if (stage === 'signed') await store.put('outbox', key, { blocked: 'contract_rejected', value: old });
  await store.close(); store = await Store.open(directory);
  assert.equal(await h.run('ad_key', { key: committee }), null); await h.advance(432); assert.equal(await h.run('ad_apply', { id: 'key' }), null);
  const p = new Pipeline({ store, files, reads: readsFor(h), replay }); let rebuilt = 0;
  p.build = async () => { rebuilt++; assert.equal(store.get('meta', 'draft'), null); return null; };
  try {
    await p.tick(); assert.equal(rebuilt, 1); const archived = store.list('supersededDrafts')[0].value;
    assert.equal(archived.state, 'RETIRED'); assert.equal(archived.proof.reason, 'epoch_superseded'); assert.deepEqual((await archivedEvidence(store, archived)).draft, draft);
    assert.equal(store.get('outbox', key), null); assert.equal(store.get('ceremonies', key), null);
    const fresh = signedBatch({ epoch: 1, n: 2, from: 2, to: 434, deadline: 440, ops: [] });
    assert.equal(await h.run('bt', fresh), null);
  } finally { await store.close(); }
});

test('signed service draft retries through deadline, then archives and rebuilds the same slot automatically', async () => {
  const directory = await temp('expiry-recovery-'), store = await Store.open(directory);
  let counted = 2, last = { n: 0, to: 0 }, root = null, signed = 0, submits = 0;
  const reads = { counted: async () => counted, committeeEpoch: async () => 0, batchLast: async () => last, batchRoot: async () => root };
  const p = new Pipeline({ store, files, reads, replay, history: history(20), intake: { network, gateway, secret: gatewaySecret },
    committee: { signature: async (_key, proposal) => { signed++; return { signature: { compact: signedBatch(proposal.batch, { ...deployment, network }).sig } }; } } });
  const old = { v: 1, epoch: 0, n: 1, from: 1, to: 2, deadline: 8, root: 'aa'.repeat(32), ops: [] };
  await p.saveDraft({ version: 3, execution: 2, proposal: { batch: old }, signature: '11'.repeat(64) });
  await store.put('ceremonies', 'batch/0/1', { stage: 'complete', proposal: { batch: old }, result: { signature: 'original' } });
  p.outbox = new Outbox({ store, retryMs: 0, fallbackMs: 100000, transport: {
    prepareMessage: async (op, value) => ({ op, value }), status: async job => ({ state: root === job.value.root ? 'accepted' : 'pending' }),
    sendMessage: async ({ value }) => { submits++; if (value.root !== old.root) { root = value.root; last = { n: value.n, to: value.to }; } }
  } });
  try {
    await p.tick(); counted = 8; await p.tick(); assert.equal(signed, 0); assert.equal(submits, 2); assert.equal(store.count('supersededDrafts'), 0);
    counted = 9;
    await store.put('observations', '1', { id: '1', tip: 14, hash: hashAt(14), counted, confirmed: counted,
      receiptRoot: rules.sealReceipts([], { network, tip: 14, hash: hashAt(14) }, gatewaySecret) });
    await p.tick(); await p.tick();
    assert.equal(signed, 1); assert.equal(last.n, 1); assert.equal(last.to, 9); assert.equal(store.get('meta', 'draft'), null);
    const archive = store.list('supersededDrafts')[0].value;
    assert.equal(archive.proof.counted, 9); assert.equal(archive.proof.reason, 'deadline_expired');
    const evidence = await archivedEvidence(store, archive);
    assert.equal(evidence.draft.signature, '11'.repeat(64)); assert.equal(evidence.outbox.value.deadline, 8);
    assert.equal(store.get('batches', heightKey(1)).batch.deadline, 15);
  } finally { await store.close(); }
});

test('canonical acceptance immediately before rotation completes local acceptance instead of rebuilding', async () => {
  const store = await Store.open(await temp('accepted-rotation-')); let epoch = 0, last = { n: 0, to: 0 }, root = null;
  const reads = { counted: async () => 95, committeeEpoch: async () => epoch, batchLast: async () => last, batchRoot: async () => root };
  const p = new Pipeline({ store, files, reads, replay, history: history(101), intake: { network, gateway, secret: gatewaySecret }, committee: {} });
  try {
    await store.put('observations', '1', { id: '1', tip: 100, hash: hashAt(100), counted: 95, confirmed: 95,
      receiptRoot: rules.sealReceipts([], { network, tip: 100, hash: hashAt(100) }, gatewaySecret) });
    const draft = await p.build(); root = draft.proposal.batch.root; last = { n: 1, to: 95 }; epoch = 1;
    await p.tick(); assert.equal(store.count('supersededDrafts'), 0); assert.equal(store.get('meta', 'draft'), null);
    assert.equal(store.get('batches', heightKey(1)).batch.root, root); assert.equal(store.count('observations'), 0);
  } finally { await store.close(); }
});

test('late mint inputs share the aggregate op and asset budget and excess requests stay queued', async () => {
  const store = await Store.open(await temp('mint-budget-')), h = harness({ ...deployment, network });
  await h.advance(94); assert.equal(await h.batch([{ op: 'mk', to: owner, asset: 'p0', amount: '100' }]), null); await h.advance(1);
  const one = requestInput(committee), two = requestInput(committee, { nonce: rules.hash('second-mint') });
  one.evidence.balance = '100'; two.evidence.balance = '97';
  const ids = [one, two].map(i => rules.pendingId(network, i.request));
  const reads = { ...readsFor(h), settings: async () => ({ batch_bytes: 16384, batch_ops: 4, batch_assets: 1, batch_kv: 16 }) };
  h.db.set('s/current', await reads.settings());
  const operations = new MintOperations({ store, network, reads }); operations.inputs = async () => [one, two];
  const p = new Pipeline({ store, files, reads, operations, replay, history: history(101), intake: { network, gateway, secret: gatewaySecret }, committee: {} });
  try {
    for (const id of ids) await store.put('mintInputs', 'rq/' + id, { id, op: 'rq' });
    await store.put('observations', '1', { id: '1', tip: 100, hash: hashAt(100), counted: 95, confirmed: 95,
      receiptRoot: rules.sealReceipts([], { network, tip: 100, hash: hashAt(100) }, gatewaySecret) });
    const draft = await p.build(); assert.equal(draft.proposal.batch.ops.length, 3);
    assert.deepEqual(draft.items[0].output.file.mintOutcomes, [{ reason: 'accepted' }, { reason: 'operation_budget' }]);
    assert.equal(await h.run('bt', signedBatch(draft.proposal.batch, { ...deployment, network })), null);
    await p.tick(); assert.equal(store.get('mintInputs', 'rq/' + ids[0]), null); assert.ok(store.get('mintInputs', 'rq/' + ids[1]));
    assert.equal(await h.state().mint(ids[1]), null);
  } finally { await store.close(); }
});
