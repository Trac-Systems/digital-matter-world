import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { init } from '../lib/keyring.mjs';
import { nativeTnk } from '../lib/tnk-runtime.mjs';
import { tnkBalance, prepareTnkTransfer, sendTnkTransfer, tnkTransferStatus } from '../lib/index.mjs';
import { runTool, gameTools } from '../lib/tools.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { temp, cleanup, testWallet } from './helpers.mjs';
import { fixtureTrac } from './fixtures/tnk-adapter.mjs';

const to = encodeTracAddress(testWallet(2).publicKey), args = { actionId: 'send-one', to, amount: '1.2' };
const code = expected => error => error.code === expected;
async function fixture(t, { dryRun = false } = {}) {
  const directory = await temp(t), wallet = testWallet(), runtime = fixtureTrac(wallet), network = runtime.trac.network;
  let journal = await Journal.open(directory, network, { intervalMs: 0 });
  cleanup(t, () => journal.close());
  const agent = new Agent({ wallet, network, trac: runtime.trac, service: { network }, journal, dryRun });
  return { ...runtime, agent, wallet, directory, restart: async () => {
    journal.close(); journal = await Journal.open(directory, network, { intervalMs: 0 }); agent.journal = journal;
  } };
}

test('TNK balance reads big-endian uint128 atoms exactly and an absent account is zero', async t => {
  const { agent, state } = await fixture(t, { dryRun: true });
  state.balance = 123456789012345678901234567890n; state.fee = 10000000000000001n;
  assert.deepEqual(await tnkBalance(agent), { address: agent.address, balanceAtoms: String(state.balance),
    balanceTnk: '123456789012.34567890123456789', feeAtoms: String(state.fee), feeTnk: '0.010000000000000001', accountExists: true });
  state.exists = false;
  assert.deepEqual(await runTool({ agent }, 'tnk_balance', {}, { readOnly: true }), { address: agent.address,
    balanceAtoms: '0', balanceTnk: '0', feeAtoms: String(state.fee), feeTnk: '0.010000000000000001', accountExists: false });
  assert.equal(state.signed, 0); assert.equal(state.sent.length, 0);
  state.fee = null; await assert.rejects(tnkBalance(agent), code('tnk_fee_unavailable'));
});

test('TNK rejects bad checksum, raw keys, self sends and non-exact or nonpositive amounts before signing', async t => {
  const { agent, state } = await fixture(t);
  for (const address of [to.slice(0, -1) + (to.endsWith('q') ? 'p' : 'q'), '12'.repeat(32), to.toUpperCase(), '', null])
    await assert.rejects(sendTnkTransfer(agent, { ...args, to: address }), code('tnk_invalid_address'));
  await assert.rejects(sendTnkTransfer(agent, { ...args, to: agent.address }), code('tnk_self'));
  for (const amount of [0, 1.2, '', '0', '0.000', '-1', '+1', '1e2', '01', '1.', '.1', ' 1', '1 ', '0.0000000000000000001',
    '340282366920938463463.374607431768211456', 'MAX', null])
    await assert.rejects(sendTnkTransfer(agent, { ...args, amount }), code('tnk_invalid_amount'));
  await assert.rejects(sendTnkTransfer(agent, { ...args, actionId: '../bad' }), code('tnk_invalid_action_id'));
  assert.equal(state.signed, 0); assert.equal(state.sent.length, 0); assert.equal(agent.journal.recent().length, 0);
});

test('unsigned preview and dry-run resolve max as balance minus fee down to one atom', async t => {
  const { agent, state } = await fixture(t, { dryRun: true });
  state.balance = state.fee + 1n; state.validators = [];
  const preview = await prepareTnkTransfer(agent, { to, amount: 'max' });
  assert.equal(preview.amountAtoms, '1'); assert.equal(preview.amountTnk, '0.000000000000000001');
  assert.equal(preview.totalAtoms, String(state.balance)); assert.equal(preview.remainingAtoms, '0');
  assert.equal(preview.signed, false); assert.equal(preview.sent, false);
  const result = await runTool({ agent }, 'tnk_transfer', { ...args, amount: 'max' });
  assert.equal(result.state, 'dry-run'); assert.equal(result.signed, false); assert.equal(result.sent, false);
  assert.equal(state.signed, 0); assert.equal(state.prepared, 0); assert.equal(state.sent.length, 0); assert.equal(agent.journal.recent().length, 0);
  agent.dryRun = false;
  assert.equal((await prepareTnkTransfer(agent, { to, amount: 'max' })).signed, false);
  assert.equal(state.signed, 0);
});

