import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { MintSender } from '../src/mint-sender.mjs';
import { MintSenderJournal } from '../src/mint-sender-journal.mjs';
import { MintSenderView, senderKeyId } from '../src/mint-sender-view.mjs';
import { MintRefundTap } from '../src/mint-refund-source.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { payoutFloatKey, refundFloatKey, requestKey, btc } from '../src/mint-sender-keys.mjs';
import { Store } from '../src/store.mjs';
import { Payouts } from '../src/payouts.mjs';
import { hash } from '../src/util.mjs';
import { hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
const require = createRequire(new URL('../../kit/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
const atoms = n => String(BigInt(n) * 10n ** 18n);

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'payout-sender-')), seed = new Uint8Array(32).fill(51), network = 'regtest';
  let settings = mintSenderSettings({ enabled: true, payoutsEnabled: true, directory: join(directory, 'minter'), seedFile: join(directory, 'seed'), bitcoinApiUrlFile: join(directory, 'source'),
    fundingPollMs: 20, terminalPollMs: 40, pollMs: 10, retryMs: 10, healthMs: 50, ...overrides });
  const key = payoutFloatKey(seed, network), recipient = requestKey(seed, hash('recipient'), network), keyId = senderKeyId(seed, network);
  const store = await Store.open(join(directory, 'gateway')), ledger = new Payouts({ store, files: { json: async () => {} } });
  let now = 1000000000, sender, balance = atoms(1000), feeRate = 2, snapshotHeight = 100, failBroadcast = 0, tapFails = false, loseRecord = false;
  const sent = [], logs = [], recorded = [], confirmed = new Set(), transactions = new Map();
  const coins = [{ txid: hash('coin'), vout: 0, value: '50000', script: hex(btc.p2tr(unhex(key.publicKey).slice(1)).script), confirmed: true, cardinal: true }];
  const gateway = {
    async list() { return { keyId, rows: [], next: null }; },
    async payouts(after, limit) { return { keyId, ...ledger.page({ after, limit }, network) }; },
    async preparePayout(record) { return { keyId, record: await ledger.reserve(record, network) }; },
    async recordPayout(record) {
      recorded.push(record); await ledger.record(record, { automatic: true });
      if (loseRecord) { loseRecord = false; throw Error('lost response'); }
      return { keyId, recorded: true };
    }
  };
  const bitcoin = {
    async verifyNetwork() {},
    async utxos(address) { assert.equal(address, key.address); return structuredClone(coins); },
    async feeRate() { return feeRate; },
    async transaction(txid) { return transactions.get(txid) ?? null; },
    async broadcast(raw, txid) {
      assert.equal(btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true }).id, txid);
      const pending = sender.payouts.payments.pending(), authority = sender.journal.meta('payoutAuthority');
      assert.ok(pending?.plan || authority?.plan.commitHex, 'intent is durable before any broadcast');
      sent.push({ raw, txid }); transactions.set(txid, { confirmed: false });
      if (failBroadcast && sent.length === failBroadcast) throw Error('lost broadcast reply');
    },
    tap: {
      async float(address, authority) {
        if (tapFails) throw Error('TAP unavailable'); assert.equal(address, key.address);
        return { value: { address, balances: { tap: balance }, authority: { state: authority ? 'active' : 'not_created' } }, snapshot: { height: String(snapshotHeight), blockHash: hash('block') } };
      },
      async cardinal(coins) { return coins; },
      async confirmed(row, address) {
        assert.equal(address, key.address); if (tapFails) throw Error('TAP unavailable');
        return confirmed.has(row.id) ? { txid: row.plan.revealTxid, inscriptionId: row.plan.inscriptionId, height: 101 } : null;
      }
    }
  };
  const open = () => {
    const journal = new MintSenderJournal(settings.directory, { keyId, network, now: () => now });
    sender = new MintSender({ seed: seed.slice(), network, settings, journal, gateway, bitcoin, now: () => now, log: row => logs.push(row) });
  };
  open();
  sender.journal.meta('payoutAuthority', { payload: { auth: ['tap'] }, plan: { inscriptionId: hash('authority') + 'i0', revealTxid: hash('authority') } });
  await store.put('meta', 'ruleState', { batchVersion: 2 });
  await store.put('payoutTotals', hash(recipient.address), { beneficiary: recipient.address, accrued: atoms(2), paid: '0' });
  t.after(async () => { try { await sender.close(); await store.close(); } finally { seed.fill(0); key.privateKey.fill(0); recipient.privateKey.fill(0); await rm(directory, { recursive: true, force: true }); } });
  return { directory, seed, key, recipient, keyId, gateway, bitcoin, store, ledger, sent, logs, recorded, coins, confirmed, transactions,
    get sender() { return sender; }, get pending() { return sender.payouts.payments.pending(); }, get settings() { return settings; },
    tick: async () => { now += 60; await sender.tick(); await sender.drain(); },
    fail: n => { failBroadcast = n; }, balance: n => { balance = n; }, fee: n => { feeRate = n; }, tapFails: n => { tapFails = n; },
    loseRecord: () => { loseRecord = true; }, advance: ms => { now += ms; }, snapshot: height => { snapshotHeight = height; },
    async restart(overrides = {}) { await sender.close(); settings = mintSenderSettings({ ...settings, ...overrides }); open(); },
    async owed(amount, beneficiary = recipient.address) { const old = store.get('payoutTotals', hash(beneficiary)); await store.put('payoutTotals', hash(beneficiary), { beneficiary, paid: old?.paid ?? '0', accrued: String(BigInt(old?.paid ?? '0') + BigInt(amount)) }); },
    async settle() { const row = sender.payouts.payments.pending(); confirmed.add(row.id); snapshotHeight = 101; coins[0] = { ...coins[0], txid: hash('change/' + row.id) }; await this.tick(); return row; },
    view: () => new MintSenderView({ seed: seed.slice(), settings, network, now: () => now })
  };
}

