import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { secp256k1 } from '../../kit/node_modules/@noble/curves/secp256k1.js';
import { p2tr } from '../../kit/node_modules/@scure/btc-signer/index.js';
import { buildInscription, signCommit, fundingAddress } from '../../kit/lib/inscription-core.mjs';
import { beneficiaryFeePlan } from '../../rules/src/beneficiary-credits.js';
import { publicScanKey } from '../../contract/public-mint.js';
import { plotKey } from '../../contract/financial-capacity.js';
const { installPublicMintSources, publicPaymentData } = await import('../src/public-mint-sources.mjs');
const { FeeQuotes, createFeePolicy } = await import('../src/fees.mjs');
const { identifyFinancialFees } = await import('../src/financial-fee-identity.mjs');

function fixture({ legacyPolicy = false, legacyAsset = false } = {}) {
  const network = 'test', key = new Uint8Array(32).fill(44), publicKey = Buffer.from(secp256k1.getPublicKey(key)).toString('hex');
  const address = fundingAddress(publicKey, 'regtest'), asset = legacyAsset ? 'p0' : 'p2:0', block = '100';
  const registry = { feePolicy: createFeePolicy('100') };
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '100', values: {
    ...r.SETTINGS_PROFILE, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100', feePolicyRevision: registry.feePolicy.current,
    linkMultiplier: r.FEE_DEFAULTS.link, finderWindow: 2, publicMintLegacyFinderWindow: 2, ...(!legacyPolicy ? { claimsNeverCloseHeight: '100' } : {}) } });
  const feeQuotes = new FeeQuotes({ network, secret: Buffer.alloc(32, 9), registry: async () => registry, now: () => 1000 }); feeQuotes.document = document;
  const context = { pattern: { number: '0', pat: '[0-9]', fld: 4, dt: 'n', releaseHeight: '100', releaseFinderWindow: 2 },
    publicClaims: { reservation: null, headerAward: false, unsettled: true }, find: null, tier: 1, treasury: address,
    beneficiaries: {}, payouts: {}, deployment: { active: true, kind: 'dmt', id: r.hash('deployment') + 'i0', tick: 'dmwfixture', remaining: '1000000', limit: '0' } };
  const records = new Map([['fd/asset/' + asset, 'generation'], ['fd/generation', { deployment: context.deployment.id }]]), blocks = new Map(), contents = new Map(), transfers = new Map(), calls = [];
  let height = legacyPolicy ? '103' : '101', confirmations = 1, activeDocument = document;
  const reads = { feeQuotes, rulesContext: async () => ({ settings: activeDocument }), counted: async () => height,
    assetContext: async () => context, isMinted: async () => false, publicMintHeader: async b => ({ height: Number(b) }),
    financialSettings: async hash => { assert.equal(hash, r.hashObject(document)); return document; },
    financialRecord: async id => records.get(id), publicBitcoinHash: async h => r.hash('block/' + h),
    publicBitcoinBlock: async h => { calls.push(h); const txs = blocks.get(h) ?? []; return { height: h, hash: r.hash('block/' + h), tx: txs.map(t => t.id), transactions: txs.map(t => t.hex) }; },
    content: async id => contents.get(id), paymentTransfers: async id => (transfers.get(id) ?? []).map((value, index) => ({ index, value })),
    included: async () => confirmations ? { height, confirmations } : null,
    financialFeePlan: ({ split, destinations, beneficiaries, id, payer, rail }) => {
      const plan = beneficiaryFeePlan({ split, destinations, beneficiaries, requestId: id, payer, rail, bitcoinNetwork: 'regtest' });
      return { fees: identifyFinancialFees(plan.fees, { network, rail, bitcoinNetwork: 'regtest' }), custody: plan.credits };
    } };
  installPublicMintSources(reads, { network, bitcoinNetwork: 'regtest' });
  const input = { asset, block, tapAddress: address }, scan = () => reads.publicMintScan({ asset, block, id: r.publicPlotId(asset, block) }, { counted: height });
  const pay = quote => {
    const payload = { p: 'tap', op: 'token-auth', redeem: { items: r.walletFeeItems(quote.fees, 'regtest') } };
    const plan = buildInscription({ text: JSON.stringify(payload), receiver: address, publicKey, network: 'regtest', feeRate: 1, maxFeeSats: '1000000',
      utxos: [{ txid: r.hash('cardinal'), vout: 0, value: '10000000', script: Buffer.from(p2tr(secp256k1.getPublicKey(key).slice(1)).script).toString('hex'), confirmed: true, cardinal: true }] });
    const signed = signCommit(plan, key), id = plan.inscriptionId;
    blocks.set(height, [{ id: id.slice(0, 64), hex: signed.revealHex }]); contents.set(id, payload);
    transfers.set(id, quote.fees.map(f => ({ ins: id, fail: false, int: true, addr: address, taddr: f.to, tick: f.ticker, amt: f.amount, dta: f.dta })));
    records.set(publicScanKey(r.publicPlotId(asset, block)), { next: { height, transactionIndex: '0', inscriptionIndex: '0' }, scannedHeight: String(BigInt(height) - 1n), blockHash: r.hash('block/' + (BigInt(height) - 1n)), winner: null });
    return id;
  };
  return { reads, document, context, records, calls, input, scan, pay, activate: () => { activeDocument = r.settingsRevision({ network, previous: document, effectiveBatch: '2', effectiveBitcoinWindow: '103', values: { ...document.values, claimsNeverCloseHeight: '103' } }); }, setHeight: h => height = h, setConfirmations: n => confirmations = n };
}

