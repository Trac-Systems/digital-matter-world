import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { newStore } from './helpers.mjs';
import { PublicMints } from '../src/public-mints.mjs';
import { assetResources } from '../src/asset-resources.mjs';
import { rules } from '../src/rules.mjs';
import { publicScanKey } from '../../contract/public-mint.js';
import { FeeQuotes } from '../src/fees.mjs';
import { publicPaymentData } from '../src/public-mint-sources.mjs';
import { secp256k1 } from '../../kit/node_modules/@noble/curves/secp256k1.js';
import { p2tr } from '../../kit/node_modules/@scure/btc-signer/index.js';
import { buildInscription, signCommit, fundingAddress } from '../../kit/lib/inscription-core.mjs';

async function fixture(t) {
  const store = await newStore();
  t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  await store.put('meta', 'ruleState', { counted: '12' });
  const document = { values: { publicMintActivationHeight: '10', publicMintScanBlocks: 2, publicMintPageSize: 2, paymentPage: 10, moveBytes: 8192 } };
  const submitted = [], calls = [], records = new Map(), transfers = new Map(), contents = new Map(), blocks = new Map();
  const reads = { batchStamp: async () => ({ counted: '12' }), financialRecord: async key => records.get(key),
    publicMintScan: async t => { calls.push(t); return {}; }, included: async id => transfers.has(id) ? { height: '12', confirmations: 1 } : null,
    content: async id => contents.get(id), paymentTransfers: async id => (transfers.get(id) ?? []).map((value, index) => ({ index, value })),
    feeQuotes: new FeeQuotes({ network: 'test', secret: Buffer.alloc(32, 19) }),
    publicBitcoinHash: async height => rules.hash('bitcoin/' + height),
    publicBitcoinBlock: async height => { const txs = blocks.get(height) ?? []; return { height, hash: rules.hash('bitcoin/' + height), tx: txs.map(t => t.id), transactions: txs.map(t => t.hex) }; } };
  const parent = { store, document, reads, network: 'test', resources: assetResources(), financial: { submit: async t => submitted.push(t) } };
  const mints = new PublicMints(parent); mints.state = () => ({ state: 'public' });
  const row = id => ({ id, publicMint: true, request: { asset: 'p2:0', block: String(id), amount: '3' }, expiry: '20', created: '10', payer: 'payer', receiver: 'payer',
    kind: 'tap', state: 'awaiting_payment', paymentIds: [], quote: { fees: [{ role: 'treasury', ticker: 'tap', amount: '100', tt: 'a', to: 'recipient', dta: 'bound/' + id }] } });
  const add = async id => {
    const value = row(id);
    await store.transact([{ space: 'mints', id, value }, { space: 'publicMintRequests', id, value: true },
      { space: 'publicMintPlots', id: rules.publicPlotId('p2:0', id), value: { asset: 'p2:0', block: id } }]);
    return value;
  };
  const pay = (value, reference = rules.hash(value.id) + 'i0') => {
    contents.set(reference, { p: 'tap', op: 'token-auth', redeem: { items: value.quote.fees.map(f => ({ address: f.to, tick: f.ticker, amt: rules.formatTapAmount(f.amount), dta: f.dta })) } });
    transfers.set(reference, value.quote.fees.map(f => ({ ins: reference, fail: false, int: true, addr: value.payer, taddr: f.to, tick: f.ticker, amt: f.amount, dta: f.dta })));
    return reference;
  };
  return { store, reads, parent, mints, calls, submitted, records, row, add, pay, blocks };
}

test('2000 unpaid open requests cannot delay a verified paid plot past the next tick', async t => {
  const f = await fixture(t), writes = [];
  for (let i = 1; i <= 2000; i++) {
    const id = String(i), row = f.row(id);
    writes.push({ space: 'mints', id, value: row }, { space: 'publicMintRequests', id, value: true },
      { space: 'publicMintPlots', id: rules.publicPlotId('p2:0', id), value: { asset: 'p2:0', block: id } });
  }
  await f.store.transact(writes);
  await f.mints.tick(); assert.equal(f.submitted.length, 0, 'unpaid plots never produce scan operations');
  const paid = await f.add('2001'), paymentId = f.pay(paid);
  await f.mints.payment({ id: paid.id, paymentId });
  await f.mints.tick();
  const expected = { type: 'public-scan', id: rules.publicPlotId('p2:0', '2001'), asset: 'p2:0', block: '2001', previous: rules.hashObject(null) };
  assert.deepEqual(f.calls, [expected]); assert.deepEqual(f.submitted, [expected], 'the existing independently verified transition is unchanged');
  assert.equal(f.store.count('publicMintRequests'), 2001);
});

