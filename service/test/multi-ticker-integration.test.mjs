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
async function setup(t, multiplier, compound = false, holder = address) {
  const f = await provisioningFixture(t), transfers = new Map();
  f.reads.inscription = async () => ({ address: holder }); f.reads.bindings.resolve = () => ({ request: { address: holder } });
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
    transfers.set(id, fees.map(fee => ({ ins: id, fail: false, int: true, addr: holder, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
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
  // The one-approval set-aside: the deploy inscription's budget plus the bound refund reserve.
  assert.equal(quote.refundReserveSats, 1844); assert.equal(quote.satoshis, quote.deploySats + 1844); assert.deepEqual(f.store.get('tickerProvisioning', job.id).refundFunding, quote);
  funding.publish(10);
  assert.deepEqual((await f.operator.tickers.request(f.asset, { ticker: 'bound refund', receiver: address })).fee.refundFunding, quote);
  f.operator.mintSender = funding.restart({ refundReserveSats: 9000 }); funding.publish(10);
  assert.deepEqual((await f.operator.tickers.state(f.asset, job.id)).fee.refundFunding, quote);
  const paid = await f.pay(job);
  f.deployments.set(job.indexTick, { tick: job.indexTick, ins: r.hash('bound-refund-winner') + 'i0' });
  const refused = await f.operator.tickers.refuse(paid, 'ticker_occupied');
  assert.equal(refused.fee.state, 'refund_pending'); assert.equal(refused.fee.refunds.length, 1);
  const record = acceptedRefund({ store: f.store }, refused.fee.refunds[0].refundId);
  assert.equal(record.refundReserveSats, quote.refundReserveSats);
});

// One approval: the fee payment's set-aside also pays the deploy inscription the minter sends.
async function oneApproval(t, { setAside = true, feeWaitMs } = {}) {
  // A real taproot key: the minter's reveal pays this wallet.
  const address = (await import('../src/mint-sender-keys.mjs')).requestKey(new Uint8Array(32).fill(5), 'cc'.repeat(32), 'mainnet').address;
  const f = await setup(t, 2, false, address), { reserveView } = await import('./refund-reserve-fixture.mjs');
  const { MintSender } = await import('../src/mint-sender.mjs'), { MintSenderJournal } = await import('../src/mint-sender-journal.mjs');
  const { btc } = await import('../src/mint-sender-keys.mjs'), { hex, unhex, networkFor } = await import('../../kit/lib/inscription-core.mjs');
  const funding = await reserveView(t, f.store.directory, 'mainnet');
  if (feeWaitMs) funding.restart({ feeWaitMs });
  f.operator.mintSender = funding.view; funding.publish(1);
  const settings = funding.view.settings, script = address => hex(btc.OutScript.encode(btc.Address(networkFor('mainnet')).decode(address)));
  const utxos = new Map(), sent = [], reports = [], registers = [], logs = [], inflight = new Map();
  let now = funding.now, sender, loseCommit = false, quote;
  const bitcoin = {
    async verifyNetwork() {}, async feeRate() { return 2; },
    async transaction(txid) { return sent.some(s => s.txid === txid) ? { confirmed: false } : null; },
    async utxos(address) { return [...utxos.values()].filter(c => c.address === address).map(({ address, ...c }) => c); },
    async paymentFunding(address, reference) { assert.equal(address, quote.address); assert.match(reference, /^[0-9a-f]{64}i0$/); return (await bitcoin.utxos(address)).filter(c => c.txid === '33'.repeat(32)); },
    async broadcast(raw, txid) {
      const tx = btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true, allowUnknownOutputs: true }); assert.equal(tx.id, txid);
      if (sent.some(s => s.txid === txid)) return txid;
      sent.push({ raw, txid });
      for (let i = 0; i < tx.inputsLength; i++) utxos.delete(hex(tx.getInput(i).txid) + ':' + tx.getInput(i).index);
      for (let i = 0; i < tx.outputsLength; i++) {
        const out = tx.getOutput(i), to = btc.Address(networkFor('mainnet')).encode(btc.OutScript.decode(out.script));
        utxos.set(txid + ':' + i, { txid, vout: i, value: String(out.amount), script: hex(out.script), confirmed: false, cardinal: true, address: to });
      }
      // The reveal carries the deploy: TAP indexes it under the request's ticker.
      const content = (await import('../src/inflight.mjs')).revealText(raw);
      if (content) f.index(JSON.parse(content), txid + 'i0');
      if (loseCommit) { loseCommit = false; throw Error('lost reply'); }
      return txid;
    },
  };
  const gateway = {
    list: async () => ({ keyId: funding.view.keyId, rows: [], next: null, tickerReturns: true, tickerDeploys: true }),
    tickerReturns: (after, limit) => f.operator.tickers.fundingReturns({ after, limit }),
    tickerReturnStatus: id => f.operator.tickers.fundingReturn(id),
    tickerDeploys: async (after, limit) => { const page = await f.operator.tickers.deployStatuses({ after, limit }); return { ...page, rows: page.rows.map(shown) }; },
    tickerDeployStatus: async id => shown(await f.operator.tickers.deployStatus(id)),
    reportTickerDeploy: async (id, plan) => { reports.push({ id, plan }); inflight.set(id, { revealTxid: plan.revealTxid, inscriptionId: plan.inscriptionId }); },
    registerTickerDeploy: async (asset, id, inscription) => { registers.push(inscription); return f.operator.tickers.submit(asset, { requestId: id, inscription }); },
  };
  const shown = row => inflight.has(row.id) && row.state === 'awaiting_player_deploy' ? { ...row, inflight: inflight.get(row.id) } : row;
  const start = () => {
    const journal = new MintSenderJournal(settings.directory, { keyId: funding.view.keyId, network: 'mainnet', now: () => now });
    sender = new MintSender({ seed: new Uint8Array(32).fill(73), network: 'mainnet', settings, journal, gateway, bitcoin, now: () => now, log: v => logs.push(v) });
  };
  // The fixture removes its directory first; the minter's final health write may find it gone.
  start(); t.after(() => sender.close().catch(() => {}));
  const job = await f.operator.tickers.request(f.asset, { ticker: 'one go', receiver: address });
  quote = job.fee.refundFunding;
  const pay = async () => {
    if (setAside) utxos.set('33'.repeat(32) + ':1', { txid: '33'.repeat(32), vout: 1, value: String(quote.satoshis), script: script(quote.address), confirmed: true, cardinal: true, address: quote.address });
    return f.pay(job);
  };
  const tick = async (ms = settings.fundingPollMs) => { now += ms; funding.advance(ms); funding.publish(1); await sender.tick(); await sender.drain(); };
  return { ...f, address, funding, settings, job, quote, pay, tick, sent, reports, registers, logs, utxos, inflight, script, btc, hex, unhex,
    lose: () => { loseCommit = true; }, restart: async () => { await sender.close(); start(); }, get sender() { return sender; } };
}

test('one approval: the quote binds the deploy inscription budget plus the refund reserve', async t => {
  const f = await oneApproval(t), { deployBudget } = await import('../src/mint-sender-keys.mjs');
  assert.equal(f.job.oneApproval, true); assert.equal(f.quote.label, 'your ticker deploy inscription');
  assert.equal(f.quote.satoshis, f.quote.deploySats + f.quote.refundReserveSats); assert.ok(f.quote.refundReserveSats > 0);
  assert.deepEqual(f.store.get('tickerProvisioning', f.job.id).refundFunding, f.quote);
  assert.equal(f.store.list('tickerDeploys', { limit: 10 }).length, 0);
  const paid = await f.pay();
  // Measured for the exact deploy content the page would inscribe, at the observed rate with headroom.
  const bytes = Buffer.byteLength(paid.inscriptionText);
  assert.equal(f.quote.deploySats, deployBudget(f.settings, bytes, { feeRate: 1, feeRateAt: f.job.fee ? f.funding.now : 0, now: f.funding.now }));
  assert.equal(paid.state, 'awaiting_player_deploy'); assert.equal(paid.oneApproval, true);
  assert.equal(f.store.list('tickerDeploys', { limit: 10 }).length, 1);
  // Later fee observations never change a bound quote.
  f.funding.publish(50);
  assert.deepEqual(f.store.get('tickerProvisioning', f.job.id).refundFunding, f.quote);
  // A minter that does not send ticker deploys keeps the refund-only set-aside and the two-step page.
  f.operator.mintSender = f.funding.restart({ tickerDeploysEnabled: false }); f.funding.publish(1);
  const other = await f.operator.tickers.request(f.asset, { ticker: 'two step', receiver: f.address });
  assert.equal(other.oneApproval, undefined); assert.equal(other.fee.refundFunding.deploySats, undefined);
  assert.equal(other.fee.refundFunding.satoshis, other.fee.refundFunding.refundReserveSats);
});

test('one approval: the minter inscribes the registered deploy to the requester once, across lost replies and restarts', async t => {
  const f = await oneApproval(t);
  await f.tick(); assert.equal(f.sent.length, 0, 'nothing is sent before the fee counts');
  const paid = await f.pay();
  f.lose(); await f.tick();
  let row = f.sender.journal.get(f.job.id);
  assert.equal(row.state, 'sending'); assert.ok(row.plan); const plan = row.plan;
  await f.restart(); await f.tick();
  row = f.sender.journal.get(f.job.id);
  assert.deepEqual(row.plan, plan); assert.equal(new Set(f.sent.map(s => s.txid)).size, 2, 'the same commit and reveal only');
  // The reveal sends the exact registered content to the requester's wallet.
  const reveal = f.btc.Transaction.fromRaw(f.unhex(plan.revealHex), { allowUnknownInputs: true });
  assert.equal(f.hex(reveal.getOutput(0).script), f.script(f.address));
  const { revealText } = await import('../src/inflight.mjs');
  assert.equal(revealText(plan.revealHex), paid.inscriptionText);
  // The commit's change keeps at least the refund reserve at the request's own address.
  const commit = f.btc.Transaction.fromRaw(f.unhex(plan.commitHex));
  assert.equal(f.hex(commit.getOutput(1).script), f.script(f.quote.address));
  assert.ok(commit.getOutput(1).amount >= BigInt(f.quote.refundReserveSats));
  assert.equal(f.reports.at(-1).plan.inscriptionId, plan.inscriptionId);
  // Registered through the page's own path, with the same verification.
  const registered = await f.operator.tickers.state(f.asset, f.job.id);
  assert.equal(registered.state, 'registered'); assert.equal(registered.entry.id, plan.inscriptionId);
  assert.equal(registered.entry.receiver, f.address);
  await f.tick(); assert.equal(f.sender.journal.get(f.job.id).state, 'minted');
  // The rest of the set-aside (the deploy's change) returns to the payer through the ticker return.
  await f.tick(); await f.tick();
  const returned = f.sender.journal.rows().find(r => r.tickerReturn);
  assert.ok(returned?.returnPlan, 'the leftover is returned');
  const back = f.btc.Transaction.fromRaw(f.unhex(returned.returnPlan.hex));
  assert.equal(f.hex(back.getInput(0).txid), plan.commitTxid); assert.equal(f.hex(back.getOutput(0).script), f.script(f.address));
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.sent.filter(s => s.txid === plan.revealTxid).length, 1); assert.equal(new Set(f.sent.map(s => s.txid)).size, 3);
});