test('funding and amount-plus-fee checks run before signing', async t => {
  const { agent, state } = await fixture(t);
  await assert.rejects(sendTnkTransfer(agent, { ...args, amount: '10' }), code('tnk_insufficient'));
  state.balance = state.fee;
  await assert.rejects(sendTnkTransfer(agent, { ...args, amount: 'max' }), code('tnk_insufficient'));
  state.balance = 0n;
  await assert.rejects(sendTnkTransfer(agent, { ...args, amount: 'max' }), code('tnk_insufficient'));
  state.balance = 10n ** 19n; state.exists = false;
  await assert.rejects(sendTnkTransfer(agent, args), code('tnk_insufficient'));
  assert.equal(state.signed, 0); assert.equal(agent.journal.recent().length, 0);
});

test('native builder signs once; durable packet precedes all three validator sends', async t => {
  const { agent, state, wallet, peer } = await fixture(t);
  assert.equal(peer.base.writable, false, 'TNK does not need subnet writer admission');
  state.beforeSend = payload => {
    const row = agent.journal.get('tnk/' + args.actionId);
    assert.equal(row.state, 'sending'); assert.equal(row.body.packet.payloadJSON, JSON.stringify(payload));
  };
  const result = await sendTnkTransfer(agent, args);
  assert.equal(result.state, 'pending'); assert.equal(result.amountAtoms, '1200000000000000000');
  assert.equal(result.feeTnk, '0.01'); assert.equal(result.signed, true); assert.equal(result.sent, true);
  assert.equal(state.signed, 1); assert.equal(state.prepared, 1);
  assert.equal(state.sent.length, 3); assert.equal(new Set(state.sent.map(s => s.validator)).size, 3);
  assert.equal(new Set(state.sent.map(s => s.bytes)).size, 1);
  const packet = JSON.parse(state.sent[0].bytes);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), wallet.publicKey]), format: 'der', type: 'spki' });
  assert.equal(verify(null, Buffer.from(result.tx, 'hex'), key, Buffer.from(packet.tro.is, 'hex')), true);
  assert.equal(JSON.stringify(result).includes(packet.tro.is), false, 'public result omits signed packet');
});

test('lost broadcast reply and restart replay exact signed bytes, even after balance/fee changes', async t => {
  const { agent, state, restart } = await fixture(t);
  state.transportError = true;
  await assert.rejects(sendTnkTransfer(agent, { ...args, amount: 'max' }), error => error.code === 'tnk_unknown_status' && /^[a-f0-9]{64}$/.test(error.tx));
  assert.equal(agent.journal.get('tnk/' + args.actionId).state, 'unknown');
  const bytes = state.sent[0].bytes, tx = JSON.parse(bytes).tro.tx;
  await restart(); state.transportError = false; state.balance = 0n; state.fee = 2n * 10n ** 16n;
  const result = await sendTnkTransfer(agent, { ...args, amount: 'max' });
  assert.equal(result.tx, tx); assert.equal(result.replayed, true); assert.equal(result.signed, false);
  assert.equal(result.amountTnk, '9.99'); assert.equal(result.feeTnk, '0.01');
  assert.equal(state.prepared, 1); assert.equal(state.signed, 1); assert.equal(state.sent.length, 6);
  assert.ok(state.sent.every(s => s.bytes === bytes));
  await sendTnkTransfer(agent, { ...args, amount: 'max' });
  assert.equal(state.signed, 1); assert.equal(state.sent.length, 9, 'pending retry also rebroadcasts');
  await assert.rejects(sendTnkTransfer(agent, { ...args, amount: '1' }), code('tnk_action_conflict'));
  await assert.rejects(sendTnkTransfer(agent, { ...args, amount: 'max', to: encodeTracAddress(testWallet(3).publicKey) }), code('tnk_action_conflict'));
});

