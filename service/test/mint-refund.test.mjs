import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { MintSender } from '../src/mint-sender.mjs';
import { MintSenderJournal } from '../src/mint-sender-journal.mjs';
import { MintSenderView, senderKeyId } from '../src/mint-sender-view.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { requestKey, refundFloatKey, fundingAmount, btc } from '../src/mint-sender-keys.mjs';
import { publicRefundKey } from '../../contract/public-mint.js';
import { refundRedeem } from '../src/mint-refund-protocol.mjs';
import { hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
const require = createRequire(new URL('../../kit/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
const root = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t, { funded = true, balance = '5000000000000000000000', withMint = false, refundsEnabled = true } = {}) {
  const directory = await mkdtemp(join(root, '.rf1-test-')), seed = new Uint8Array(32).fill(41), network = 'regtest';
  let settings = mintSenderSettings({ enabled: true, refundsEnabled, directory, seedFile: join(directory, 'seed'), bitcoinApiUrlFile: join(directory, 'bitcoin'),
    fundingPollMs: 20, terminalPollMs: 40, pollMs: 10, retryMs: 10, healthMs: 50 });
  const id = 'ab'.repeat(32), key = requestKey(seed, id, network), payer = requestKey(seed, 'cd'.repeat(32), network), float = refundFloatKey(seed, network), keyId = senderKeyId(seed, network);
  const record = { id, reference: '22'.repeat(32) + 'i0', tapAddress: payer.address, state: 'owed', reason: 'someone_paid_first',
    fees: [{ ticker: 'tap', amount: '1250000000000000000', role: 'treasury' }, { ticker: 'tap', amount: '250000000000000000', role: 'burn' }] };
  record.refundId = publicRefundKey(record).split('/').at(-1);
  const records = [record], coins = funded ? [{ txid: '11'.repeat(32), vout: 1, value: String(fundingAmount(settings)), script: hex(btc.p2tr(unhex(key.publicKey).slice(1)).script), cardinal: true, confirmed: true }] : [];
  const status = { requestId: id, payer: payer.address, receiver: payer.address, fundingAddress: key.address, payBy: { rail: 'tap', untilBlock: 100 },
    state: 'refundable', refunds: [record], publicMint: true, counted: 101, winner: { id: 'ef'.repeat(32) } };
  let now = 1000000, sender, failBroadcast = 0, tapFails = false, feeRate = 2, accepted = true;
  const sent = [], transactions = new Map(), confirmed = new Set(), logs = [];
  const gateway = {
    async list() { return { keyId, rows: withMint ? [structuredClone(status)] : [], next: null }; },
    async status() { return structuredClone(status); },
    async refunds() { return { keyId, rows: structuredClone(records), next: null }; },
    async refund(rid) { return { keyId, record: accepted ? structuredClone(records.find(r => r.refundId === rid)) : null }; },
    async report() { throw Error('unexpected mint'); },
  };
  const bitcoin = {
    async verifyNetwork() {},
    async utxos(address) { assert.equal(address, key.address); return structuredClone(coins); },
    async paymentFunding(address, reference) { assert.ok(records.some(r => r.reference === reference)); return this.utxos(address); },
    async feeRate() { return feeRate; },
    async transaction(txid) { return transactions.get(txid) ?? null; },
    async broadcast(raw, txid) {
      assert.equal(btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true }).id, txid);
      sent.push({ raw, txid }); if (!transactions.has(txid)) transactions.set(txid, { confirmed: false });
      if (failBroadcast && sent.length === failBroadcast) throw Error('private provider details');
    },
    tap: {
      async float(address, authority) { if (tapFails) throw Error('private source error'); assert.equal(address, float.address); return { value: { address, balances: { tap: balance }, authority: { state: authority ? 'active' : 'not_created' } }, snapshot: { height: '100', blockHash: '00'.repeat(32) } }; },
      async confirmed(row) { if (tapFails) throw Error('private source error'); return confirmed.has(row.id) ? { txid: row.plan.revealTxid, height: 101 } : null; },
      async cardinal(coins) { return coins; },
    },
  };
  const open = () => {
    const journal = new MintSenderJournal(directory, { keyId, network, now: () => now });
    sender = new MintSender({ seed: seed.slice(), network, settings, journal, gateway, bitcoin, now: () => now, log: row => logs.push(row) });
  };
  open();
  sender.journal.meta('refundAuthority', { payload: { auth: ['tap'] }, plan: { inscriptionId: '33'.repeat(32) + 'i0', revealTxid: '33'.repeat(32) } });
  t.after(async () => { try { await sender?.close(); } finally { key.privateKey.fill(0); payer.privateKey.fill(0); float.privateKey.fill(0); seed.fill(0); await rm(directory, { recursive: true, force: true }); } });
  return { directory, settings, id, key, payer, float, record, records, status, coins, sent, transactions, confirmed, logs, bitcoin, gateway,
    get sender() { return sender; }, get row() { return sender.journal.refund(record.refundId); },
    tick: async () => { now += 60; await sender.tick(); await sender.drain(); },
    fail: n => { failBroadcast = n; }, balance: value => { balance = value; }, fee: value => { feeRate = value; }, tapFails: value => { tapFails = value; }, accepted: value => { accepted = value; },
    async restart(overrides = {}) { await sender.close(); settings = mintSenderSettings({ ...settings, ...overrides }); open(); },
    view: () => new MintSenderView({ seed: seed.slice(), settings, network, now: () => now }),
  };
}

