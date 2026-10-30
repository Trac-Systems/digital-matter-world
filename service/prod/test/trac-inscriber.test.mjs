import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createTrac } from '../trac.mjs';
import { GENESIS, MAINNET_PARAMS } from '../../../contract/beacon/bitcoin.js';
import { MemoryStore, temporary } from './helpers.mjs';
const require = createRequire(new URL('../../../local/package.json', import.meta.url)), btc = require('@scure/btc-signer'), { secp256k1 } = require('@noble/curves/secp256k1');
function runtimeFixture() {
  const config = { bootstrap: '11'.repeat(32), msbBootstrap: '22'.repeat(32), networkId: 918 }, deployment = { network: 'fixture-main', beacon: { params: MAINNET_PARAMS, checkpoint: GENESIS } };
  const data = new Map(), events = [], chosen = [], state = { revision: 0, count: 3, confirmed: false, changeDuringRead: false };
  const manager = { connectedValidators: () => Array.from({ length: state.count }, (_, i) => 'v' + i), pickRandomValidator: pool => pool[0], pickRandomConnectedValidator: () => 'v0' };
  const bus = { networkId: 918, bootstrapHex: config.msbBootstrap, config: { bootstrap: Buffer.from(config.msbBootstrap, 'hex'), networkId: 918 }, getTxvHex: async () => '01', getConfirmedTxInfo: async () => state.confirmed ? { decoded: {} } : null, network: { validatorConnectionManager: manager, validatorMessageOrchestrator: { send: async () => { chosen.push(manager.pickRandomConnectedValidator()); return true; } } } };
  const api = { dmwAuthority: async () => ({ network: 'fixture-main' }), dmwHead: async () => ({ counted: 100, tip: { height: 105, hash: '33'.repeat(32) } }), dmwBatchLast: async () => ({ n: 1, to: 99 }), dmwBatchRoot: async () => null, dmwAgentNumber: async () => 1, dmwMint: async id => data.get('m/' + id), dmwBalance: async () => { if (state.changeDuringRead) state.revision++; return '7'; } };
  const peer = { config: { dmw: deployment }, msbClient: bus, base: { key: Buffer.from(config.bootstrap, 'hex'), update: async () => {}, view: { get version() { return state.revision; }, get: async key => data.has(key) ? { value: data.get(key) } : null, async *createHistoryStream({ gte }) { yield* events.filter(e => e.seq >= gte); } } }, protocol: { instance: { api, broadcastTransaction: async (_dispatch, _flag, prepared) => { await bus.network.validatorMessageOrchestrator.send(prepared); return { txo: { tx: prepared.tx } }; } } } };
  return { config, deployment, runtime: { peer, bus, close: async () => {} }, state, data, events, chosen };
}
test('native point batches use one immutable checkout, bounded concurrency and the predecessor fence', async () => {
  const f = runtimeFixture(), keys = Array.from({ length: 64 }, (_, i) => `dc/plot/p2:7/${i}`);
  keys.forEach((key, i) => f.data.set(key, String(i)));
  let active = 0, peak = 0, opened = 0, closed = 0, changed = false;
  f.runtime.peer.base.view.checkout = revision => {
    assert.equal(revision, f.state.revision); opened++; const rows = new Map(f.data);
    return { get: async key => {
      active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--;
      f.data.set(key, 'later'); return { value: rows.get(key) };
    }, close: async () => { closed++; if (changed) f.runtime.peer.protocol.instance.api.dmwBatchLast = async () => ({ n: 2, to: 100 }); } };
  };
  const client = await createTrac({ ...f, store: new MemoryStore(), network: 'fixture-main' });
  const at = { counted: 100, last: { n: 1, to: 99 } };
  assert.deepEqual(await client('readMany', [keys, at]), keys.map((_, i) => String(i)));
  assert.equal(peak, 8); assert.equal(opened, 1); assert.equal(closed, 1);
  await assert.rejects(client('readMany', [keys, { ...at, last: { n: 0, to: 0 } }]), /trac_snapshot_changed/);
  assert.equal(opened, 1);
  await assert.rejects(client('readMany', [[...keys, 'extra'], at]), /point_read_batch/);
  changed = true; await assert.rejects(client('readMany', [keys, at]), /trac_snapshot_changed/);
  assert.equal(closed, 2);
});
test('Trac uses three distinct validators and checks durable transaction identity and MSB state', async () => {
  const f = runtimeFixture(), client = await createTrac({ ...f, store: new MemoryStore(), network: 'fixture-main' }), prepared = { tx: '77'.repeat(32), txv: '01', dispatch: {} };
  await client('sendTransaction', [prepared]); assert.equal(new Set(f.chosen).size, 3);
  assert.deepEqual(await client('status', [{ op: 'bt', value: { n: 2, root: '88'.repeat(32) }, transaction: prepared }]), { state: 'pending', msb: 'pending' });
  f.state.confirmed = true; assert.equal((await client('status', [{ op: 'bt', value: { n: 2 }, transaction: prepared }])).msb, 'confirmed');
  f.state.count = 2; await assert.rejects(client('sendTransaction', [prepared]), /trac_three_validators_required/);
});
test('Trac refuses wrong deployment and concurrent snapshot mutations', async () => {
  const f = runtimeFixture(), store = new MemoryStore(); await assert.rejects(createTrac({ ...f, store, network: 'wrong' }), /trac_deployment/);
  const client = await createTrac({ ...f, store, network: 'fixture-main' }); f.state.changeDuringRead = true;
  await assert.rejects(client('balance', ['owner', 'asset', { counted: 100, last: { n: 1, to: 99 } }]), /trac_snapshot_changed/);
});
test('Trac acceptance index preserves actual creation height across restart', async () => {
  const f = runtimeFixture(), store = new MemoryStore(), id = '99'.repeat(32), pending = { s: 0, o: 1, asset: 'a', block: 1, e: 300 };
  f.events.push({ seq: 0, type: 'put', key: 'b/cnt', value: 90 }, { seq: 1, type: 'put', key: 'm/' + id, value: pending }); f.data.set('m/' + id, pending); f.state.revision = 2;
  let client = await createTrac({ ...f, store, network: 'fixture-main' }); assert.deepEqual(await client('acceptance', [id]), { id, created: 90, expiry: 300 });
  client = await createTrac({ ...f, store, network: 'fixture-main' }); assert.deepEqual(await client('hold', ['a', 1]), { id, expiry: 300 }); assert.equal((await client('acceptance', [id])).created, 90);
});