for (const legacyAsset of [false, true]) test(`fresh public quote has no deadline and ignores unrelated unsettled rounds; legacy asset=${legacyAsset}`, async () => {
  const f = fixture({ legacyAsset }), quote = await f.reads.publicMintQuote(f.input);
  assert.equal(quote.amount, '3'); assert.equal(Object.hasOwn(quote, 'claimDeadline'), false); assert.equal(Object.hasOwn(quote.intent, 'claimDeadline'), false);
  const scan = await f.scan(); assert.equal(scan.start, '100'); assert.deepEqual(f.calls, ['100'], 'only the bounded payment prefix is read');
  f.context.find = { count: '3' };
  await assert.rejects(f.reads.publicMintQuote(f.input), /claimed/);
  f.context.find = null; f.records.set(plotKey(f.input.asset, f.input.block), 'winner');
  await assert.rejects(f.reads.publicMintQuote(f.input), /already_minted/);
});

for (const taken of ['find', 'reservation', 'headerAward']) test(`a confirmed public payment is retained for claimed_first refund after ${taken}`, async () => {
  const f = fixture(), quote = await f.reads.publicMintQuote(f.input), reference = f.pay(quote);
  if (taken === 'find') f.context.find = { count: '3' }; else f.context.publicClaims[taken] = taken === 'headerAward' ? true : { window: '101' };
  const scan = await f.scan();
  assert.equal(scan.payments.length, 1); assert.equal(scan.payments[0].reference, reference);
  assert.equal(scan.payments[0].complete, false); assert.equal(scan.payments[0].refusal, 'claimed_first');
  assert.equal(scan.payments[0].fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString(), quote.fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString());
  assert.equal(scan.payments[0].source, undefined, 'a losing payment cannot issue a permit');
  assert.deepEqual(f.calls, ['101'], 'resume the existing scan without restarting Bitcoin history');
  f.setConfirmations(0); assert.equal((await f.scan()).payments.length, 0, 'unconfirmed reports are not refund evidence');
});

test('an earlier accepted public winner stays authoritative when a later header award covers its block', async () => {
  const f = fixture(), quote = await f.reads.publicMintQuote(f.input); f.pay(quote);
  const key = publicScanKey(r.publicPlotId(f.input.asset, f.input.block)), original = await f.scan();
  assert.equal(original.payments[0].complete, true);
  f.records.set(key, { ...f.records.get(key), winner: original.payments[0] });
  f.context.publicClaims.headerAward = true;
  const repeated = await f.scan();
  assert.equal(repeated.payments[0].complete, true); assert.equal(repeated.payments[0].refusal, undefined);
  assert.equal(repeated.payments[0].permitHash, original.payments[0].permitHash);
});

test('historical signed intent bytes and legacy scan fences survive the new read shape', async () => {
  const f = fixture({ legacyPolicy: true });
  await assert.rejects(f.reads.publicMintQuote(f.input), /public_scan_pending/);
  f.context.publicClaims.unsettled = false;
  f.setHeight('101'); await assert.rejects(f.reads.publicMintQuote(f.input), /claim_window_open/);
  f.setHeight('103'); const quote = await f.reads.publicMintQuote(f.input);
  assert.equal(quote.intent.claimDeadline, '102'); assert.equal((await f.scan()).start, '102');
  const bytes = JSON.stringify(quote.intent); f.pay(quote);
  f.activate();
  const scan = await f.scan(); assert.equal(scan.payments[0].complete, true);
  assert.equal(scan.payments[0].source.intent.claimDeadline, '102');
  assert.equal(JSON.stringify(quote.intent), bytes);
  assert.equal(publicPaymentData(quote.intent, 'burn'), quote.fees.find(f => f.role === 'burn').dta);
});