test('refunds default to disabled and disabled operation cannot discover or sign a new debit', async t => {
  assert.equal(mintSenderSettings().refundsEnabled, false);
  const f = await fixture(t, { refundsEnabled: false });
  let discovered = 0;
  f.gateway.refunds = async () => { discovered++; throw Error('unexpected refund discovery'); };
  await f.tick();
  assert.equal(discovered, 0); assert.equal(f.row, null); assert.equal(f.sent.length, 0);
  f.sender.journal.saveRefund({ id: f.record.refundId, record: f.record, state: 'refund_pending' });
  await f.sender.refunds.process(f.record.refundId);
  assert.equal(f.row.plan, undefined); assert.equal(f.sent.length, 0);
});

test('disabling refunds across restart recovers only the previously journaled transaction bytes', async t => {
  const f = await fixture(t); f.fail(1); await f.tick();
  assert.equal(f.row.state, 'refund_sending');
  const plan = structuredClone(f.row.plan);
  await f.restart({ refundsEnabled: false }); await f.tick();
  assert.deepEqual(f.row.plan, plan);
  assert.deepEqual(f.sent.map(row => row.raw), [plan.commitHex, plan.commitHex, plan.revealHex]);
  assert.equal(f.row.state, 'refund_sent');
});

test('losing payment sends the full TAP refund with only payer funding, payer change and payer postage', async t => {
  const f = await fixture(t, { withMint: true }); await f.tick();
  assert.equal(f.row.state, 'refund_sent'); assert.equal(f.sent.length, 2);
  assert.equal(f.row.amounts.tap, '1500000000000000000');
  assert.deepEqual(f.row.payload.redeem.items, [{ tick: 'tap', amt: '1.5', address: f.payer.address, dta: 'dmw-refund-v1|' + f.record.refundId }]);
  const commit = btc.Transaction.fromRaw(unhex(f.row.plan.commitHex));
  const reveal = btc.Transaction.fromRaw(unhex(f.row.plan.revealHex), { allowUnknownInputs: true });
  assert.equal(commit.inputsLength, 1); assert.equal(hex(commit.getInput(0).txid), f.coins[0].txid);
  const script = hex(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(f.payer.address)));
  assert.equal(hex(commit.getOutput(1).script), script); assert.equal(hex(reveal.getOutput(0).script), script);
  assert.equal(commit.getOutput(1).amount + reveal.getOutput(0).amount + BigInt(f.row.plan.feeSats), BigInt(f.coins[0].value));
  assert.equal(f.sender.journal.get(f.id).returnPlan, undefined);
  f.confirmed.add(f.record.refundId); await f.tick();
  assert.equal(f.row.state, 'refund_confirmed'); const sent = f.sent.length;
  await f.tick(); await f.restart(); await f.tick(); assert.equal(f.sent.length, sent);
  const view = f.view(); assert.equal(view.decorateRefund(f.record).refundDelivery.state, 'refund_confirmed'); view.close();
});

test('float empty never sends partially, alarms, then pays after top-up', async t => {
  const f = await fixture(t, { balance: '1000000000000000000', withMint: true }); await f.tick();
  assert.equal(f.row.state, 'refund_waiting_funds'); assert.equal(f.row.plan, undefined); assert.equal(f.sent.length, 0);
  f.sender.health(true); assert.ok(f.logs.some(r => r.event === 'mint_sender_health' && r.refundAlarm && r.refundCounts.refund_waiting_funds === 1));
  f.balance('1500000000000000000'); await f.tick(); assert.equal(f.row.state, 'refund_sent'); assert.equal(f.sent.length, 2);
});