test('migration reads an immutable own-notary checkout and refuses a moving revision without sending', async () => {
  const f = runtimeFixture(); f.data.set('bt/last', { n: 1, to: 99 }); f.data.set('b/cnt', 100);
  let closed = 0, move = false;
  f.runtime.peer.base.view.checkout = revision => {
    assert.equal(revision, f.state.revision); const rows = structuredClone([...f.data]);
    return { async *createReadStream() { for (const [key, value] of rows) yield { key, value }; if (move) f.state.revision++; }, close: async () => { closed++; } };
  };
  const client = await createTrac({ ...f, store: new MemoryStore(), network: 'fixture-main' });
  const snapshot = await client('migrationSnapshot');
  assert.deepEqual(snapshot.records, [['b/cnt', 100], ['bt/last', { n: 1, to: 99 }]]);
  assert.deepEqual(snapshot.options, f.deployment); assert.equal(snapshot.revision, 0); assert.equal(closed, 1);
  move = true; await assert.rejects(client('migrationSnapshot'), /trac_snapshot_changed/);
  assert.equal(closed, 2); assert.deepEqual(f.chosen, []);
});

test('terminal import uses a new notary reader namespace while preserving the old binding and cursor', async () => {
  const { rules: r } = await import('../../src/rules.mjs');
  const f = runtimeFixture(), store = new MemoryStore();
  await createTrac({ ...f, store, network: 'fixture-main' });
  const before = store.get('prodTrac', 'binding'); await store.put('prodTrac', 'cursor', 999);
  const manifest = { version: 1, network: 'fixture-main', fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2', previousBatchRoot: r.hash('previous'),
    bitcoinAnchor: { height: '100', hash: r.hash('anchor') }, settingsHash: r.hash('settings'), catalogRoot: r.hash('catalog'), accountsRoot: r.hash('accounts'),
    receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const manifestHash = r.hashObject(manifest);
  f.deployment.v2 = { manifest, manifestHash };
  f.config.bootstrap = '55'.repeat(32); f.runtime.peer.base.key = Buffer.from(f.config.bootstrap, 'hex');
  f.runtime.peer.protocol.instance.api.dmwRulesContext = async () => ({ ready: true, manifestHash });
  const client = await createTrac({ ...f, store, network: 'fixture-main' });
  await client('acceptance', ['absent']);
  assert.equal(store.get('prodTrac', 'binding'), before); assert.equal(store.get('prodTrac', 'cursor'), 999);
  assert.equal(store.get('prodTracV2/' + manifestHash, 'cursor'), '0');
  assert.notEqual(store.get('prodTracV2/' + manifestHash, 'binding'), before);
  f.config.bootstrap = '66'.repeat(32); f.runtime.peer.base.key = Buffer.from(f.config.bootstrap, 'hex');
  await assert.rejects(createTrac({ ...f, store, network: 'fixture-main' }), /trac_store_binding/);
  f.runtime.peer.protocol.instance.api.dmwRulesContext = async () => ({ ready: false, manifestHash });
  await assert.rejects(createTrac({ ...f, store, network: 'fixture-main' }), /trac_activation_binding/);
});

for (const base of ['9007199254740991', '9223372036854775807', '9'.repeat(80)]) test(`activated source snapshot and indexed cursor retain exact revision ${base}`, async () => {
  const f = runtimeFixture(), store = new MemoryStore();
  const { rules: r } = await import('../../src/rules.mjs');
  const manifest = { version: 1, network: 'fixture-main', fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2', previousBatchRoot: r.hash('previous'),
    bitcoinAnchor: { height: '100', hash: r.hash('anchor') }, settingsHash: r.hash('settings'), catalogRoot: r.hash('catalog'), accountsRoot: r.hash('accounts'),
    receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const manifestHash = r.hashObject(manifest), progressSpace = 'prodTracV2/' + manifestHash;
  f.deployment.v2 = { manifest, manifestHash };
  f.runtime.peer.protocol.instance.api.dmwRulesContext = async () => ({ ready: true, manifestHash });
  f.state.revision = base;
  const end = String(BigInt(base) + 2n), id = 'aa'.repeat(32), pending = { s: 0, o: '1', asset: 'a', block: '1', e: '300' };
  await store.put(progressSpace, 'cursor', base);
  f.runtime.peer.base.view.createHistoryStream = async function* ({ gte, lt }) {
    assert.equal(gte, base); assert.equal(lt, end);
    yield { seq: base, type: 'put', key: 'b/cnt', value: '90' };
    yield { seq: String(BigInt(base) + 1n), type: 'put', key: 'm/' + id, value: pending };
  };
  let client = await createTrac({ ...f, store, network: 'fixture-main' });
  const at = await client('stamp'); assert.equal(at.revision, base);
  assert.equal(await client('balance', ['owner', 'asset', at]), '7');
  if (base === '9007199254740991') {
    assert.equal(await client('balance', ['owner', 'asset', { ...at, revision: Number(base) }]), '7', 'retained numeric snapshot pins remain valid');
    await assert.rejects(client('balance', ['owner', 'asset', { ...at, revision: Number(base) - 1 }]), /trac_snapshot_changed/);
  }
  await assert.rejects(client('balance', ['owner', 'asset', { ...at, revision: Number.MAX_SAFE_INTEGER + 1 }]), /integer_v2/);
  f.state.revision = end;
  assert.deepEqual(await client('acceptance', [id]), { id, created: '90', expiry: '300' });
  assert.equal(store.get(progressSpace, 'cursor'), end);
  client = await createTrac({ ...f, store, network: 'fixture-main' });
  assert.equal((await client('stamp')).revision, end);
  f.state.revision = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(client('stamp'), /integer_v2/);
});