test('native statuses distinguish absent, pending, confirmed and unavailable evidence', async t => {
  const { agent, state, trac, records } = await fixture(t);
  assert.deepEqual(await tnkTransferStatus(agent, 'missing'), { actionId: 'missing', tx: null, state: 'unknown', code: 'tnk_unknown_status' });
  const result = await sendTnkTransfer(agent, args), packet = JSON.parse(state.sent[0].bytes);
  assert.equal((await tnkTransferStatus(agent, args.actionId)).state, 'unknown');
  state.pending.set(result.tx, { decoded: packet });
  assert.equal((await runTool({ agent }, 'transaction_status', { tx: result.tx }, { readOnly: true })).state, 'pending');
  state.statusError = true;
  assert.equal((await tnkTransferStatus(agent, args.actionId)).code, 'tnk_unknown_status');
  state.statusError = false; state.confirmed.set(result.tx, { decoded: packet });
  assert.equal((await runTool({ agent }, 'transaction_status', { tx: result.tx }, { readOnly: true })).state, 'confirmed');
  assert.equal((await tnkTransferStatus(agent, args.actionId)).state, 'confirmed');
  assert.equal((await sendTnkTransfer(agent, args)).sent, false); assert.equal(state.sent.length, 3);
  assert.equal(agent.journal.get('tnk/' + args.actionId).state, 'accepted');
  const legacy = 'aa'.repeat(32);
  state.confirmed.set(legacy, { decoded: { txo: { tx: legacy } } });
  records.set(`tx/${legacy}`, { value: 1 }); records.set('txi/1', { value: { err: 'refused' } });
  assert.equal((await trac.transactionStatus(legacy)).state, 'rejected', 'MSB inclusion cannot override subnet rejection');
  records.set('txi/1', { value: {} }); assert.equal((await trac.transactionStatus(legacy)).state, 'accepted');
  assert.equal((await trac.transactionStatus('bb'.repeat(32))).state, 'unknown');
});

test('fewer than three distinct validators refuse before signing and a shrinking pool preserves the packet', async t => {
  const { agent, state } = await fixture(t);
  for (const validators of [[], ['a'], ['a', 'b'], ['a', 'b', 'a']]) {
    state.validators = validators;
    await assert.rejects(sendTnkTransfer(agent, args), code('tnk_validators'));
  }
  assert.equal(state.signed, 0); assert.equal(agent.journal.recent().length, 0);
  state.validators = ['a', 'b', 'c']; state.afterSign = () => { state.validators.pop(); };
  await assert.rejects(sendTnkTransfer(agent, args), code('tnk_validators'));
  assert.equal(state.signed, 1); assert.equal(state.sent.length, 0); assert.ok(agent.journal.get('tnk/' + args.actionId).body.packet);
  state.validators = ['a', 'b', 'c']; await sendTnkTransfer(agent, args);
  assert.equal(state.signed, 1); assert.equal(state.sent.length, 3);
});

test('runtime dry-run refuses direct builder and submit calls', async t => {
  const { agent, state, bus } = await fixture(t), runtime = nativeTnk(bus, { dryRun: true });
  await assert.rejects(runtime.prepareTnkTransfer(await prepareTnkTransfer(agent, args)), code('tnk_dry_run'));
  await assert.rejects(runtime.submitTnkTransfer({}), code('tnk_dry_run'));
  assert.equal(state.signed, 0); assert.equal(state.sent.length, 0);
  await sendTnkTransfer(agent, args);
  assert.equal(state.sent.length, 3, 'repeated adapter binding must not multiply fanout');
});

test('an interrupted signature is never replaced and a changed max packet stays journaled without sending', async t => {
  const { agent, state, bus } = await fixture(t);
  state.afterSign = () => { throw Error('Lost signing response'); };
  await assert.rejects(sendTnkTransfer(agent, args), code('tnk_prepare_failed'));
  assert.equal(state.signed, 1); assert.equal(state.sent.length, 0);
  state.afterSign = undefined;
  await assert.rejects(sendTnkTransfer(agent, args), code('tnk_unknown_status'));
  assert.equal(state.signed, 1);
  const prepare = bus.prepareTransferOperation.bind(bus);
  bus.prepareTransferOperation = async (...input) => { state.balance += 1n; return prepare(...input); };
  const max = { ...args, actionId: 'changed-max', amount: 'max' };
  await assert.rejects(sendTnkTransfer(agent, max), code('tnk_balance_changed'));
  assert.ok(agent.journal.get('tnk/changed-max').body.packet.payloadJSON);
  assert.equal(state.sent.length, 0); assert.equal(state.signed, 2);
  await assert.rejects(sendTnkTransfer(agent, max), code('tnk_balance_changed'));
  assert.equal(state.signed, 2);
});

