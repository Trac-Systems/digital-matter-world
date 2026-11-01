import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rules } from '../src/rules.mjs';
import { Store } from '../src/store.mjs';
import { FeeQuotes, createFeePolicy } from '../src/fees.mjs';
import { tickerDeployQuote, verifyTickerDeployPayment, TickerPayments } from '../src/ticker-payments.mjs';
import { reserveTicker } from '../src/ticker-availability.mjs';
import { refundAmounts } from '../src/mint-refund-protocol.mjs';
import { testPayoutAddress } from './payout-wallets.mjs';
import { gatewaySecret } from '../../rules/test/observation-fixture.mjs';

async function fixture(t, values = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ticker-payments-')), store = await Store.open(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true }); });
  const network = 'dmw-regtest', bitcoinNetwork = 'regtest', payer = testPayoutAddress('31'.repeat(32), 'tap'), treasury = testPayoutAddress('32'.repeat(32), 'tap');
  const registry = { feePolicy: createFeePolicy('100'), link: { treasury } };
  const document = rules.settingsRevision({ network, effectiveBatch: '0', effectiveBitcoinWindow: '0', values: { ...rules.SETTINGS_PROFILE,
    feePolicyRevision: registry.feePolicy.current, linkMultiplier: rules.FEE_DEFAULTS.link, tickerDeployMultiplier: 3, tickerDeployBurnBps: 2500, ...values } });
  const at = { counted: rules.MULTI_TICKER_HEIGHT, executionHeight: rules.MULTI_TICKER_HEIGHT, tip: rules.MULTI_TICKER_HEIGHT, tipHash: rules.hash('tip') };
  const contents = new Map(), transfers = new Map(), refunds = new Map(), occupied = new Map(), official = new Set();
  const reads = { registry: async () => registry, financialSettings: async hash => { assert.equal(hash, rules.hashObject(document)); return document; },
    withTapSnapshot: async (view, read) => { assert.equal(view, at); return read(); },
    tap: async path => { assert.ok(path.startsWith('getDeployment/')); return occupied.get(decodeURIComponent(path.slice('getDeployment/'.length))) ?? null; },
    included: async id => contents.has(id) ? { height: at.counted, confirmations: 2 } : null,
    content: async id => contents.get(id), paymentTransfers: async id => transfers.get(id) ?? [],
    discoverPaymentIds: () => { throw Error('history_forbidden'); } };
  reads.feeQuotes = new FeeQuotes({ network, secret: gatewaySecret, registry: reads.registry, settings: async () => document,
    settingsHistory: { get: reads.financialSettings }, now: () => 1000 });
  const options = { store, reads, network, bitcoinNetwork, officialName: async name => official.has(name), refund: async record => {
    assert.equal(record.tapAddress, payer); refundAmounts(record, bitcoinNetwork, { refundTickers: ['tap'] });
    if (refunds.has(record.refundId)) assert.deepEqual(record, refunds.get(record.refundId));
    refunds.set(record.refundId, structuredClone(record));
  } };
  const payments = new TickerPayments(options);
  async function request(suffix = 'spare', extra = {}) {
    const input = { id: rules.hash(suffix), asset: 'p2:0', tick: 'dmt-' + suffix, payer, until: String(BigInt(at.counted) + 100n), ...extra };
    const quote = await tickerDeployQuote(reads, input, at, options);
    input.feeQuote = quote.feeQuote;
    return { input, quote, view: await payments.request(input, at) };
  }
  function pay(id, label = 'paid', amounts) {
    const row = store.get('tickerPayments', id), reference = rules.hash(label) + 'i0';
    const fees = row.quote.fees.map((f, i) => ({ ...f, amount: amounts?.[i] ?? f.amount }));
    contents.set(reference, { p: 'tap', op: 'token-auth', redeem: { items: rules.walletFeeItems(fees, bitcoinNetwork) } });
    transfers.set(reference, fees.map((f, index) => ({ index, value: { ins: reference, fail: false, int: true,
      addr: payer, taddr: f.to, tick: f.ticker, dta: f.dta, amt: f.amount } })));
    return reference;
  }
  return { directory, store, network, bitcoinNetwork, payer, treasury, reads, options, payments, document, at, request, pay, refunds, occupied, official, transfers };
}

test('ticker payment quote, wallet items, confirmation and completion use the signed operator fee', async t => {
  const f = await fixture(t), { input, view } = await f.request();
  assert.equal(view.price, '300'); assert.equal(view.split.burn, '75'); assert.equal(view.split.treasury, '225');
  assert.equal(view.state, 'awaiting_payment'); assert.equal(view.redeem.items.length, 2);
  assert.deepEqual(await f.payments.request(input, f.at), view);
  await assert.rejects(f.payments.request({ ...input, payer: f.treasury }, f.at), /ticker_request_conflict/);
  await assert.rejects(f.payments.complete(input.id, {}), /ticker_unpaid/);
  const reference = f.pay(input.id);
  assert.equal((await f.payments.payment({ id: input.id, paymentIds: [reference] }, f.at)).state, 'paid');
  const row = f.store.get('tickerPayments', input.id);
  assert.equal((await verifyTickerDeployPayment(f.reads, row, f.at, f.options)).final, true);
  const registration = { asset: input.asset, kind: 'dmt', tick: 'spare', id: rules.hash('registered') + 'i0' };
  assert.equal((await f.payments.complete(input.id, registration)).state, 'completed');
  assert.equal((await f.payments.complete(input.id, registration)).state, 'completed');
  await assert.rejects(f.payments.refuse(input.id, 'ticker_taken', f.at), /ticker_payment_terminal/);
});