test('one approval: a refused ticker after the deploy still finds the refund reserve at the request address', async t => {
  const f = await oneApproval(t), { acceptedRefund } = await import('../src/mint-refund-view.mjs');
  const paid = await f.pay();
  // Someone else's deploy of the ticker is indexed first, so the minter's registration refuses the request.
  f.deployments.set(paid.indexTick, { tick: paid.indexTick, ins: r.hash('foreign-winner') + 'i0' });
  await f.tick();
  const row = f.sender.journal.get(f.job.id), refused = await f.operator.tickers.state(f.asset, f.job.id);
  assert.equal(refused.state, 'refused'); assert.equal(refused.fee.state, 'refund_pending');
  const record = acceptedRefund({ store: f.store }, refused.fee.refunds[0].refundId);
  assert.equal(record.refundReserveSats, f.quote.refundReserveSats);
  const coins = (await f.sender.setAside(f.quote.address, [record.reference])).filter(c => !f.sender.journal.coinOwner(c));
  assert.equal(coins.length, 1); assert.equal(coins[0].txid, row.plan.commitTxid);
  assert.ok(BigInt(coins[0].value) >= BigInt(f.quote.refundReserveSats));
});

test('one approval falls back to the two-step page when the payment carried no set-aside', async t => {
  const f = await oneApproval(t, { setAside: false, feeWaitMs: 1000 });
  const paid = await f.pay(); await f.tick(10);
  assert.equal(f.sender.journal.get(f.job.id).state, 'waiting_funding');
  await f.tick();
  assert.equal(f.sender.journal.get(f.job.id).state, 'needs_user');
  const state = await f.operator.tickers.state(f.asset, f.job.id);
  assert.equal(state.oneApproval, false); assert.equal(state.deploySender.state, 'needs_user');
  // The player inscribes the same content from the wallet; the gateway registers it as before.
  const inscription = f.index(paid.content); f.mine();
  assert.equal((await f.operator.tickers.submit(f.asset, { requestId: f.job.id, inscription })).state, 'registered');
  await f.tick(); assert.equal(f.sender.journal.get(f.job.id).state, 'returned'); assert.equal(f.sent.length, 0);
});

test('one approval waits for a deploy the player already sent and never sends a second one', async t => {
  const f = await oneApproval(t);
  const paid = await f.pay();
  f.inflight.set(f.job.id, { revealTxid: '44'.repeat(32), inscriptionId: '44'.repeat(32) + 'i0' });
  await f.tick(); assert.equal(f.sent.length, 0);
  assert.match(f.sender.journal.get(f.job.id).message, /wallet-sent deploy/);
  f.inflight.delete(f.job.id);
  // A duplicate of the same content owned by the requester: the one TAP indexed is registered, not refused.
  const player = f.index(paid.content), other = r.hash('second copy') + 'i0';
  f.contents.set(other, paid.content); f.canonical.set(other, await f.reads.counted());
  const registered = await f.operator.tickers.submit(f.asset, { requestId: f.job.id, inscription: other });
  assert.equal(registered.state, 'registered'); assert.equal(registered.entry.id, player);
  await f.tick(); assert.equal(f.sender.journal.get(f.job.id).state, 'returned');
  // The only Bitcoin sent is the untouched set-aside going back to the payer.
  assert.deepEqual(f.sent.map(s => s.txid), [f.sender.journal.rows().find(r => r.tickerReturn).returnPlan.txid]);
});
