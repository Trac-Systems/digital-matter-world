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
function setup(wait) {
  const store = new Store(), headers = { get: height => ({ height, hash: r.hash(height), nonce: 111, bits: 1 }) };
  const context = { ready: true, ruleset: 'dmw-v2', settings, settingsHistory: history, batch: '43', tip: '100', counted: '100', sealed: true,
    state: r.emptyNamedDiscovery(), acceptedRoot: r.namedStateRoot(r.emptyNamedDiscovery()) };
  return { context, admission: new NamedAdmission({ store, secret, context: () => context, history: headers, hashAt: r.hash, resources, ...(wait ? { wait } : {}) }) };
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