test('unseen, mismatched and unconfirmed reports cannot add unpaid plots to the scan queue', async t => {
  const f = await fixture(t), row = await f.add('1'), paymentId = rules.hash('unseen') + 'i0';
  await assert.rejects(f.mints.payment({ id: row.id, paymentId }), /payment_unseen/);
  assert.equal(f.store.count('publicMintPaidPlots'), 0);
  const wrong = { ...row, payer: 'someone-else' }; f.pay(wrong, paymentId);
  await assert.rejects(f.mints.payment({ id: row.id, paymentId }), /payment_unseen/);
  f.pay(row, paymentId); f.reads.included = async () => ({ height: '12', confirmations: 0 });
  await assert.rejects(f.mints.payment({ id: row.id, paymentId }), /payment_unseen/);
  await f.mints.tick(); assert.equal(f.submitted.length, 0);
  assert.equal(f.store.get('mints', row.id).state, 'awaiting_payment');
});

test('settled scans leave the queue and a later payment reactivates the same plot', async t => {
  const f = await fixture(t), row = await f.add('1');
  await f.mints.payment({ id: row.id, paymentId: f.pay(row) });
  f.records.set(publicScanKey(rules.publicPlotId('p2:0', '1')), { next: { height: '13' } });
  await f.mints.tick(); assert.equal(f.store.count('publicMintPaidPlots'), 0);
  await f.mints.queuePlot('p2:0', '1', '13');
  await f.mints.tick(); assert.equal(f.submitted.length, 1);
});

for (const created of [null, '10', '11']) test(created === null ? 'shared Bitcoin discovery resumes across restarts and scans an unreported real payment' :
  `v1 discovery at opaque activation handles quote created at ${created}`, async t => {
  const f = await fixture(t), key = new Uint8Array(32).fill(44), pub = Buffer.from(secp256k1.getPublicKey(key)).toString('hex');
  const address = fundingAddress(pub, 'regtest');
  if (created !== null) f.parent.document.values.publicPaymentV2Height = '11';
  const intent = f.reads.feeQuotes.sign('dmw-public-mint-quote-v1', { network: 'test', asset: 'p2:0', block: '9', tapAddress: address, ...(created === null ? {} : { feeQuote: { validFrom: created } }),
    fees: [{ role: 'treasury', ticker: 'tap', amount: '100', tt: 'a', to: address }] });
  const row = { id: rules.publicRequestId('test', intent), payer: address, quote: { fees: intent.fees.map(fee => ({ ...fee, dta: publicPaymentData(intent, fee.role) })) } };
  const payload = { p: 'tap', op: 'token-auth', redeem: { items: rules.walletFeeItems(row.quote.fees, 'regtest') } };
  const plan = buildInscription({ text: JSON.stringify(payload), receiver: address, publicKey: pub, network: 'regtest', feeRate: 1, maxFeeSats: '1000000',
    utxos: [{ txid: rules.hash('discovery-cardinal'), vout: 0, value: '10000000', script: Buffer.from(p2tr(secp256k1.getPublicKey(key).slice(1)).script).toString('hex'), confirmed: true, cardinal: true }] });
  f.pay(row, plan.inscriptionId);
  f.blocks.set('12', [{ id: plan.inscriptionId.slice(0, 64), hex: signCommit(plan, key).revealHex }]);
  await f.mints.tick(); assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '11');
  const resumed = new PublicMints(f.parent);
  await resumed.tick(); assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '12');
  if (created === '11') {
    await resumed.tick(); assert.equal(f.submitted.length, 0);
    assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '13');
    return;
  }
  f.reads.withTapSnapshot = async () => { throw Error('tap_lookup_index_catching_up'); };
  await resumed.tick();
  assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '12', 'an unavailable TAP snapshot must not skip a payment');
  assert.equal(f.submitted.length, 0);
  f.reads.withTapSnapshot = async (at, read) => { assert.equal(at.counted, '12'); return read(); };
  await resumed.tick();
  assert.equal(f.submitted.length, 1); assert.equal(f.submitted[0].block, '9');
  assert.equal(f.store.count('mints'), 0, 'discovery does not require a local request or create a reservation');
});