test('a confirmed ticker fee counts when the inclusion read reports decimal-string confirmations (mainnet heights)', async t => {
  const f = await fixture(t), { input } = await f.request();
  const included = f.reads.included;
  f.reads.included = async (...args) => { const r = await included(...args); return r && { ...r, height: String(r.height), confirmations: String(r.confirmations) }; };
  const reference = f.pay(input.id);
  assert.equal((await f.payments.payment({ id: input.id, paymentIds: [reference] }, f.at)).state, 'paid');
  const verified = await verifyTickerDeployPayment(f.reads, f.store.get('tickerPayments', input.id), f.at, f.options);
  assert.equal(verified.final, true);
  assert.ok(verified.receipts.every(r => r.confirmations === 2));
});

test('deploy fee admission is gated by execution height and rejects occupied or official names before payment', async t => {
  const f = await fixture(t);
  const before = { ...f.at, executionHeight: String(BigInt(rules.MULTI_TICKER_HEIGHT) - 1n) };
  await assert.rejects(tickerDeployQuote(f.reads, { asset: 'p2:0', tick: 'dmt-spare', payer: f.payer }, before, f.options), /ticker_inactive/);
  await assert.rejects(f.payments.request({ id: rules.hash('early'), asset: 'p2:0', tick: 'dmt-spare', payer: f.payer, until: f.at.counted }, before), /ticker_inactive/);
  f.occupied.set('dmt-taken', { tick: 'dmt-taken', ins: 'deployed' });
  await assert.rejects(f.request('taken'), /ticker_taken/);
  f.official.add('official'); await assert.rejects(f.request('official'), /ticker_conflict/);
  await f.request();
  await assert.rejects(f.request('spare', { id: rules.hash('competitor') }), /ticker_reserved/);
  const row = f.store.get('tickerPayments', rules.hash('spare'));
  await assert.rejects(verifyTickerDeployPayment(f.reads, { ...row, quote: { ...row.quote, price: '1' } }, f.at, f.options), /ticker_payment_quote/);
  await assert.rejects(verifyTickerDeployPayment(f.reads, { ...row, tick: 'dmt-forged' }, f.at, f.options), /fee_quote_policy/);
});

test('zero deploy fee needs no wallet payment and still requires registration binding', async t => {
  const f = await fixture(t, { tickerDeployMultiplier: 0 }), { input, view } = await f.request();
  assert.equal(view.state, 'paid'); assert.equal(view.price, '0'); assert.deepEqual(view.redeem.items, []);
  assert.equal((await verifyTickerDeployPayment(f.reads, f.store.get('tickerPayments', input.id), f.at, f.options)).final, true);
  await assert.rejects(f.payments.complete(input.id, { asset: input.asset, kind: 'dmt', tick: 'wrong', id: rules.hash('deploy') + 'i0' }), /ticker_registration/);
});

test('verified refusal persists refunds through adapter failure, restart and idempotent replay', async t => {
  const f = await fixture(t), { input } = await f.request(), reference = f.pay(input.id);
  await f.payments.payment({ id: input.id, paymentIds: [reference] }, f.at);
  f.payments.refund = async () => { throw Error('ledger_unavailable'); };
  await assert.rejects(f.payments.refuse(input.id, 'ticker_taken', f.at), /ledger_unavailable/);
  assert.equal(f.store.get('tickerPayments', input.id).state, 'recovery');
  await assert.rejects(reserveTicker(f.store, input.tick, 'other'), /ticker_reserved/);
  const resumed = new TickerPayments(f.options), result = await resumed.refuse(input.id, 'ticker_taken', f.at);
  assert.equal(result.state, 'refund_pending'); assert.equal(f.refunds.size, 1);
  const record = [...f.refunds.values()][0];
  assert.deepEqual(refundAmounts(record, 'regtest', { refundTickers: ['tap'] }), { tap: '300' });
  await resumed.refuse(input.id, 'ticker_taken', f.at); assert.equal(f.refunds.size, 1);
  await reserveTicker(f.store, input.tick, 'other');
  await assert.rejects(resumed.complete(input.id, {}), /ticker_unpaid/);
});