test('automatic payouts are disabled by default and settings require exact positive atom strings', async t => {
  assert.equal(mintSenderSettings().payoutsEnabled, false);
  assert.equal(mintSenderSettings().payoutDailyCapAtoms, atoms(100)); assert.equal(mintSenderSettings().payoutMaxAtoms, atoms(50));
  for (const value of [0, '0', '-1', '01', '1.5', 1e20, '1'.repeat(79)])
    for (const field of ['payoutDailyCapAtoms', 'payoutMaxAtoms']) assert.throws(() => mintSenderSettings({ [field]: value }), /mint_sender_setting/);
  assert.throws(() => mintSenderSettings({ payoutsEnabled: 'true' }), /payouts_enabled/);
  const f = await fixture(t, { payoutsEnabled: false }); await f.tick();
  assert.equal(f.pending, null); assert.equal(f.sent.length, 0); assert.equal(f.store.countUint('payoutReserved'), '0');
});

test('payout polling does not occupy a mint concurrency slot while its next attempt is not due', async t => {
  const f = await fixture(t, { payoutsEnabled: false, concurrency: 1, fundingPollMs: 1000 });
  const id = hash('waiting-mint'); let processed = 0;
  f.sender.journal.save({ id, payer: f.recipient.address, receiver: f.recipient.address, address: f.recipient.address, state: 'funded' });
  f.sender.process = async () => { processed++; };
  await f.tick(); await f.tick();
  assert.equal(processed, 1); assert.equal(f.sent.length, 0);
});

test('payout float uses its own deterministic branch and signs exactly one TAP transfer to the beneficiary', async t => {
  const f = await fixture(t); await f.tick(); const row = f.pending;
  assert.equal(row.state, 'broadcast'); assert.equal(f.sent.length, 2);
  assert.equal(f.key.path, "m/86'/1'/0'/3/0");
  const refund = refundFloatKey(f.seed, 'regtest'), mainnet = payoutFloatKey(f.seed, 'mainnet');
  assert.notEqual(refund.address, f.key.address); assert.notEqual(mainnet.address, f.key.address); assert.notEqual(f.recipient.address, f.key.address);
  refund.privateKey.fill(0); mainnet.privateKey.fill(0);
  assert.deepEqual(row.payload.redeem.items, [{ tick: 'tap', amt: '2', address: f.recipient.address, dta: 'dmw-payout-v1|' + row.record.reference }]);
  const digest = hash(JSON.stringify(row.payload.redeem) + row.payload.salt), sig = row.payload.sig;
  const compact = unhex(BigInt(sig.r).toString(16).padStart(64, '0') + BigInt(sig.s).toString(16).padStart(64, '0'));
  assert.equal(digest, row.payload.hash); assert.ok(secp256k1.verify(compact, unhex(digest), unhex(f.key.publicKey)));
  const commit = btc.Transaction.fromRaw(unhex(row.plan.commitHex)), reveal = btc.Transaction.fromRaw(unhex(row.plan.revealHex), { allowUnknownInputs: true });
  assert.equal(hex(commit.getInput(0).txid), f.coins[0].txid);
  const script = hex(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(f.key.address)));
  assert.equal(hex(commit.getOutput(1).script), script);
  assert.equal(hex(reveal.getOutput(0).script), hex(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(f.recipient.address))));
  assert.equal(f.store.get('payoutTotals', hash(f.recipient.address)).paid, '0');
  await f.settle();
  const paid = f.store.list('payoutPaid')[0].value;
  assert.equal(paid.txid, row.plan.revealTxid); assert.equal(paid.evidence, 'automatic_payout_transaction'); assert.equal(paid.amount, atoms(2));
});

