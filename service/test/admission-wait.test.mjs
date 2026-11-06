import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { edPublic } from '../src/util.mjs';
import * as r from '../../rules/src/index.js';
import { NamedAdmission } from '../src/named-admission.mjs';
import { assetResources } from '../src/asset-resources.mjs';

const secret = r.hashBytes('disposable gateway'), wallet = r.hashBytes('disposable agent'), agent = edPublic(wallet);
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), wallet]), format: 'der', type: 'pkcs8' });
const settings = r.settingsRevision({ network: 'fixture', effectiveBatch: '43', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
const history = new r.SettingsHistory(); history.append(settings, r.hashObject(settings));
const resources = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE } });
class Store {
  rows = new Map();
  get(s, id) { return this.rows.get(s + '\0' + id); }
  async transact(ops) { for (const o of ops) this.rows.set(o.space + '\0' + o.id, JSON.parse(JSON.stringify(o.value))); }
  list(s) { return [...this.rows].filter(([k]) => k.startsWith(s + '\0')).map(([k, value]) => ({ id: k.slice(s.length + 1), value })); }
}
function commit(tag) {
  const move = { v: 2, ruleset: 'dmw-v2', settingsRevision: settings.revision, settingsHash: r.hashObject(settings), network: 'fixture', a: agent, t: 'discovery-commit-v2',
    b: '100', h: r.hash('100'), p: { commitment: r.hash(tag) }, w: '0', sig: '0'.repeat(128) };
  move.sig = sign(null, r.moveDigestV2(move), key).toString('hex'); return r.stableJSON(move);
}
function setup(wait, committee) {
  const store = new Store(), headers = { get: height => ({ height, hash: r.hash(height), nonce: 111, bits: 1 }) };
  const context = { ready: true, ruleset: 'dmw-v2', settings, settingsHistory: history, batch: '43', tip: '100', counted: '100', sealed: true,
    state: r.emptyNamedDiscovery(), acceptedRoot: r.namedStateRoot(r.emptyNamedDiscovery()) };
  return { context, store, admission: new NamedAdmission({ store, secret, context: () => context, history: headers, hashAt: r.hash, resources, committee, ...(wait ? { wait } : {}) }) };
}

test('a move sent while a batch is signed is admitted as soon as the gateway reopens', async () => {
  const { context, admission } = setup(assetResources({ admissionWaitMs: 3000, admissionPollMs: 20 }));
  setTimeout(() => { context.ready = false; }, 100);
  setTimeout(() => { context.sealed = false; }, 200);
  setTimeout(() => { context.ready = true; }, 300);
  const started = Date.now(), receipt = await admission.accept(commit('held'));
  assert.ok(receipt && Date.now() - started >= 280);
});
test('a held move gets the retryable busy answer while admission stays closed past the wait', async () => {
  const { admission } = setup(assetResources({ admissionWaitMs: 150, admissionPollMs: 20 }));
  const started = Date.now();
  await assert.rejects(admission.accept(commit('closed')), error => error.message === 'service_busy' && error.status === 503 && error.retryAfterMs === 1000);
  assert.ok(Date.now() - started >= 100);
});
test('the identical packet is refused once the busy period has passed; a new packet starts its own', async () => {
  const { context, admission } = setup(assetResources({ admissionWaitMs: 20, admissionPollMs: 10, admissionBusyMs: 200 }));
  await assert.rejects(admission.accept(commit('long')), /service_busy/);
  await new Promise(resolve => setTimeout(resolve, 220));
  await assert.rejects(admission.accept(commit('long')), error => error.message === 'reserved_batch_pending' && error.status === 503);
  await assert.rejects(admission.accept(commit('other')), /service_busy/);
  context.sealed = false;
  assert.ok(await admission.accept(commit('long')), 'the refused packet is admitted once the batch is accepted');
  assert.equal(admission.closedSince.size, 1);
});
test('without a busy period the refusal is immediate after the wait, as before', async () => {
  const { admission } = setup(assetResources({ admissionWaitMs: 20, admissionPollMs: 10, admissionBusyMs: 0 }));
  await assert.rejects(admission.accept(commit('none')), /reserved_batch_pending/);
});
test('without a wait setting admission answers at once, as before', async () => {
  const { admission } = setup();
  const started = Date.now();
  await assert.rejects(admission.accept(commit('now')), /reserved_batch_pending/);
  assert.ok(Date.now() - started < 100);
});

test('a held move answers well inside the kit request timeout', async () => {
  const { ServiceClient } = await import('../../kit/lib/service-client.mjs');
  // Leave at least half the kit's timeout for the receipt witness round after the hold.
  assert.ok(assetResources().admissionWaitMs * 2 <= new ServiceClient({}).timeoutMs);
});

test('future admission defaults to one batch and can be disabled without changing other resources', () => {
  assert.equal(assetResources().admissionFutureBatches, 1);
  assert.equal(assetResources({ admissionFutureBatches: 0 }).admissionFutureBatches, 0);
  for (const admissionFutureBatches of [-1, 2, 0.5, '1']) assert.throws(() => assetResources({ admissionFutureBatches }), /asset_resource_setting/);
});
test('busy signers: a move is answered after a bounded wait and acknowledged right after', async () => {
  const pending = [], committee = { acknowledgeReceipt: () => new Promise(resolve => pending.push(resolve)) };
  const { context, store, admission } = setup(assetResources({ admissionAcknowledgeMs: 100 }), committee); context.sealed = false;
  let started = Date.now(); const first = await admission.accept(commit('first'));
  assert.ok(first && Date.now() - started >= 90 && Date.now() - started < 1000, 'answered after the bounded wait');
  assert.equal(store.get('namedDedupe', first.move).witnessPending, true, 'still waiting for its acknowledgements');
  started = Date.now(); const second = await admission.accept(commit('second'));
  assert.ok(second && Date.now() - started < 80, 'while acknowledgements are outstanding the next move is answered at once');
  assert.deepEqual(await admission.accept(commit('first')), first, 'an identical retry gets the original receipt');
  for (const resolve of pending) resolve([{ signer: 'witness' }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const receipt of [first, second]) { const row = store.get('namedDedupe', receipt.move); assert.equal(row.witnessPending, undefined); assert.deepEqual(row.votes, [{ signer: 'witness' }]); }
  assert.equal(admission.outstanding, 0);
});
test('responsive signers: a move is answered once its acknowledgements arrive, as before', async () => {
  const committee = { acknowledgeReceipt: async () => [{ signer: 'witness' }] };
  const { context, store, admission } = setup(assetResources({ admissionAcknowledgeMs: 5000 }), committee); context.sealed = false;
  const started = Date.now(), receipt = await admission.accept(commit('quick'));
  assert.ok(Date.now() - started < 1000); assert.deepEqual(store.get('namedDedupe', receipt.move).votes, [{ signer: 'witness' }]);
  const failing = setup(assetResources({ admissionAcknowledgeMs: 5000 }), { acknowledgeReceipt: async () => { throw Object.assign(Error('receipt_fence_quorum_unavailable'), { status: 503 }); } });
  failing.context.sealed = false;
  await assert.rejects(failing.admission.accept(commit('refused')), /receipt_fence_quorum_unavailable/, 'a definite failure is still answered as one');
});