test('partial payment pages have no lifetime cap and expired unpaid requests recover late money', async t => {
  const f = await fixture(t, { paymentPage: 2, tickerDeployBurnBps: 0 }), { input } = await f.request();
  for (let i = 0; i < 4; i++) {
    const reference = f.pay(input.id, 'part-' + i, ['10']);
    assert.equal((await f.payments.payment({ id: input.id, paymentIds: [reference] }, f.at)).state, 'partly_paid');
  }
  assert.equal(f.store.get('tickerPayments', input.id).paymentReferences.length, 4);
  f.at.counted = String(BigInt(input.until) + 1n);
  assert.equal((await f.payments.expire(input.id, f.at)).state, 'refund_pending');
  assert.equal(f.refunds.size, 4);
  const late = f.pay(input.id, 'late', ['260']);
  assert.equal((await f.payments.payment({ id: input.id, paymentIds: [late] }, f.at)).state, 'refund_pending');
  assert.equal(f.refunds.size, 5);
});

test('snapshot changes, wrong payer, wrong request binding and failed transfers cannot satisfy the fee', async t => {
  const f = await fixture(t), { input } = await f.request(), reference = f.pay(input.id);
  const rows = structuredClone(f.transfers.get(reference));
  for (const mutation of [v => v.addr = f.treasury, v => v.dta = 'other-request', v => v.fail = true, v => v.tick = 'other']) {
    const altered = structuredClone(rows); altered.forEach(r => mutation(r.value)); f.transfers.set(reference, altered);
    assert.equal((await f.payments.payment({ id: input.id, paymentIds: [reference] }, f.at)).state, 'awaiting_payment');
  }
  f.transfers.set(reference, rows);
  f.reads.withTapSnapshot = async (at, read) => { await read(); throw Error('tap_snapshot_changed'); };
  await assert.rejects(f.payments.payment({ id: input.id, paymentIds: [reference] }, f.at), /tap_snapshot_changed/);
  assert.equal(f.store.get('tickerPayments', input.id).state, 'awaiting_payment');
});

test('fee transfers cannot be replayed into a different ticker even if its caller reuses the request ID', async t => {
  const f = await fixture(t), { input } = await f.request(), reference = f.pay(input.id);
  const original = f.store.get('tickerPayments', input.id);
  const changed = { ...original, tick: 'dmt-another', paymentReferences: [reference] };
  changed.quote = await tickerDeployQuote(f.reads, changed, f.at, f.options);
  changed.feeAuthorization = await f.reads.feeQuotes.accept(changed.quote.feeQuote, changed.quote.feeQuote.scope, changed.id, changed.until, f.at.counted);
  assert.equal((await verifyTickerDeployPayment(f.reads, changed, f.at, f.options)).final, false);
  assert.notEqual(original.quote.fees[0].dta, changed.quote.fees[0].dta);
  for (const { value } of f.transfers.get(reference)) value.dta = `dmw-pay-v2|${input.id}|treasury`;
  assert.equal((await verifyTickerDeployPayment(f.reads, { ...original, paymentReferences: [reference] }, f.at, f.options)).final, false);
});

test('one fragmented payment refunds its exact total without exceeding the existing sender item envelope', async t => {
  const { tickerPaymentRefunds } = await import('../src/ticker-payments.mjs');
  const f = await fixture(t, { tickerDeployBurnBps: 0 }), { input } = await f.request();
  const row = f.store.get('tickerPayments', input.id), reference = rules.hash('fragmented') + 'i0';
  const receipts = Array.from({ length: 101 }, (_, index) => ({ ...row.quote.fees[0], key: rules.hash('receipt-' + index), reference,
    amount: '3', accepted: true, confirmations: 1, origin: row.id }));
  const [record] = tickerPaymentRefunds(row, { requestId: row.id, receipts }, 'ticker_taken');
  assert.equal(record.fees.length, 1); assert.equal(record.fees[0].amount, '303');
  assert.deepEqual(refundAmounts(record, 'regtest', { refundTickers: ['tap'] }), { tap: '303' });
  assert.throws(() => tickerPaymentRefunds(row, { requestId: row.id, receipts: [receipts[0], receipts[0]] }, 'ticker_taken'), /ticker_refund_receipt/);
});

test('paid requests survive treasury rotation and their deadline without losing registration or refund recovery', async t => {
  const f = await fixture(t), { input } = await f.request(), reference = f.pay(input.id);
  await f.payments.payment({ id: input.id, paymentIds: [reference] }, f.at);
  const registry = await f.reads.registry(); registry.link.treasury = f.payer;
  f.at.counted = String(BigInt(input.until) + 100000n);
  assert.equal((await f.payments.expire(input.id, f.at)).state, 'paid');
  await assert.rejects(reserveTicker(f.store, input.tick, 'competitor'), /ticker_reserved/);
  const { feeQuote, ...repeat } = input;
  assert.equal((await f.payments.request(repeat, f.at)).state, 'paid');
  const retained = f.store.get('tickerPayments', input.id);
  assert.equal(retained.quote.destinations.treasury, f.treasury);
  assert.equal((await verifyTickerDeployPayment(f.reads, retained, f.at, f.options)).final, true);
  assert.equal((await f.payments.refuse(input.id, 'ticker_taken', f.at)).state, 'refund_pending');
  assert.deepEqual(refundAmounts([...f.refunds.values()][0], 'regtest', { refundTickers: ['tap'] }), { tap: '300' });
});