for (const failAt of [1, 2]) test('lost broadcast reply ' + failAt + ' resumes identical transactions after restart, including while disabled', async t => {
  const f = await fixture(t); f.fail(failAt); await f.tick();
  const row = f.pending, plan = structuredClone(row.plan); assert.equal(row.state, 'prepared');
  await f.restart({ payoutsEnabled: false }); await f.tick();
  assert.deepEqual(f.pending.plan, plan); assert.equal(f.pending.state, 'broadcast');
  assert.deepEqual(f.sent.slice(-2).map(r => r.raw), [plan.commitHex, plan.revealHex]);
  assert.equal(new Set(f.sent.map(r => r.txid)).size, 2);
  await f.settle(); await f.tick();
  assert.equal(f.store.countUint('payoutPaid'), '1'); assert.equal(f.store.get('payoutTotals', hash(f.recipient.address)).paid, atoms(2));
});

test('lost gateway record reply retries the same reference and evidence without another broadcast', async t => {
  const f = await fixture(t); await f.tick(); f.loseRecord(); await f.settle();
  assert.equal(f.pending.state, 'confirmed'); const before = f.sent.length;
  await f.restart(); await f.tick(); assert.equal(f.pending, null);
  assert.equal(f.sent.length, before); assert.equal(f.recorded.length, 2); assert.deepEqual(f.recorded[0], f.recorded[1]);
  assert.equal(f.store.countUint('payoutPaid'), '1'); assert.equal(f.sender.payouts.status().paid24hAtoms, atoms(2));
});

test('lost gateway prepare reply resumes its reservation and never broadcasts an unjournaled transfer', async t => {
  const f = await fixture(t), prepare = f.gateway.preparePayout; let lose = true;
  f.gateway.preparePayout = async record => { const result = await prepare(record); if (lose) { lose = false; throw Error('lost prepare'); } return result; };
  await f.tick(); assert.equal(f.sent.length, 0); assert.equal(f.pending, null);
  const reservation = f.store.list('payoutReserved')[0].value;
  await f.restart(); await f.tick(); assert.deepEqual(f.pending.record, reservation);
  await f.settle(); assert.equal(f.store.countUint('payoutPaid'), '1');
});

test('rolling daily cap and single-payout maximum wait visibly without splitting; cap persists across restart', async t => {
  const f = await fixture(t, { payoutDailyCapAtoms: atoms(3), payoutMaxAtoms: atoms(2) });
  await f.owed(atoms(3)); await f.tick();
  assert.equal(f.sender.payouts.status().waiting.code, 'max'); assert.equal(f.sent.length, 0);
  await f.owed(atoms(2)); await f.tick(); await f.settle();
  await f.owed(atoms(2)); await f.restart(); await f.tick();
  assert.equal(f.sender.payouts.status().waiting.code, 'daily_cap'); assert.equal(f.pending, null);
  assert.equal(f.sender.payouts.status().paid24hAtoms, atoms(2));
  f.advance(86400000); await f.tick(); assert.equal(f.pending.record.amount, atoms(2));
});

test('unconfirmed payout stays reserved beyond 24 hours and blocks any second payout', async t => {
  const f = await fixture(t); await f.tick(); const first = f.pending.id;
  await f.owed(atoms(4)); f.advance(2 * 86400000); await f.tick();
  assert.equal(f.pending.id, first); assert.equal(f.pending.record.amount, atoms(2));
  assert.equal(f.sender.payouts.status().reservedAtoms, atoms(2)); assert.equal(new Set(f.sent.map(r => r.txid)).size, 2);
});

for (const reason of ['tap_funds', 'btc_funds', 'fee_rate', 'authority']) test('payout waits visibly for ' + reason + ' without signing or reserving', async t => {
  const f = await fixture(t);
  if (reason === 'tap_funds') f.balance('0');
  if (reason === 'btc_funds') f.coins.length = 0;
  if (reason === 'fee_rate') f.fee(11);
  if (reason === 'authority') f.sender.journal.meta('payoutAuthority', null);
  await f.tick(); assert.equal(f.sent.length, 0); assert.equal(f.pending, null); assert.equal(f.store.countUint('payoutReserved'), '0');
  assert.equal(f.sender.payouts.status().waiting.code, reason);
  assert.ok(f.logs.some(row => row.event === 'mint_payout_waiting' && row.code === reason));
});