for (const lost of [1, 2]) test('restart after lost broadcast ' + lost + ' retries exact bytes, including during a TAP outage', async t => {
  const f = await fixture(t); f.fail(lost); await f.tick();
  assert.equal(f.row.state, 'refund_sending'); const saved = structuredClone(f.row.plan);
  await f.restart(); f.tapFails(true); f.transactions.clear(); await f.tick();
  assert.deepEqual(f.row.plan, saved); assert.equal(f.sent.at(-2).raw, saved.commitHex); assert.equal(f.sent.at(-1).raw, saved.revealHex);
  assert.throws(() => f.sender.journal.saveRefund({ ...f.row, plan: { ...saved, revealTxid: '00'.repeat(32) } }), /immutable/);
  assert.ok(!JSON.stringify(f.logs).includes('private'));
  f.tapFails(false); f.confirmed.add(f.record.refundId); await f.tick(); assert.equal(f.row.state, 'refund_confirmed');
});

test('two-step or old payment without set-aside requires operator and never spends float BTC', async t => {
  const f = await fixture(t, { funded: false }); await f.tick();
  assert.equal(f.row.state, 'refund_needs_operator'); assert.match(f.row.message, /set-aside missing/); assert.equal(f.sent.length, 0);
  assert.equal(f.row.plan, undefined); assert.equal(f.row.coin, undefined);
});

test('accepted public loss holds its BTC while the refund record or authority is not ready', async t => {
  const f = await fixture(t, { withMint: true }); f.records.length = 0; f.status.refunds = [];
  await f.tick(); assert.equal(f.sent.length, 0); assert.equal(f.sender.journal.get(f.id).returnPlan, undefined);
  f.records.push(f.record); f.sender.journal.meta('refundAuthority', null); await f.tick();
  assert.equal(f.row.state, 'refund_needs_operator'); assert.match(f.row.message, /authority/); assert.equal(f.sent.length, 0);
});

test('fee cap and final accepted-record recheck prevent a new send', async t => {
  const f = await fixture(t); f.fee(f.settings.maxRefundFeeRate + 1); await f.tick();
  assert.equal(f.row.state, 'refund_pending'); assert.equal(f.sent.length, 0);
  f.fee(2); f.accepted(false); await f.tick(); assert.equal(f.row.plan, undefined); assert.equal(f.sent.length, 0);
});

test('journal excludes an already signed mint/return coin from refunds', async t => {
  const f = await fixture(t);
  f.sender.journal.save({ id: f.id, payer: f.payer.address, receiver: f.payer.address, address: f.key.address, state: 'returned', coin: f.coins[0], returnPlan: { txid: '44'.repeat(32), hex: '00' } });
  await f.tick(); assert.equal(f.row.state, 'refund_needs_operator'); assert.equal(f.sent.length, 0);
});

test('a refund coin cannot later be signed as a mint or Bitcoin return', async t => {
  const f = await fixture(t); await f.tick();
  assert.throws(() => f.sender.journal.save({ id: f.id, payer: f.payer.address, receiver: f.payer.address, address: f.key.address,
    state: 'returning', coin: f.coins[0], returnPlan: { txid: '44'.repeat(32), hex: '00' } }), /spend_conflict/);
});

test('second refund waits for first TAP evidence and cannot consume the same payer output twice', async t => {
  const f = await fixture(t), next = { ...f.record, reference: '55'.repeat(32) + 'i0' };
  next.refundId = publicRefundKey(next).split('/').at(-1); f.records.push(next); await f.tick();
  const first = f.sender.journal.pendingRefund(); assert.ok(first); assert.equal(f.sent.length, 2);
  await f.tick(); assert.equal(f.sender.journal.pendingRefund().id, first.id);
  f.confirmed.add(first.id); await f.tick(); await f.tick();
  const second = f.sender.journal.refund(first.id === next.refundId ? f.record.refundId : next.refundId);
  assert.equal(second.state, 'refund_needs_operator'); assert.equal(second.plan, undefined);
});

