import { encodeTracAddress, publicIdentities } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../lib/journal.mjs';
import { Agent } from '../lib/agent.mjs';
import { transactionHash, contentHash, transactionCommand, runtimeTrac } from '../lib/trac.mjs';
import { cleanup, temp, history, testWallet, fakeTrac } from './helpers.mjs';

test('journal serializes two connections, refuses conflicts and retains rate limits after restart', async t => {
  const dir = await temp(t); let now = 10000;
  let a = await Journal.open(dir, 'scope', { now: () => now, perTip: 2 }); const b = await Journal.open(dir, 'scope', { now: () => now });
  a.reserve('claim/1', { choice: 1 }, { packet: 1 });
  assert.equal(b.reserve('claim/1', { choice: 1 }, { packet: 2 }).body.packet, 1);
  assert.throws(() => b.reserve('claim/1', { choice: 2 }, {}), /Conflicting/);
  a.take(1); assert.throws(() => b.take(1), /rate limit/); a.close(); b.close();
  a = await Journal.open(dir, 'scope', { now: () => now, perTip: 2 });
  try { assert.throws(() => a.take(1), /rate limit/); now += 1000; a.take(1); now += 1000; assert.throws(() => a.take(1), /per-tip/); a.take(2); }
  finally { a.close(); }
});
test('TNK sends retry the exact saved nonce and digest after an ambiguous transport failure', async t => {
  const dir = await temp(t), wallet = testWallet(), hist = history(), { trac, state, context } = fakeTrac(hist), network = trac.network;
  const journal = await Journal.open(dir, network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const agent = new Agent({ wallet, network, trac, service: { network }, journal, dryRun: false });
  let first;
  trac.submitPacket = async p => { first = structuredClone(p); throw new Error('Disconnected'); };
  const args = { actionId: 'one', op: 'tf', value: { to: '12'.repeat(32), assets: [['p0', '40']] } };
  await assert.rejects(agent.transaction(publicIdentities(args)), /Disconnected/); assert.equal(journal.get('tx/one').state, 'unknown');
  trac.submitPacket = async p => { assert.deepEqual(p, first); state.sent.push(p); return { tx: p.tx, state: 'submitted' }; };
  const r = await agent.transaction(publicIdentities(args)); assert.equal(r.tx, first.tx);
  assert.equal((await agent.transaction(publicIdentities(args))).replayed, true); assert.equal(state.sent.length, 1);
  await assert.rejects(agent.transaction(publicIdentities({ ...args, value: { ...args.value, assets: [['p0', '41']] } })), /Conflicting/);
  assert.equal(first.ch, contentHash(transactionCommand('tf', args.value)));
  assert.equal(first.tx, transactionHash(context, first.ch, first.nonce));
});

test('pacing waits across the interval and a full tip, using a fresh head before sending', async t => {
  let now = 1000, tip = 20;
  const journal = await Journal.open(await temp(t), 'paced', { now: () => now, intervalMs: 10, perTip: 2 }); cleanup(t, () => journal.close());
  const getHead = async () => ({ tip: { height: tip } }), delays = [];
  const wait = async ms => { delays.push(ms); now += ms; if (ms === 250) tip++; };
  await journal.waitTurn(getHead, wait); await journal.waitTurn(getHead, wait);
  assert.equal((await journal.waitTurn(getHead, wait)).tip.height, 21);
  assert.deepEqual(delays, [10, 10, 250]);
});
test('the twelve-send limit prints one clear waiting message and resumes on the next Bitcoin block', async t => {
  const journal = await Journal.open(await temp(t), 'twelve', { intervalMs: 0 }); cleanup(t, () => journal.close());
  for (let n = 0; n < 12; n++) journal.take(20);
  let tip = 20, waits = 0; const output = [];
  t.mock.method(process.stderr, 'write', message => { output.push(message); return true; });
  const head = await journal.waitTurn(async () => ({ tip: { height: tip } }), async () => { if (++waits === 3) tip++; });
  assert.equal(head.tip.height, 21);
  assert.deepEqual(output, ['waiting for the next Bitcoin block (12/12 used)\n']);
});

test('simultaneous SDK actions queue and respect pacing without rejecting the second action', async t => {
  const wallet = testWallet(), { trac, state } = fakeTrac(history()), network = trac.network;
  const journal = await Journal.open(await temp(t), network, { intervalMs: 10 }); cleanup(t, () => journal.close());
  const agent = new Agent({ wallet, network, trac, service: { network }, journal, dryRun: false });
  const prepare = trac.prepare.bind(trac), submit = trac.submitPacket, sentAt = []; let first = true;
  trac.prepare = async (...args) => { if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 20)); } return prepare(...args); };
  trac.submitPacket = packet => { sentAt.push(Date.now()); return submit(packet); };
  const value = { to: '12'.repeat(32), assets: [['p0', '1']] };
  const result = await Promise.all(['one', 'two'].map(actionId => agent.transaction({ actionId, op: 'tf', value: publicIdentities(value) })));
  assert.ok(result.every(row => row.state === 'submitted')); assert.equal(state.sent.length, 2);
  assert.ok(sentAt[1] - sentAt[0] >= 9, 'interval is measured at submission, after preparation');
});
test('transaction preflight protects balances, recipient, amounts and dry-run', async t => {
  const journal = await Journal.open(await temp(t), 'scope', { intervalMs: 0 }); cleanup(t, () => journal.close());
  const wallet = testWallet(), hist = history(), { trac, state } = fakeTrac(hist), network = trac.network;
  const agent = new Agent({ wallet, network, trac, service: { network }, journal });
  const to = '12'.repeat(32), assets = [['p0', '10']];
  const r = await agent.transaction({ actionId: 'preview', op: 'tf', value: { to: encodeTracAddress(to), assets } });
  assert.equal(r.value.to, encodeTracAddress(to)); assert.equal(r.feeSource, agent.address);
  await assert.rejects(agent.transaction({ actionId: 'hex', op: 'tf', value: { to, assets } }), /trac1/);
  assert.equal(r.state, 'dry-run'); assert.equal(journal.recent().length, 0); assert.equal(state.sent.length, 0);
  await assert.rejects(agent.transaction({ actionId: 'too-much', op: 'tf', value: { to: encodeTracAddress(to), assets: [['p0', '101']] } }), /Insufficient/);
  assert.throws(() => transactionCommand('tf', { to, assets: [['p0', '1'], ['p0', '1']] }), /Invalid/);
  assert.throws(() => transactionCommand('tf', { to, assets: [['p0', '01']] }), /Invalid/);
  assert.throws(() => transactionCommand('ad_pause', { on: true }), /Only transfers/);
});
test('runtime adapter refuses public discovery or a non-regtest beacon before using a peer', () => {
  const peer = { config: { dmw: { network: 'local', beacon: { params: { retarget: false, powLimitBits: 0x207fffff } } }, dhtBootstrap: ['127.0.0.1:1234'] } };
  assert.throws(() => runtimeTrac(peer, { network: 'local', localOnly: true, msb: { config: { dhtBootstrap: ['example.com:1234'] } } }), /Local regtest/);
  peer.config.dmw.beacon.params.retarget = true;
  assert.throws(() => runtimeTrac(peer, { network: 'local', localOnly: true, msb: { config: { dhtBootstrap: ['127.0.0.1:1234'] } } }), /Local regtest/);
});


test('a slow submission keeps the next pacing interval durable across restart', async t => {
  let now=1000;const dir=await temp(t),options={now:()=>now,intervalMs:10};
  let journal=await Journal.open(dir,'slow-submit',options);
  await journal.waitTurn(async()=>({tip:{height:20}}));
  now=1020;journal.finishTurn();journal.close();
  journal=await Journal.open(dir,'slow-submit',options);cleanup(t,()=>journal.close());
  now=1021;const waits=[];
  await journal.waitTurn(async()=>({tip:{height:20}}),async ms=>{waits.push(ms);now+=ms;});
  assert.deepEqual(waits,[9]);assert.equal(now,1030);
});