test('two journal connections cannot sign the same action twice; interrupted signing claims remain intact', async t => {
  const { agent, state, directory, trac } = await fixture(t);
  const second = await Journal.open(directory, trac.network, { intervalMs: 0 }); cleanup(t, () => second.close());
  const other = new Agent({ wallet: agent.wallet, network: trac.network, trac, journal: second, service: agent.service, dryRun: false });
  const original = trac.prepareTnkTransfer;
  let release, started;
  const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  trac.prepareTnkTransfer = async quote => { started(); await gate; return original(quote); };
  const first = sendTnkTransfer(agent, args); await ready;
  await assert.rejects(sendTnkTransfer(other, args), code('tnk_unknown_status'));
  release(); await first;
  assert.equal(state.signed, 1); assert.equal(state.prepared, 1);
  trac.prepareTnkTransfer = async () => { throw Error('Interrupted before a packet was returned'); };
  const interrupted = { ...args, actionId: 'interrupted' };
  await assert.rejects(sendTnkTransfer(agent, interrupted), code('tnk_prepare_failed'));
  trac.prepareTnkTransfer = original;
  await assert.rejects(sendTnkTransfer(other, interrupted), code('tnk_unknown_status'));
  assert.equal(state.signed, 1); assert.equal(second.get('tnk/interrupted').body.packet, null);
});

test('dry-run retry reads the saved max amount without mutating the journal or signing', async t => {
  const { agent, state } = await fixture(t);
  const sent = await sendTnkTransfer(agent, { ...args, amount: 'max' });
  const before = agent.journal.get('tnk/' + args.actionId);
  agent.dryRun = true; state.balance = 0n;
  const preview = await sendTnkTransfer(agent, { ...args, amount: 'max' });
  assert.equal(preview.state, 'dry-run'); assert.equal(preview.tx, sent.tx); assert.equal(preview.amountTnk, sent.amountTnk);
  state.confirmed.set(sent.tx, { decoded: JSON.parse(before.body.packet.payloadJSON) });
  assert.equal((await tnkTransferStatus(agent, args.actionId)).state, 'confirmed');
  assert.deepEqual(agent.journal.get('tnk/' + args.actionId), before);
  assert.equal(state.signed, 1); assert.equal(state.sent.length, 3);
});

test('TNK tools classify sends as actions and expose no signed packets in status', async t => {
  const { agent, state } = await fixture(t), tools = gameTools({ agent });
  assert.equal(tools.tnk_transfer.readOnly, false); assert.equal(tools.tnk_balance.readOnly, true); assert.equal(tools.tnk_transfer_status.readOnly, true);
  await assert.rejects(runTool({ agent }, 'tnk_transfer', args, { readOnly: true }), /Use action/);
  await sendTnkTransfer(agent, args);
  const status = await agent.status();
  assert.equal(status.actions[0].tx, JSON.parse(state.sent[0].bytes).tro.tx);
  assert.equal(status.actions[0].statusTool.name, 'tnk_transfer_status');
  assert.equal(JSON.stringify(status).includes(JSON.parse(state.sent[0].bytes).tro.is), false);
});

test('CLI reads TNK and dispatches dry-run/live native transfers with the local fixture', async t => {
  const directory = await temp(t), password = 'disposable tnk fixture password', identity = await init({ directory, password });
  const config = join(directory, 'config.json'), input = join(directory, 'transfer.json');
  await writeFile(config, JSON.stringify({ directory, localOnly: true, mode: 'regtest', network: 'dmw-kit-test',
    gateway: 'http://127.0.0.1:5570', gatewayKey: '09'.repeat(32), adapter: fileURLToPath(new URL('./fixtures/tnk-adapter.mjs', import.meta.url)) }));
  await writeFile(input, JSON.stringify(args));
  const cli = fileURLToPath(new URL('../bin/dmw.mjs', import.meta.url)), run = promisify(execFile);
  const command = async argv => JSON.parse((await run(process.execPath, [cli, ...argv, '--config', config], {
    env: { ...process.env, DMW_SIGNER_PASSWORD: password }, timeout: 20000,
  })).stdout);
  assert.equal((await command(['read', 'tnk_balance'])).address, identity.address);
  assert.equal((await command(['action', 'tnk_transfer', input])).state, 'dry-run');
  const live = await command(['action', 'tnk_transfer', input, '--live']);
  assert.equal(live.state, 'pending'); assert.equal(live.amountTnk, args.amount);
  const retry = await command(['action', 'tnk_transfer', input, '--live']);
  assert.equal(retry.tx, live.tx); assert.equal(retry.replayed, true); assert.equal(retry.signed, false);
});