test('redeem signature recovers float public key using the normative JSON plus salt hash', async t => {
  const f = await fixture(t); await f.tick(); const p = f.row.payload;
  const digest = createHash('sha256').update(JSON.stringify(p.redeem) + p.salt).digest();
  assert.equal(hex(digest), p.hash);
  const compact = unhex(BigInt(p.sig.r).toString(16).padStart(64, '0') + BigInt(p.sig.s).toString(16).padStart(64, '0'));
  assert.equal(secp256k1.verify(compact, digest, unhex(f.float.publicKey)), true);
  const recovered = secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(p.sig.v)).recoverPublicKey(digest).toHex(true);
  assert.equal(recovered, f.float.publicKey); assert.notEqual(recovered, f.key.publicKey);
  assert.equal(secp256k1.verify(compact, createHash('sha256').update(JSON.stringify({ ...p.redeem, data: 'changed' }) + p.salt).digest(), unhex(f.float.publicKey)), false);
  const again = refundRedeem(f.record, p.redeem.auth, f.float.privateKey, 'regtest', f.settings);
  assert.deepEqual(again.payload, p); assert.ok(Object.hasOwn(p.redeem, 'data'));
});

test('authority creation is explicit, uses only float BTC, journals before broadcast, and replays exactly', async t => {
  const f = await fixture(t); f.sender.journal.meta('refundAuthority', null);
  const floatCoin = { ...f.coins[0], txid: '66'.repeat(32), value: '30000', script: hex(btc.p2tr(unhex(f.float.publicKey).slice(1)).script) };
  f.bitcoin.utxos = async address => { assert.equal(address, f.float.address); return [floatCoin]; };
  f.fail(1); await assert.rejects(f.sender.refunds.createAuthority());
  const authority = f.sender.journal.meta('refundAuthority'); assert.ok(authority.plan); assert.deepEqual(authority.payload.auth, ['tap']);
  await f.restart(); const first = await f.sender.refunds.createAuthority(); assert.equal(f.sent[0].raw, f.sent[1].raw);
  assert.equal(first.activation, 'waiting_reveal_confirmation'); assert.ok(!f.sent.some(r => r.txid === authority.tapPlan.txid));
  f.transactions.set(authority.plan.revealTxid, { confirmed: true, height: 100 });
  await f.sender.refunds.createAuthority();
  assert.equal(f.sent.at(-2).raw, authority.plan.revealHex); assert.equal(f.sent.at(-1).raw, authority.tapPlan.hex);
  const tap = btc.Transaction.fromRaw(unhex(authority.tapPlan.hex));
  assert.equal(hex(tap.getInput(0).txid), authority.plan.revealTxid); assert.equal(tap.getInput(0).index, 0);
  assert.equal(hex(tap.getInput(1).txid), authority.plan.commitTxid); assert.equal(tap.getInput(1).index, 1);
  assert.equal(tap.outputsLength, 1); assert.ok(tap.getOutput(0).amount >= 546n);
  assert.equal(hex(btc.Transaction.fromRaw(unhex(authority.plan.commitHex)).getInput(0).txid), floatCoin.txid);
});

for (const reason of ['claimed_first', 'public_payment_incomplete', 'already_minted']) test(reason + ' refunds exactly the accepted amount automatically', async t => {
  const f = await fixture(t); f.record.reason = reason; await f.tick();
  assert.equal(f.row.state, 'refund_sent'); assert.equal(f.row.payload.redeem.items[0].amt, '1.5');
});

test('winning public sender uses the accepted winning funding reference and returns its reserve as commit change', async t => {
  const f = await fixture(t, { withMint: true }); f.records.length = 0;
  Object.assign(f.status, { state: 'permit_issued', winner: { id: f.id }, fundingReference: '88'.repeat(32) + 'i0', refunds: [], fees: [], missing: [], amount: '1',
    mintContent: { p: 'tap', op: 'token-mint', tick: 'dmwtest', amt: '1', dta: f.id, prv: { address: f.payer.address } } });
  f.bitcoin.paymentFunding = async (address, reference) => { assert.equal(address, f.key.address); assert.equal(reference, f.status.fundingReference); return f.coins; };
  let inscription; f.gateway.report = async (id, value) => { assert.equal(id, f.id); inscription = value; };
  await f.tick(); const row = f.sender.journal.get(f.id);
  assert.equal(row.state, 'sent'); assert.equal(inscription, row.plan.inscriptionId);
  assert.ok(btc.Transaction.fromRaw(unhex(row.plan.commitHex)).getOutput(1).amount >= BigInt(f.settings.refundReserveSats));
  assert.equal(f.sent.length, 2);
});

