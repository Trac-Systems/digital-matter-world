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