test('Bitcoin fee budget shortage and a wrong-network destination are refused before any broadcast', async t => {
  const f = await fixture(t); f.coins[0].value = '546'; await f.tick();
  assert.equal(f.sender.payouts.status().waiting.code, 'btc_funds'); assert.equal(f.sent.length, 0);
  const wrong = payoutFloatKey(f.seed, 'mainnet');
  await f.sender.payouts.prepare({ beneficiary: wrong.address, amount: atoms(1), reference: 'automatic/' + hash('wrong') }); wrong.privateKey.fill(0);
  assert.equal(f.sender.payouts.status().waiting.code, 'destination'); assert.equal(f.sent.length, 0);
});

test('TAP outage replays only saved bytes and a rollback cannot authorize another float debit', async t => {
  const f = await fixture(t); await f.tick(); const plan = f.pending.plan;
  f.tapFails(true); await f.tick(); assert.deepEqual(f.sent.slice(-2).map(r => r.raw), [plan.commitHex, plan.revealHex]);
  f.tapFails(false); await f.settle(); await f.owed(atoms(1)); f.snapshot(100); await f.tick();
  assert.equal(f.pending, null); assert.ok(f.logs.some(row => row.code === 'mint_payout_tap_behind'));
});

test('payout authority has its own metadata and resumes the same three Bitcoin transactions', async t => {
  const f = await fixture(t); f.sender.journal.meta('payoutAuthority', null);
  const refundMarker = { untouched: true }; f.sender.journal.meta('refundAuthority', refundMarker);
  f.fail(1); await assert.rejects(f.sender.payouts.createAuthority());
  const authority = f.sender.journal.meta('payoutAuthority');
  assert.ok(authority.plan.commitHex); assert.deepEqual(authority.payload.auth, ['tap']);
  await f.restart(); const first = await f.sender.payouts.createAuthority();
  assert.equal(first.activation, 'waiting_reveal_confirmation'); assert.equal(f.sent[0].raw, f.sent[1].raw);
  f.transactions.set(authority.plan.revealTxid, { confirmed: true, height: 100 });
  // Keep confirmed status when an idempotent broadcast is retried.
  const broadcast = f.bitcoin.broadcast; f.bitcoin.broadcast = async (raw, txid) => { const old = f.transactions.get(txid); await broadcast(raw, txid); if (old?.confirmed) f.transactions.set(txid, old); };
  const second = await f.sender.payouts.createAuthority(); assert.equal(second.activation, 'sent');
  assert.equal(f.sent.at(-1).raw, authority.tapPlan.hex); assert.deepEqual(f.sender.journal.meta('refundAuthority'), refundMarker);
});

test('health and authenticated status expose payout wallet, TAP/BTC balance, rolling cap, queue and transaction', async t => {
  const f = await fixture(t); await f.tick(); f.sender.health(true);
  const health = JSON.parse(await readFile(join(f.settings.directory, 'health.json'), 'utf8'));
  assert.equal(health.payouts.float.address, f.key.address); assert.equal(health.payouts.float.btcSats, '50000');
  assert.equal(health.payouts.float.balances.tap, atoms(1000)); assert.equal(health.payouts.queuedCount, '1');
  assert.equal(health.payouts.dailyCapAtoms, atoms(100)); assert.equal(health.payouts.pending.txid, f.pending.plan.revealTxid);
  const view = f.view(); try { assert.deepEqual(view.status().payouts, health.payouts); } finally { view.close(); }
});

test('payout confirmation reader requires the exact successful TAP transfer, not merely a Bitcoin confirmation', async t => {
  const f = await fixture(t); await f.tick(); const row = f.pending, blockHash = hash('canonical'); let indexed = false, failed = false;
  const reader = new MintRefundTap({ settings: f.settings, bitcoin: { transaction: async () => ({ confirmed: true, height: 100 }), http: { request: async () => blockHash } },
    http: { request: async path => {
      if (path === '/r/tap/getCurrentBlock') return { result: '100' };
      if (path === '/r/blockhash/100') return blockHash;
      if (path === '/content/' + row.plan.inscriptionId) return JSON.stringify(row.payload);
      if (path.startsWith('/r/tap/getTransferredList/')) return { result: indexed ? [{ ins: row.plan.inscriptionId, tick: 'tap', addr: f.key.address, taddr: f.recipient.address,
        dta: row.payload.redeem.data, amt: row.record.amount, fail: failed, int: true, blck: '100' }] : [] };
      if (path.startsWith('/r/tap/getAccountRedeemListLength/')) return { result: 0 };
      assert.fail('unexpected path ' + path);
    } } });
  assert.equal(await reader.confirmed(row, f.key.address), null);
  indexed = true; failed = true; await assert.rejects(reader.confirmed(row, f.key.address), /transfer_binding/);
  failed = false; const evidence = await reader.confirmed(row, f.key.address); assert.equal(evidence.txid, row.plan.revealTxid);
});