test('source rollback behind an already confirmed refund cannot overestimate the float for its next debit', async t => {
  const f = await fixture(t); await f.tick(); f.confirmed.add(f.record.refundId); await f.tick();
  const next = { ...f.record, reference: '55'.repeat(32) + 'i0' }; next.refundId = publicRefundKey(next).split('/').at(-1); f.records.push(next);
  f.coins.push({ ...f.coins[0], txid: '66'.repeat(32) });
  await f.tick(); const row = f.sender.journal.refund(next.refundId);
  assert.equal(row.plan, undefined); assert.ok(f.logs.some(r => r.code === 'mint_refund_tap_behind'));
});

test('flat-fee refund float sends the original full paid amount without repricing', async t => {
  const f = await fixture(t);
  const flat = JSON.parse(await readFile(new URL('./fixtures/flat-fees.json', import.meta.url)));
  const amount = BigInt(flat.changes.baseFee), burn = amount * 35n / 100n;
  f.record.fees = [{ ticker: 'tap', role: 'treasury', amount: String(amount - burn) }, { ticker: 'tap', role: 'burn', amount: String(burn) }];
  await f.tick();
  assert.equal(f.row.state, 'refund_sent');
  assert.equal(f.row.amounts.tap, flat.changes.baseFee);
  assert.equal(f.row.payload.redeem.items[0].amt, flat.baseFeeTap);
  const saved = structuredClone(f.row.plan);
  await f.restart(); await f.tick();
  assert.deepEqual(f.row.plan, saved);
});

test('refund sender retains a bound reserve across restart and ignores later reserve policy', async t => {
  const f = await fixture(t, { withMint: true });
  f.record.refundReserveSats = 1500; f.status.refundReserveSats = 1500; f.fee(5);
  await f.tick(); assert.equal(f.row.state, 'refund_pending'); assert.equal(f.row.plan, undefined);
  assert.equal(f.sender.journal.get(f.id).refundReserveSats, 1500);
  await f.restart({ refundReserveSats: 9000, refundReserveMinSats: 9000, refundReserveMaxSats: 9000 });
  await f.tick(); assert.equal(f.row.state, 'refund_pending'); assert.equal(f.sent.length, 0);
  f.fee(2); await f.tick(); assert.equal(f.row.state, 'refund_sent');
  assert.ok(Number(f.row.plan.feeSats) <= 1500);
  assert.throws(() => f.sender.journal.save({ ...f.sender.journal.get(f.id), refundReserveSats: 9000 }), /refund_binding/);
});

test('bound refund budget remains usable when today\'s fallback and generic fee limit are smaller', async t => {
  const f = await fixture(t); f.record.refundReserveSats = 6000;
  await f.restart({ refundReserveSats: 1500, maxFeeSats: 1500 }); f.fee(5);
  await f.tick(); assert.equal(f.row.state, 'refund_sent'); assert.ok(Number(f.row.plan.feeSats) > 1500);
  assert.ok(Number(f.row.plan.feeSats) <= 6000);
});

test('old unbound refunds keep the current fallback and generic fee cap', async t => {
  const f = await fixture(t); f.fee(5);
  await f.restart({ refundReserveSats: 1500 }); await f.tick();
  assert.equal(f.row.state, 'refund_pending'); assert.equal(f.sent.length, 0);
  await f.restart({ refundReserveSats: 6000, maxFeeSats: 1500 }); await f.tick();
  assert.equal(f.row.state, 'refund_pending'); assert.equal(f.sent.length, 0);
  await f.restart({ refundReserveSats: 6000, maxFeeSats: f.settings.maxFeeSats }); await f.tick();
  assert.equal(f.row.state, 'refund_sent'); assert.equal(f.row.record.refundReserveSats, undefined);
});

test('zero bound reserve never authorizes refund fees after refunds are enabled', async t => {
  const f = await fixture(t); f.record.refundReserveSats = 0;
  await f.tick(); assert.equal(f.row.state, 'refund_pending'); assert.equal(f.sent.length, 0);
  assert.equal(f.row.failures, 0);
});

test('minter health publishes fee observation and a failed refresh never renews its timestamp', async t => {
  const f = await fixture(t, { funded: false }); f.fee(3);
  await f.tick();
  const path = join(f.directory, 'health.json'), before = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(before.feeRate, 3); assert.equal(before.feeRateAt, before.at);
  f.bitcoin.feeRate = async () => { throw Error('private source failure'); };
  await f.tick();
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(after.feeRate, 3); assert.equal(after.feeRateAt, before.feeRateAt); assert.ok(after.at > before.at);
  assert.ok(f.logs.some(r => r.event === 'mint_sender_fee_retry'));
  assert.ok(!JSON.stringify(f.logs).includes('private source failure'));
});
