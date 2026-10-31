import test from 'node:test';
import { serve } from '../src/http.mjs';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { deploymentContent } from '../../kit/lib/inscription-core.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { readRegistry, migrateRegistry, updateRegistryAsset } from '../src/registry.mjs';
import { FeeQuotes, createFeePolicy } from '../src/fees.mjs';
import { installTickerPaymentSources } from '../src/ticker-payment-sources.mjs';
import { buildFinancialExecution } from '../src/financial-execution.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { publicMintAcceptedWrites } from '../src/public-mints.mjs';
import { bitcoinAddress } from '../../kit/test/helpers.mjs';
import { rules as r } from '../src/rules.mjs';
const address = bitcoinAddress('mainnet', 22);
async function setup(t, multiplier, compound = false) {
  const f = await provisioningFixture(t), transfers = new Map();
  f.reads.inscription = async () => ({ address }); f.reads.bindings.resolve = () => ({ request: { address } });
  f.reads.store = f.store;
  await f.store.put('patternsByAsset', 'p2:2', { ...f.pattern, number: '2', legacy: { asset: 'p2', record: f.pattern } });
  const asset = compound ? 'c1' : 'p2:2', definition = { id: 'c1', firstMaker: 'ab'.repeat(32), tier: 1 };
  if (compound) await f.store.put('types', asset, definition);
  const official = compound ? await f.complete(asset, definition) : await f.complete(); f.mine(Number(r.MULTI_TICKER_HEIGHT));
  const legacy = await f.reads.registry(); legacy.feePolicy = createFeePolicy('10000'); legacy.link = { treasury: bitcoinAddress('mainnet', 23) };
  await writeFile(f.registryPath, JSON.stringify(legacy)); await migrateRegistry(f.registryPath);
  f.reads.registry = () => readRegistry(f.registryPath);
  f.context.settings = r.settingsRevision({ network: f.network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: {
    ...r.SETTINGS_PROFILE, linkMultiplier: r.FEE_DEFAULTS.link, feePolicyRevision: legacy.feePolicy.current, tickerDeployMultiplier: multiplier, tickerDeployBurnBps: 5000 } });
  f.reads.officialName = async name => name === f.pattern.name;
  f.reads.batchStamp = async () => ({ counted: String(await f.reads.counted()), last: { n: '1' }, revision: '1' });
  f.reads.withTapSnapshot = async (_, fn) => fn();
  f.reads.financialSettings = async hash => { assert.equal(hash, r.hashObject(f.context.settings)); return f.context.settings; };
  f.reads.financialRecord = async key => f.store.get('accountRecords', key);
  f.reads.feeQuotes = new FeeQuotes({ network: f.network, secret: Buffer.alloc(32, 31), registry: f.reads.registry, settings: () => f.context.settings });
  f.reads.feeQuotes.document = f.context.settings;
  f.reads.paymentTransfers = async id => (transfers.get(id) ?? []).map((value, index) => ({ index, value }));
  installTickerPaymentSources(f.reads, { network: f.network });
  f.reads.financialEvidence = (t, at) => f.reads.tickerRefundEvidence(t.action, at);
  f.operator.financial = { submit: async transition => {
    const at = await f.reads.batchStamp(), document = f.context.settings;
    const result = await buildFinancialExecution({ store: f.store, transitions: [transition], reads: f.reads, document, height: at.counted, at });
    await verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads: f.reads, document, network: f.network, height: at.counted, at });
    await f.store.transact(result.writes);
    await f.store.transact(publicMintAcceptedWrites(f.store, result.inputs[0]));
  } };
  const pay = async job => {
    const id = r.hash('payment/' + job.id) + 'i0', fees = job.fee.fees;
    f.contents.set(id, { p: 'tap', op: 'token-auth', redeem: { items: r.walletFeeItems(fees) } });
    f.canonical.set(id, await f.reads.counted());
    transfers.set(id, fees.map(fee => ({ ins: id, fail: false, int: true, addr: address, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
    return f.operator.tickers.payment({ id: job.id, paymentIds: [id] });
  };
  return { ...f, asset, official, pay };
}
test('integrated zero and paid ticker fees gate inscription and independently verified registration', async t => {
  for (const multiplier of [0, 2]) await t.test(String(multiplier), async t => {
    const f = await setup(t, multiplier);
    let job = await f.operator.tickers.request('p2:2', { ticker: 'Chosen', receiver: address });
    if (multiplier) { assert.equal(job.state, 'awaiting_fee'); assert.equal(job.fee.price, '20000'); assert.equal(job.content, undefined); job = await f.pay(job); }
    assert.equal(job.state, 'awaiting_player_deploy');
    assert.equal(job.content.elem, f.official.entry.elementId); assert.equal(job.content.prv, f.official.entry.privilege);
    const inscription = f.index(job.content); f.mine();
    const registered = await f.operator.tickers.submit('p2:2', { requestId: job.id, inscription });
    if (multiplier) assert.equal(f.store.list('tickerFundingReturns', { limit: 10 }).length, 1);
    assert.equal(registered.state, 'registered'); assert.equal(f.store.get('tickerPayments', job.id).state, 'completed');
    await f.reads.tickerDeploymentFee(registered.entry);
    await assert.rejects(f.reads.tickerDeploymentFee({ ...registered.entry, indexTick: 'dmt-forged' }), /ticker_payment_binding/);
    assert.equal((await f.reads.registry()).assets.p2.id, f.official.entry.id);
  });
});
test('integrated paid collision creates accepted idempotent refunds and forbids registration after refund', async t => {
  const f = await setup(t, 2), requested = await f.operator.tickers.request('p2:2', { ticker: 'race', receiver: address });
  const job = await f.pay(requested), winner = r.hash('foreign-winner') + 'i0';
  f.deployments.set('dmt-race', { tick: 'dmt-race', ins: winner });
  const inscription = f.index(job.content);
  const refused = await f.operator.tickers.submit('p2:2', { requestId: job.id, inscription });
  assert.equal(refused.state, 'refused');
  assert.equal(f.store.get('tickerPayments', job.id).state, 'refund_pending');
  const refunds = f.store.list('publicMintRefunds', { limit: 10 });
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].value.fees.reduce((n, f) => n + BigInt(f.amount), 0n), 20000n);
  assert.ok(f.store.get('accountRecords', 'fp/ticker-refused/' + job.id));
  await assert.rejects(f.reads.tickerDeploymentFee({ ...job.entry, id: inscription }), /ticker_payment_binding/);
});

test('expired unpaid ticker reservation can restart without losing the old refund identity', async t => {
  const f = await setup(t, 2), first = await f.operator.tickers.request('p2:2', { ticker: 'retry', receiver: address });
  await assert.rejects(f.operator.tickers.request('p2:2', { ticker: 'retry', receiver: address, retry: true }), /ticker_retry_not_terminal/);
  f.mine(f.context.settings.values.pendingBlocks + 1);
  const expired = await f.operator.tickers.payment({ id: first.id, expire: true });
  assert.equal(expired.fee.state, 'refused');
  const next = await f.operator.tickers.request('p2:2', { ticker: 'retry', receiver: address, retry: true });
  assert.notEqual(next.id, first.id); assert.equal(next.state, 'awaiting_fee');
  assert.equal((await f.operator.tickers.request('p2:2', { ticker: 'retry', receiver: address })).id, next.id);
  const paid = await f.pay(next), inscription = f.index(paid.content); f.mine();
  assert.equal((await f.operator.tickers.submit('p2:2', { requestId: next.id, inscription })).state, 'registered');
  assert.equal(f.store.get('tickerPayments', first.id).state, 'refused');
});

test('compound chosen ticker preserves official token options and allows another deployer', async t => {
  const f = await setup(t, 2, true), receiver = bitcoinAddress('mainnet', 24);
  f.reads.inscription = async () => ({ address: receiver });
  // Its first maker binding still points at the original receiver.
  const job = await f.operator.tickers.request(f.asset, { ticker: '小币 🪙', receiver });
  assert.equal(job.state, 'awaiting_fee');
  const id = r.hash('compound-payment') + 'i0', fees = job.fee.fees;
  f.contents.set(id, { p: 'tap', op: 'token-auth', redeem: { items: r.walletFeeItems(fees) } }); f.canonical.set(id, await f.reads.counted());
  f.reads.paymentTransfers = async () => fees.map((fee, index) => ({ index, value: { ins: id, fail: false, int: true, addr: receiver, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta } }));
  const paid = await f.operator.tickers.payment({ id: job.id, paymentIds: [id] });
  assert.equal(paid.content.op, 'token-deploy'); assert.equal(paid.content.elem, undefined); assert.equal(paid.content.prv, f.official.entry.privilege);
  assert.equal(paid.content.max, f.official.entry.options.max);
  const { validateChosenTicker } = await import('../../rules/src/ticker-names.js');
  assert.equal(deploymentContent(r.publicIdentities(paid), { validateTicker: validateChosenTicker }).text, paid.inscriptionText);
  assert.throws(() => deploymentContent(r.publicIdentities(paid)), /Invalid mint authority or ticker/);
  const inscription = f.index(paid.content); f.mine();
  assert.equal((await f.operator.tickers.submit(f.asset, { requestId: job.id, inscription })).state, 'registered');
});

test('a paid ticker request retains its original parent through official generation rollover', async t => {
  const f = await setup(t, 2), job = await f.operator.tickers.request(f.asset, { ticker: 'retained', receiver: address });
  const successor = { ...f.official.entry, id: r.hash('rolled-official') + 'i0', tick: 'rolled', indexTick: 'dmt-rolled', generation: 2 };
  await updateRegistryAsset(f.registryPath, job.asset, () => successor);
  const paid = await f.pay(job);
  assert.equal(paid.officialDeployment, f.official.entry.id); assert.equal(paid.entry.officialDeployment, f.official.entry.id);
  assert.equal(paid.content.elem, successor.elementId); assert.equal(paid.content.prv, successor.privilege);
  const inscription = f.index(paid.content); f.mine();
  assert.equal((await f.operator.tickers.submit(f.asset, { requestId: paid.id, inscription })).state, 'registered');
  assert.equal((await f.reads.registry()).assets[job.asset].id, successor.id);
});

test('service ticker routes prepare, read, register and expose refund funding without changing the official route', async t => {
  const f = await setup(t, 2), refundAddress = bitcoinAddress('mainnet', 25);
  f.operator.mintSender = { settings: { refundsEnabled: true, refundReserveSats: 16000, maxRefundFeeRate: 12, pageSize: 20 }, ready: () => true,
    address: () => refundAddress, keyId: 'fixture-key', decorateRefund: r => r };
  const server = await serve({ intake: { store: f.store, settings: { document: f.context.settings } }, files: { serve: async () => false }, operator: { provisioner: f.operator } });
  t.after(() => server.close());
  const service = new ServiceClient({ origin: server.url });
  const before = await service.assetTickers(f.asset, { limit: 10 }); assert.equal(before.rows.length, 1); assert.equal(before.rows[0].ordinal, '1');
  const job = await service.deployTicker({ asset: f.asset, ticker: 'api ticker', receiver: address });
  assert.equal(job.fee.refundFunding.address, refundAddress); assert.equal(job.fee.refundFunding.satoshis, 16000);
  assert.equal((await service.tickerState(f.asset, job.id)).id, job.id);
  const paid = await f.pay(job), inscription = f.index(paid.content); f.mine();
  const registered = await service.deployTicker({ asset: f.asset, requestId: job.id, inscription }); assert.equal(registered.state, 'registered');
  const after = await service.assetTickers(f.asset); assert.equal(after.rows.length, 2); assert.equal(after.rows[1].ticker, 'dmt-api ticker');
  assert.equal((await service.tickerState(f.asset, 'api ticker')).entry.id, inscription);
  const returns = await f.operator.tickers.fundingReturns({ limit: 20 }); assert.equal(returns.rows.length, 1);
  assert.equal(returns.rows[0].payer, address); assert.equal(returns.rows[0].fundingId, job.id);
});

test('a new receiver can recover an expired unpaid ticker reservation by its named key', async t => {
  const f = await setup(t, 2), first = await f.operator.tickers.request(f.asset, { ticker: 'held', receiver: address });
  const receiver = bitcoinAddress('mainnet', 26);
  await assert.rejects(f.operator.tickers.request(f.asset, { ticker: 'held', receiver }), /ticker_reserved/);
  f.mine(f.context.settings.values.pendingBlocks + 1);
  const next = await f.operator.tickers.request(f.asset, { ticker: 'held', receiver });
  assert.equal(next.state, 'awaiting_fee'); assert.notEqual(next.id, first.id);
  assert.equal(f.store.get('tickerPayments', first.id).state, 'refused');
  assert.equal(f.store.get('tickerReservations', 'dmt-held').requestId, next.id);
});

test('late payment after an unpaid expiry remains refundable and repeated reports do not accrue twice', async t => {
  const f = await setup(t, 2), job = await f.operator.tickers.request(f.asset, { ticker: 'late', receiver: address });
  f.mine(f.context.settings.values.pendingBlocks + 1);
  await f.operator.tickers.payment({ id: job.id, expire: true });
  const first = await f.pay(job); assert.equal(first.fee.state, 'refund_pending');
  assert.equal(f.store.list('publicMintRefunds', { limit: 10 }).length, 1);
  const repeated = await f.pay(job); assert.equal(repeated.fee.state, 'refund_pending');
  assert.equal(f.store.list('publicMintRefunds', { limit: 10 }).length, 1);
});

test('ticker refund quote persists through market changes and reaches the accepted refund sender record', async t => {
  const f = await setup(t, 2), { reserveView } = await import('./refund-reserve-fixture.mjs');
  const { acceptedRefund } = await import('../src/mint-refund-view.mjs');
  const funding = await reserveView(t, f.store.directory, 'mainnet');
  f.operator.mintSender = funding.view; funding.publish(1);
  const job = await f.operator.tickers.request(f.asset, { ticker: 'bound refund', receiver: address });
  const quote = job.fee.refundFunding;
  assert.equal(quote.satoshis, 1844); assert.deepEqual(f.store.get('tickerProvisioning', job.id).refundFunding, quote);
  funding.publish(10);
  assert.deepEqual((await f.operator.tickers.request(f.asset, { ticker: 'bound refund', receiver: address })).fee.refundFunding, quote);
  f.operator.mintSender = funding.restart({ refundReserveSats: 9000 }); funding.publish(10);
  assert.deepEqual((await f.operator.tickers.state(f.asset, job.id)).fee.refundFunding, quote);
  const paid = await f.pay(job);
  f.deployments.set(job.indexTick, { tick: job.indexTick, ins: r.hash('bound-refund-winner') + 'i0' });
  const refused = await f.operator.tickers.refuse(paid, 'ticker_occupied');
  assert.equal(refused.fee.state, 'refund_pending'); assert.equal(refused.fee.refunds.length, 1);
  const record = acceptedRefund({ store: f.store }, refused.fee.refunds[0].refundId);
  assert.equal(record.refundReserveSats, quote.satoshis);
});
