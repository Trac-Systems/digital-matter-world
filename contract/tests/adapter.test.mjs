import test from 'node:test';
import assert from 'node:assert/strict';
import MatterContract from '../contract.js';
import MatterProtocol from '../protocol.js';
import { harness, deployment, alice, bob, signedBatch } from './helpers/harness.mjs';
import { chain } from './helpers/chain.mjs';

test('Contract.execute flushes successful messages and no writes from late batch refusal', async () => {
  const db = new Map(), contract = new MatterContract({}, { dmw: deployment });
  const storage = { get: async k => db.has(k) ? { value: db.get(k) } : null,
    put: async (k, v) => db.set(k, structuredClone(v)), del: async k => db.delete(k) };
  const msg = (op, value) => ({ type: 'msg', value: { dispatch: { type: 'msg', address: alice.address,
    msg: JSON.stringify({ network: deployment.network, op, value }) } } });
  assert.equal(await contract.execute(msg('hd', { headers: chain(6) }), storage), null);
  const before = structuredClone(db);
  const batch = signedBatch({ n: 1, from: 1, to: 1, ops: [{ op: 'mk', to: alice.address, asset: 'a', amount: '1' }, { op: 'rx', id: '00'.repeat(32) }] });
  assert.equal((await contract.execute(msg('bt', batch), storage)).message, 'mint_unknown'); assert.deepEqual(db, before);
  batch.ops.pop(); const good = signedBatch(batch);
  assert.equal(await contract.execute(msg('bt', good), storage), null);
  const tx = { type: 'tx', key: '11'.repeat(32), value: { ipk: alice.address, wp: bob.address, dispatch: { type: 'tf', value: { to: bob.address, assets: [['a','1']] } } } };
  assert.equal(await contract.execute(tx, storage), null); assert.equal(db.get(`v/${db.get(`a/${bob.address}`)}/a`), '1');
});
test('protocol exposes bounded reads through snapshots and closes views on failure', async () => {
  const h = harness(); await h.mint(); let opened = 0, closed = 0;
  const base = { view: { version: 1, checkout: () => {
    opened++; return { get: async k => h.db.has(k) ? { value: h.db.get(k) } : null, close: async () => { closed++; } };
  } } };
  const p = Object.create(MatterProtocol.prototype); p.base = base; p.config = { dmw: deployment }; p.api = {};
  await p.extendApi();
  assert.equal((await p.api.dmwHead()).counted, 1);
  assert.deepEqual(await p.api.dmwBatchLast(), { n: 1, to: 1 });
  assert.equal(await p.api.dmwBatchRoot(1), 'ab'.repeat(32));
  assert.equal(await p.api.dmwBalance(alice.address, 'a'), '100'); assert.equal(await p.api.dmwMint('../admin'), null);
  assert.equal(await p.api.dmwAgentNumber(alice.address), 1); assert.equal(await p.api.dmwAgentAddress(1), alice.address);
  assert.equal(await p.api.dmwLock('bad'), null); assert.equal(await p.api.dmwRecord('../admin'), null);
  assert.equal((await p.api.dmwSettings()).pending_blocks, 432); assert.deepEqual(await p.api.dmwPendingAdmin(), []);
  assert.equal((await p.api.dmwAuthority()).network, deployment.network); assert.equal((await p.api.dmwAuthority()).epoch, 0);
  h.db.set('s/epoch', 7); assert.equal((await p.api.dmwAuthority()).epoch, 7); assert.equal(await p.api.dmwHashAt(-1), null);
  await assert.rejects(p.withView(() => { throw new Error('read failure'); }), /read failure/);
  assert.equal(opened, closed);
});
test('protocol transaction parser binds the DMW network and excludes duplicate keys', () => {
  const p = Object.create(MatterProtocol.prototype); p.config = { dmw: deployment };
  const packet = { network: deployment.network, op: 'tf', value: { to: bob.address, assets: [['a','1']] } };
  assert.deepEqual(p.mapTxCommand(JSON.stringify(packet)), { type: 'tf', value: Object.assign(Object.create(null), packet.value) });
  assert.equal(p.mapTxCommand(JSON.stringify({ ...packet, network: 'foreign' })), null);
  assert.equal(p.mapTxCommand(JSON.stringify({ ...packet, op: 'unknown' })), null);
  assert.equal(p.mapTxCommand('{"op":"tf","op":"tf"}'), null);
});