test('existing winners remain eligible for permit and mint completion after upgrade', async t => {
  const f = await fixture(t); await f.add('1');
  const id = rules.publicPlotId('p2:0', '1'), state = { winner: { id: '1' }, next: { height: '13' } };
  await f.store.put('accountRecords', publicScanKey(id), state); f.records.set(publicScanKey(id), state);
  const issued = []; f.mints.issue = async winner => issued.push(winner.id);
  await f.mints.tick(); assert.deepEqual(issued, ['1']); assert.equal(f.submitted.length, 0);
});

test('a discovery source failure does not postpone an already verified paid plot', async t => {
  const f = await fixture(t), row = await f.add('1');
  await f.mints.payment({ id: row.id, paymentId: f.pay(row) });
  f.reads.publicBitcoinBlock = async () => { throw Error('bitcoin_unavailable'); };
  await f.mints.tick();
  assert.equal(f.submitted.length, 1); assert.equal(f.submitted[0].block, '1');
  assert.equal(f.store.get('meta', 'publicMintDiscovery'), null);
  assert.equal(f.store.get('meta', 'publicMintDiscoveryFailure').reason, 'bitcoin_unavailable');
});

test('a new payment arriving during queue cleanup retains the plot for its next scan', async t => {
  const f = await fixture(t), row = await f.add('1');
  await f.mints.payment({ id: row.id, paymentId: f.pay(row) });
  f.reads.financialRecord = async () => {
    await f.mints.queuePlot('p2:0', '1', '13');
    return { next: { height: '13' } };
  };
  await f.mints.tick();
  assert.equal(f.store.get('publicMintPaidPlots', rules.publicPlotId('p2:0', '1')).through, '13');
  assert.equal(f.submitted.length, 0);
  await f.mints.tick(); assert.equal(f.submitted.length, 1);
});

async function opaquePayment(f, { invalid } = {}) {
  f.parent.document.values.publicPaymentV2Height = '11';
  const key = new Uint8Array(32).fill(44), pub = Buffer.from(secp256k1.getPublicKey(key)).toString('hex'), address = fundingAddress(pub, 'regtest');
  const intent = f.reads.feeQuotes.sign('dmw-public-mint-quote-v1', { network: 'test', asset: 'p2:0', block: '9', tapAddress: address,
    paymentVersion: 2, paymentSalt: rules.hash('discovery-salt'), feeQuote: { validFrom: '11', validUntil: '20' }, settingsHash: rules.hash('settings'),
    fees: [{ role: 'treasury', ticker: 'tap', amount: '100', tt: 'a', to: address }] });
  const commitment = rules.publicPaymentCommitment(intent), registration = { commitment, network: 'test', payer: address,
    validFrom: '11', validUntil: '20', settingsHash: intent.settingsHash,
    feeBindings: intent.fees.map(fee => rules.publicPaymentFeeBinding(commitment, fee.role, fee.to, fee.ticker)) };
  const accepted = { registration, registeredHeight: invalid === 'same-height' ? '12' : invalid === 'later-registration' ? '13' : '11' };
  if (invalid !== 'unregistered') f.records.set(rules.publicPaymentKey(commitment), accepted);
  const fees = intent.fees.map(fee => ({ ...fee, dta: publicPaymentData(intent, fee.role) }));
  if (invalid === 'wrong-destination') fees[0].to = fundingAddress(Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(45))).toString('hex'), 'regtest');
  if (invalid === 'wrong-role') fees[0].dta = fees[0].dta.replace('treasury', 'burn');
  if (invalid === 'malformed') fees[0].dta += '|extra';
  if (invalid === 'zero') fees[0].amount = '0';
  const row = { id: rules.publicRequestId('test', intent), payer: invalid === 'wrong-payer' ? 'copied-by-another-wallet' : address, quote: { fees } };
  const payload = { p: 'tap', op: 'token-auth', redeem: { items: fees.map(fee => ({ address: fee.to, tick: fee.ticker, amt: rules.formatTapAmount(fee.amount), dta: fee.dta })) } };
  const plan = buildInscription({ text: JSON.stringify(payload), receiver: address, publicKey: pub, network: 'regtest', feeRate: 1, maxFeeSats: '1000000',
    utxos: [{ txid: rules.hash('opaque-discovery-cardinal'), vout: 0, value: '10000000', script: Buffer.from(p2tr(secp256k1.getPublicKey(key).slice(1)).script).toString('hex'), confirmed: true, cardinal: true }] });
  f.pay(row, plan.inscriptionId);
  f.blocks.set('12', [{ id: plan.inscriptionId.slice(0, 64), hex: signCommit(plan, key).revealHex }]);
  await f.store.put('meta', 'publicMintDiscovery', { height: '12', transactionIndex: 0, inscriptionIndex: 0 });
  return { intent, commitment, accepted, row, reference: plan.inscriptionId };
}

test('opaque feed discovery holds its cursor, validates a saved reveal, and resumes from accepted records without a payment report', async t => {
  const f = await fixture(t), q = await opaquePayment(f);
  await f.mints.tick();
  assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '12', 'a missing local preimage cannot skip a paid commitment');
  assert.equal(f.store.get('meta', 'publicMintDiscoveryFailure').reason, 'public_payment_unrevealed');
  assert.equal(f.submitted.length, 0);
  const saved = { ...q.row, publicMint: true, request: { asset: 'p2:0', block: '9' }, created: '11', expiry: '11', intent: q.intent, state: 'awaiting_payment', paymentIds: [] };
  await f.store.transact([{ space: 'mints', id: q.row.id, value: saved }, { space: 'publicMintRequests', id: q.row.id, value: true },
    { space: 'publicMintCommitments', id: q.commitment, value: q.row.id }]);
  let available = false, checks = 0;
  f.reads.publicMintPayment = async transition => { checks++; assert.equal(transition.reference, q.reference); if (!available) throw Error('public_payment_unconfirmed'); };
  await new PublicMints(f.parent).tick();
  assert.equal(f.store.get('publicMintRequests', q.row.id), null, 'expiry frees admission but retains the saved reveal');
  assert.deepEqual(f.store.get('mints', q.row.id), saved);
  assert.equal(f.submitted.length, 0, 'a reveal cannot enter the queue before independent verification');
  available = true; await new PublicMints(f.parent).tick();
  assert.equal(checks, 2);
  assert.deepEqual(f.submitted, [{ type: 'public-payment', id: q.commitment, action: 'reveal', intent: q.intent, reference: q.reference }]);
  assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '12', 'queued reveal is not accepted evidence');
  f.records.set(rules.publicPaymentKey(q.commitment), { ...q.accepted, intent: q.intent });
  await f.store.transact([{ space: 'mints', id: q.row.id }, { space: 'publicMintCommitments', id: q.commitment }]);
  await new PublicMints(f.parent).tick();
  assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '13');
  assert.equal(f.submitted.length, 2); assert.equal(f.submitted[1].type, 'public-scan'); assert.equal(f.submitted[1].block, '9');
  assert.equal(f.store.count('mints'), 0);
});

for (const invalid of ['unregistered', 'same-height', 'later-registration', 'wrong-payer', 'wrong-destination', 'wrong-role', 'malformed', 'zero']) {
  test(`opaque discovery ignores ${invalid} payments without queuing work or holding the cursor`, async t => {
    const f = await fixture(t); await opaquePayment(f, { invalid });
    await f.mints.tick();
    assert.equal(f.submitted.length, 0); assert.equal(f.store.count('publicMintPaidPlots'), 0);
    assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '13');
    assert.equal(f.store.get('meta', 'publicMintDiscoveryFailure'), null);
  });
}

test('opaque discovery cannot skip a payment while the independent TAP snapshot is unavailable', async t => {
  const f = await fixture(t); await opaquePayment(f);
  f.reads.withTapSnapshot = async () => { throw Error('tap_lookup_index_catching_up'); };
  await f.mints.tick();
  assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '12');
  assert.equal(f.submitted.length, 0);
  assert.equal(f.store.get('meta', 'publicMintDiscoveryFailure').reason, 'tap_lookup_index_catching_up');
});
