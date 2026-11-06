import test from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { secp256k1 } from '../../kit/node_modules/@noble/curves/secp256k1.js';
import { p2tr } from '../../kit/node_modules/@scure/btc-signer/index.js';
import { buildInscription, signCommit, fundingAddress } from '../../kit/lib/inscription-core.mjs';
import { beneficiaryFeePlan } from '../../rules/src/beneficiary-credits.js';
import { publicScanKey, publicRefundKey } from '../../contract/public-mint.js';
import { plotKey } from '../../contract/financial-capacity.js';
import { applyPaymentPage } from '../../contract/payment-pages.js';
import { financialPlan } from '../../rules/src/financial-execution.js';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { accountSettings } from '../../rules/src/account-settings.js';
import { permit } from '../../committee/signer/adapter.mjs';
import { reserveFinancialCapacity } from '../../contract/financial-capacity.js';
import { buildFinancialExecution } from '../src/financial-execution.mjs';
const { installPublicMintSources, publicPaymentData } = await import('../src/public-mint-sources.mjs');
const { FeeQuotes, createFeePolicy } = await import('../src/fees.mjs');
const { identifyFinancialFees } = await import('../src/financial-fee-identity.mjs');

const flat = JSON.parse(await readFile(new URL('./fixtures/flat-fees.json', import.meta.url))).changes;
const flatSettings = { tierMultipliers: flat.tierMultipliers, compoundMinimum: flat.compoundMinimum, link: flat.link };

import { publicMintSourceFixture as fixture } from './public-mint-source-fixture.mjs';

test('a resumed scan overlaps payment reads but preserves the initial context refusal', { timeout: 2000 }, async () => {
  const f = fixture({ legacyPolicy: true }); f.context.publicClaims.unsettled = false;
  const quote = await f.reads.publicMintQuote(f.input, { counted: '103' }); f.pay(quote);
  f.reads.financialSnapshot = () => ({ counted: '103' });
  let release, paymentStarted = false;
  const gate = new Promise(resolve => { release = resolve; });
  f.reads.publicMintContext = async (_asset, _block, _at, _quote, options) => {
    if (options.scanning) { await gate; throw Error('initial_context_refusal'); }
    paymentStarted = true; release(); throw Error('later_payment_refusal');
  };
  await assert.rejects(f.scan(), /initial_context_refusal/);
  assert.equal(paymentStarted, true);
});

test('field-value quote amount equals TAP dmt-mint numeric amount and refuses before activation', async () => {
  const f = fixture();
  f.input.block = '973506';
  f.context.pattern = { ...f.context.pattern, fld: 10, amountMode: 'field-value' };
  f.reads.publicMintHeader = async () => ({ height: 973506, nonce: 3789512813, bits: 386007187 });
  f.context.deployment.remaining = '18446744073709551615';
  f.setHeight(String(BigInt(r.FIELD_VALUE_AMOUNT_HEIGHT) - 1n));
  await assert.rejects(f.reads.publicMintQuote(f.input), /pattern_amount_inactive/);
  f.setHeight(r.FIELD_VALUE_AMOUNT_HEIGHT);
  for (const [fld, dt, amount] of [[4, 'n', '973506'], [10, 'n', '3789512813'], [11, 'n', '386007187'], [11, 'h', '386007187']]) {
    Object.assign(f.context.pattern, { fld, dt, pat: dt === 'h' ? '[0-9a-f]' : '[0-9]' });
    const quote = await f.reads.publicMintQuote(f.input);
    assert.equal(quote.amount, amount); assert.equal(quote.intent.amount, amount);
    const request = { asset: f.input.asset, block: f.input.block, amount: quote.amount };
    const minted = permit('test', request, quote.deployment, f.input.tapAddress, r.hash('value-mint'), r.hash('paid'));
    assert.equal(minted.payload.op, 'dmt-mint'); assert.equal(minted.payload.blk, '973506');
    assert.equal(r.tapElementText('dmwfixture', f.context.pattern), `dmwfixture.${fld}.element`);
    const capacity = { deployment: quote.deployment.id, asset: request.asset, block: request.block, amount, remaining: amount, limit: '0' };
    const writes = await reserveFinancialCapacity({ get: async () => null }, r.hash('capacity'), capacity);
    assert.equal(writes[0][1], amount);
    await assert.rejects(reserveFinancialCapacity({ get: async () => null }, r.hash('capacity'), {
      ...capacity, remaining: String(BigInt(amount) - 1n) }), /financial_capacity_reserved/);
  }
  f.context.pattern.pat = '^0$';
  await assert.rejects(f.reads.publicMintQuote(f.input), /mint_no_match/);
});

for (const legacyAsset of [false, true]) test(`public quote source refuses before publicFrom and opens at the boundary; legacy asset=${legacyAsset}`, async () => {
  const f = fixture({ legacyAsset }), publicFrom = r.claimDeadline(f.context.pattern, f.input.block, f.document);
  assert.equal(publicFrom, '102');
  for (const height of ['100', '101']) {
    f.setHeight(height);
    await assert.rejects(f.reads.publicMintQuote(f.input), { message: 'not_yet_public', status: 409 });
  }
  f.setHeight(publicFrom);
  assert.equal((await f.reads.publicMintQuote(f.input)).amount, '3');
});

for (const legacyAsset of [false, true]) test(`public quote after the finder window has no deadline and ignores unrelated unsettled rounds; legacy asset=${legacyAsset}`, async () => {
  const f = fixture({ legacyAsset }), quote = await f.reads.publicMintQuote(f.input);
  assert.equal(quote.amount, '3'); assert.equal(Object.hasOwn(quote, 'claimDeadline'), false); assert.equal(Object.hasOwn(quote.intent, 'claimDeadline'), false);
  const scan = await f.scan(); assert.equal(scan.start, '100'); assert.deepEqual(f.calls, ['100', '101'], 'one step reads whole confirmed blocks below the newest two');
  f.context.find = { count: '3' };
  await assert.rejects(f.reads.publicMintQuote(f.input), /claimed/);
  f.context.find = null; f.records.set(plotKey(f.input.asset, f.input.block), 'winner');
  await assert.rejects(f.reads.publicMintQuote(f.input), /already_minted/);
});

for (const taken of ['find', 'reservation', 'headerAward']) test(`a confirmed public payment is retained for claimed_first refund after ${taken}`, async () => {
  const f = fixture(), quote = await f.reads.publicMintQuote(f.input), reference = f.pay(quote);
  if (taken === 'find') f.context.find = { count: '3' }; else f.context.publicClaims[taken] = taken === 'headerAward' ? true : { window: '103' };
  const scan = await f.scan();
  assert.equal(scan.payments.length, 1); assert.equal(scan.payments[0].reference, reference);
  assert.equal(scan.payments[0].complete, false); assert.equal(scan.payments[0].refusal, 'claimed_first');
  assert.equal(scan.payments[0].fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString(), quote.fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString());
  assert.equal(scan.payments[0].source, undefined, 'a losing payment cannot issue a permit');
  assert.deepEqual(f.calls, ['103'], 'resume the existing scan without restarting Bitcoin history');
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

for (const [legacyPolicy, digest] of [[true, '7d82a0e6fb7e4eea275e40e44b8ebc82d75e251200cebc0260bb122081002fbc'],
  [false, 'b178941489e014472ede30610e97e49fb7ad1caf64840ae101e7db4433bd03fc']]) {
  test(`historical public quote and payment scan retain their canonical bytes; legacy policy=${legacyPolicy}`, async () => {
    const f = fixture({ retainedQuotes: true, legacyPolicy }); f.context.publicClaims.unsettled = false;
    const quote = await f.reads.publicMintQuote(f.input); f.pay(quote);
    assert.equal(r.hashObject({ quote, scan: await f.scan() }), digest);
  });
}

test('gateway v1 before the boundary and v2 at the boundary use the existing TAP wallet item shape', async () => {
  const f = fixture({ publicPaymentV2Height: '104' }), before = await f.reads.publicMintQuote(f.input);
  assert.ok(before.fees.every(fee => fee.dta.startsWith('dmw-public-pay-v1|')));
  assert.equal(before.registration, undefined);
  f.setHeight('104');
  const after = await f.reads.publicMintQuote(f.input), repeated = await f.reads.publicMintQuote(f.input);
  assert.notEqual(after.registration.commitment, repeated.registration.commitment, 'fresh payer-specific entropy');
  for (const fee of after.fees) {
    assert.match(fee.dta, /^dmw-public-pay-v2\|[0-9a-f]{64}\|[a-zA-Z]+$/);
    assert.ok(Buffer.byteLength(fee.dta) < 100);
    assert.equal(fee.dta.includes(f.input.asset), false);
  }
  assert.deepEqual(Object.keys(r.walletFeeItems(after.fees, 'regtest')[0]).sort(), ['address', 'amt', 'dta', 'tick']);
  assert.equal(Object.hasOwn(after.registration, 'asset'), false);
  assert.equal(Object.hasOwn(after.registration, 'block'), false);
  assert.equal(Object.hasOwn(after.registration, 'paymentSalt'), false);
});

for (const chainAnchored of [false, true]) test(`opaque registration, confirmed reveal, signer reconstruction and contract settlement need no private checkout store; chain checkpoint=${chainAnchored}`, async () => {
  const f = fixture({ publicPaymentV2Height: '103', chainAnchored }), quote = await f.reads.publicMintQuote(f.input);
  await f.register(quote); f.setHeight('104'); const reference = f.pay(quote);
  await assert.rejects(f.scan(), e => e.message === 'public_payment_unrevealed' && e.commitment === quote.registration.commitment && e.reference === reference);
  f.setConfirmations(0); await assert.rejects(f.reveal(quote, reference), /public_payment_unconfirmed/);
  f.setConfirmations(1); await f.reveal(quote, reference);
  const scan = await f.settle();
  assert.equal(scan.payments[0].complete, true); assert.equal(scan.payments[0].paymentVersion, 2);
  assert.equal(f.records.get('fp/' + quote.id).state, 'consumed');
  assert.equal(f.records.get('fi/source/' + quote.id).intent.asset, f.input.asset);
  if (chainAnchored) assert.equal(f.records.get('fp/chain').bitcoin.height, '104');
  await assert.rejects(f.register(quote), /public_payment_registration/);
  await assert.rejects(f.reveal(quote, reference), /public_payment_reveal/);
});

test('a v1 request signed before the payment successor was proposed survives that successor', async () => {
  const f = fixture(), quote = await f.reads.publicMintQuote(f.input);
  assert.equal(f.document.values.publicPaymentV2Height, undefined);
  f.activatePayment('104'); f.setHeight('104'); f.pay(quote);
  const scan = await f.settle();
  assert.equal(scan.payments[0].paymentVersion, 1);
  assert.equal(f.records.get('fp/' + quote.id).state, 'consumed');
});

for (const height of ['103', '104']) test(`a v1 request created before activation settles at height ${height}`, async () => {
  const f = fixture({ publicPaymentV2Height: '104' }), quote = await f.reads.publicMintQuote(f.input);
  f.setHeight(height); f.pay(quote);
  const scan = await f.settle();
  assert.equal(scan.payments[0].paymentVersion, height === '103' ? undefined : 1);
  assert.equal(scan.payments[0].paymentCreated, height === '103' ? undefined : '103');
  assert.equal(f.records.get('fp/' + quote.id).state, 'consumed');
});

test('opaque registration refuses before activation, after expiry, and without the issuer signature', async () => {
  const f = fixture({ publicPaymentV2Height: '104' }); f.setHeight('104'); const quote = await f.reads.publicMintQuote(f.input);
  f.setHeight('103'); await assert.rejects(f.register(quote), /public_payment_activation/);
  f.setHeight(r.addUint(quote.registration.validUntil, '1')); await assert.rejects(f.register(quote), /public_payment_registration/);
  f.setHeight('104');
  await assert.rejects(f.register({ ...quote, registration: { ...quote.registration, signature: '00'.repeat(64) } }), /fee_quote_signature/);
  assert.equal(f.records.has(r.publicPaymentKey(quote.registration.commitment)), false);
});

test('a short payment string cannot make an oversized future reveal payable', async () => {
  const f = fixture({ publicPaymentV2Height: '103', moveBytes: 512 });
  await assert.rejects(f.reads.publicMintQuote(f.input), /public_quote_size/);
});

for (const refusal of ['partial', 'expired', 'claimed']) test(`a ${refusal} opaque payment remains refundable after reveal`, async () => {
  const f = fixture({ publicPaymentV2Height: '103' }), quote = await f.reads.publicMintQuote(f.input);
  await f.register(quote); f.setHeight(refusal === 'expired' ? r.addUint(quote.feeQuote.validUntil, '145') : '104');
  const paid = refusal === 'partial' ? { ...quote, fees: quote.fees.map(fee => ({ ...fee, amount: '1' })) } : quote;
  const reference = f.pay(paid); if (refusal === 'claimed') f.context.find = { count: '3' };
  await f.reveal(quote, reference);
  const scan = await f.settle();
  assert.equal(f.records.get(publicRefundKey(scan.payments[0])).state, 'owed');
  assert.equal(f.records.has('fp/' + quote.id), false);
  assert.equal(scan.payments[0].complete, false);
  assert.equal(scan.payments[0].reference, reference);
  assert.equal(scan.payments[0].paymentVersion, 2);
  assert.equal(scan.payments[0].source, undefined);
});

test('signers reject a new v1 intent after activation and an opaque reveal before registration/payment', async () => {
  const f = fixture({ publicPaymentV2Height: '103' }), quote = await f.reads.publicMintQuote(f.input);
  const { paymentVersion, paymentSalt, signature, ...body } = quote.intent;
  const intent = f.reads.feeQuotes.sign('dmw-public-mint-quote-v1', body);
  f.pay({ ...quote, fees: quote.fees.map(f => ({ ...f, dta: publicPaymentData(intent, f.role) })) });
  assert.equal((await f.scan()).payments.length, 0);
  await assert.rejects(f.reveal(quote, r.hash('missing') + 'i0'), /public_payment_reveal/);
  await f.register(quote); const reference = f.pay(quote);
  await assert.rejects(f.reveal(quote, reference), /public_payment_unconfirmed/, 'payment must follow the accepted registration height');
});

test('commitment mismatch, wrong payer, wrong fee destination and unknown commitments cannot settle or stop scans', async () => {
  const f = fixture({ publicPaymentV2Height: '103' }), quote = await f.reads.publicMintQuote(f.input);
  await f.register(quote); f.setHeight('104'); const reference = f.pay(quote);
  await assert.rejects(f.reveal({ ...quote, intent: { ...quote.intent, block: '101' } }, reference), /public_payment_commitment/);
  await assert.rejects(f.reveal({ ...quote, intent: { ...quote.intent, paymentSalt: r.hash('other') } }, reference), /public_payment_commitment/);
  f.pay(quote, 'another-payer'); assert.equal((await f.scan()).payments.length, 0);
  const other = fixture({ publicPaymentV2Height: '103' }), unknown = await other.reads.publicMintQuote(other.input);
  f.pay(unknown); assert.equal((await f.scan()).payments.length, 0);
  f.pay({ ...quote, fees: quote.fees.map(fee => ({ ...fee, role: 'treasury', to: 'not-a-destination' })) });
  assert.equal((await f.scan()).payments.length, 0);
});

test('linked public quotes and verified payments open at the gate and pay the current holder 15 percent', async () => {
  const f = fixture({ bitmapMintOpenHeight: '104' });
  const holderKey = new Uint8Array(32).fill(45);
  const holder = { agent: r.hash('current-holder'), address: fundingAddress(Buffer.from(secp256k1.getPublicKey(holderKey)).toString('hex'), 'regtest') };
  f.context.link = { block: f.input.block, linkHeight: '100' }; f.context.bitmapHolder = holder;
  await assert.rejects(f.reads.publicMintQuote(f.input), /bitmap_holder_only/);
  assert.ok(await f.reads.publicMintQuote({ ...f.input, tapAddress: holder.address }), 'holder retains access before activation');
  f.setHeight('104');
  const quote = await f.reads.publicMintQuote(f.input);
  assert.notEqual(f.input.tapAddress, holder.address);
  assert.equal(quote.split.landowner, '15'); assert.equal(quote.split.burn, '20'); assert.equal(quote.split.finder, '0');
  assert.equal(quote.fees.find(f => f.role === 'landowner').to, holder.address);
  f.pay(quote); const scan = await f.scan(), winner = scan.payments[0];
  assert.equal(winner.complete, true);
  assert.equal(winner.source.feeItems.find(f => f.role === 'landowner').amount, '15');
  assert.equal(winner.source.feeItems.find(f => f.role === 'landowner').to, holder.address);
  const { applyPublicScan, publicScanKey } = await import('../../contract/public-mint.js');
  const generation = 'generation'; f.records.set('fd/' + generation, { asset: f.input.asset, deployment: f.context.deployment.id, minted: '0', reserved: '0', maximum: '1000000' });
  const { requestId, ...fields } = scan;
  const { verifyFinancialExecution } = await import('../../committee/signer/financial-execution.mjs');
  const { financialPlan } = await import('../../rules/src/financial-execution.js');
  const transition = { type: 'public-scan', id: requestId, asset: f.input.asset, block: f.input.block, previous: scan.previous };
  const evidence = { ...scan, claim: { pattern: '0', claimed: false, publicWinner: null } };
  const operations = await financialPlan({ transition, evidence }, { read: key => f.records.get(key), height: '104', document: f.document });
  const signer = { files: [{ ops: operations, financialOperations: [{ transition, evidence, operations }] }], document: f.document,
    network: f.document.network, height: '104', at: { counted: '104' }, reads: { financialRecord: async key => f.records.get(key),
      financialEvidence: (transition, at) => f.reads.publicMintScan(transition, at) } };
  await verifyFinancialExecution(signer);
  f.setPolicy({ ...f.document, values: { ...f.document.values, bitmapMintOpenHeight: '105' } });
  await assert.rejects(verifyFinancialExecution(signer), /financial_evidence_read/, 'a signer still under the earlier gate refuses the proposed public winner');
  f.setPolicy(f.document);
  await applyPublicScan({ get: async key => f.records.get(key), put: (key, value) => f.records.set(key, value) },
    { id: requestId, ...fields, claim: { pattern: '0', claimed: false, publicWinner: null } }, { height: '104', settings: f.document.values });
  assert.equal(f.records.get('fp/' + winner.id).state, 'consumed');
  assert.equal(f.records.get(publicScanKey(requestId)).winner.id, winner.id);
});
test('public gate keeps the first week, untaken-slot and missing-holder checks', async () => {
  const f = fixture({ bitmapMintOpenHeight: '100' });
  f.context.link = { block: f.input.block, linkHeight: '100' }; f.reads.bitmap = async () => null;
  f.setHeight('101'); await assert.rejects(f.reads.publicMintQuote(f.input), /not_yet_public/);
  f.setHeight('103'); await assert.rejects(f.reads.publicMintQuote(f.input), /bitmap_missing/);
  f.context.find = { finder: r.hash('finder') }; await assert.rejects(f.reads.publicMintQuote(f.input), /claimed/);
  f.context.find = null; f.context.link = null;
  const quote = await f.reads.publicMintQuote(f.input);
  assert.equal(quote.split.landowner, '0'); assert.equal(quote.split.burn, '35');
});
test('historical linked public policy stays holder-only without the new field', async () => {
  const f = fixture(); f.context.link = { block: f.input.block, linkHeight: '100' };
  f.context.bitmapHolder = { agent: r.hash('holder'), address: 'different-holder' }; f.setHeight('9999');
  await assert.rejects(f.reads.publicMintQuote(f.input), /bitmap_holder_only/);
});


test('zero-amount TAP items cannot authorize an opaque reveal', async () => {
  const f = fixture({ publicPaymentV2Height: '103' }), quote = await f.reads.publicMintQuote(f.input);
  await f.register(quote); f.setHeight('104');
  const reference = f.pay({ ...quote, fees: quote.fees.map(fee => ({ ...fee, amount: '0' })) });
  await assert.rejects(f.reveal(quote, reference), /public_payment_unconfirmed/);
  assert.equal((await f.scan()).payments.length, 0);
});

test('opaque payment activation preserves open linked minting and the current holder fee', async () => {
  const f = fixture({ bitmapMintOpenHeight: '103', publicPaymentV2Height: '104' });
  const holder = fundingAddress(Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(45))).toString('hex'), 'regtest');
  f.context.link = { block: f.input.block, linkHeight: '100' }; f.context.bitmapHolder = { address: holder };
  f.setHeight('104'); const quote = await f.reads.publicMintQuote(f.input);
  assert.equal(quote.split.landowner, '15'); assert.equal(quote.fees.find(fee => fee.role === 'landowner').to, holder);
  await f.register(quote); f.setHeight('105'); const reference = f.pay(quote); await f.reveal(quote, reference);
  const scan = await f.settle();
  assert.equal(scan.payments[0].complete, true); assert.equal(scan.payments[0].paymentVersion, 2);
  assert.equal(scan.payments[0].source.feeItems.find(fee => fee.role === 'landowner').to, holder);
  assert.equal(f.records.get('fp/' + quote.id).state, 'consumed');
});

for (const opaque of [false, true]) for (let tier = 1; tier <= 5; tier++) test(`public tier ${tier} flat quote (opaque=${opaque}), independent verification and losing-payment refund preserve exact TAP atoms`, async () => {
  const f = fixture({ baseFee: flat.baseFee, feeSettings: flatSettings, ...(opaque ? { publicPaymentV2Height: '103' } : {}) });
  f.context.tier = tier;
  f.context.treasury = fundingAddress(Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(45))).toString('hex'), 'regtest');
  const quote = await f.reads.publicMintQuote(f.input);
  assert.equal(quote.price, flat.baseFee);
  assert.equal(quote.fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString(), flat.baseFee);
  if (opaque) { await f.register(quote); f.setHeight('104'); }
  const reference = f.pay(quote);
  if (opaque) await f.reveal(quote, reference);
  const scan = await f.settle();
  assert.equal(scan.payments[0].complete, true);
  const losing = fixture({ baseFee: flat.baseFee, feeSettings: flatSettings, ...(opaque ? { publicPaymentV2Height: '103' } : {}) });
  losing.context.tier = tier; losing.context.treasury = f.context.treasury;
  const paid = await losing.reads.publicMintQuote(losing.input);
  if (opaque) { await losing.register(paid); losing.setHeight('104'); }
  const losingReference = losing.pay(paid);
  if (opaque) await losing.reveal(paid, losingReference);
  losing.context.find = { count: '3' };
  const refused = await losing.settle();
  assert.equal(refused.payments[0].refusal, 'claimed_first');
  const refund = losing.records.get(publicRefundKey(refused.payments[0]));
  assert.equal(refund.fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString(), flat.baseFee);
});

test('flat gross public fee preserves payer self-share omission', async () => {
  const f = fixture({ baseFee: flat.baseFee, feeSettings: flatSettings });
  const quote = await f.reads.publicMintQuote(f.input);
  assert.equal(quote.price, flat.baseFee);
  assert.equal(quote.fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString(), quote.split.burn);
  assert.equal(quote.fees.some(fee => fee.to === f.input.tapAddress), false);
});

for (const opaque of [false, true]) test(`public pattern quotes and independently verified settlement retain the legacy share; opaque=${opaque}`, async () => {
  const [element] = Object.entries(r.LEGACY_DEPLOY_MANIFEST.elements).find(([, rows]) => rows.length === 156);
  const f = fixture({ retainedQuotes: true, bitcoinNetwork: 'mainnet', legacyElement: element, baseFee: flat.baseFee, feeSettings: flatSettings,
    ...(opaque ? { publicPaymentV2Height: '100' } : {}) });
  f.setHeight(String(BigInt(r.LEGACY_DEPLOY_SHARE_HEIGHT) - 1n));
  const before = await f.reads.publicMintQuote(f.input);
  assert.equal(before.split.legacyDeploy, undefined);
  f.setHeight(r.LEGACY_DEPLOY_SHARE_HEIGHT);
  const quote = await f.reads.publicMintQuote(f.input), allocated = BigInt(flat.baseFee) / 10n / 156n * 156n;
  assert.equal(quote.price, before.price); assert.equal(quote.split.legacyDeploy, String(allocated));
  assert.equal(quote.split.treasury, before.split.treasury);
  assert.equal(BigInt(quote.split.burn), BigInt(before.split.burn) - allocated);
  if (opaque) { await f.register(quote); f.setHeight(r.nextUint(r.LEGACY_DEPLOY_SHARE_HEIGHT)); }
  const payment = f.pay(quote);
  if (opaque) await f.reveal(quote, payment);
  const result = await f.settle(), winner = result.payments.find(p => p.complete);
  assert.equal(winner.source.legacyDeploy.element, element);
  assert.equal(winner.source.legacyDeploy.amount, String(allocated));
  assert.equal(winner.source.legacyDeploy.count, 156);
  assert.equal(winner.source.legacyDeploy.payoutMinAtoms, '1000000000000000000');
  assert.equal(winner.source.feeItems.some(f => f.role === 'legacyDeploy'), false);
  assert.equal(winner.source.legacyDeploy.authority, f.context.deployment.privilege);
  const { installCapacitySources } = await import('../src/financial-capacity-sources.mjs');
  const source = f.records.get('fi/source/' + winner.id), funding = f.records.get('fp/' + winner.id), height = await f.reads.counted();
  const reader = { ...f.reads, deploymentHolders: async ids => ids.map(id => ({ id, address: '1BitcoinEaterAddressDontSendf59kuE' })),
    mint: async () => ({ accepted: true, fail: false, confirmations: 1, permitHash: winner.permitHash,
      deployment: source.deployment.id, amount: source.amount, receiver: source.receiver, tick: source.deployment.tick,
      committee: source.deployment.privilegePublicKey, block: source.request.block, inscription: r.hash('public-mint') + 'i0' }) };
  installCapacitySources(reader, { network: 'test', bitcoinNetwork: 'mainnet', accepted: async () => ({ source, funding,
    row: { request: source.request, receiver: source.receiver, permit: { prv: { hash: winner.permitHash } } } }) });
  reader.financialEvidence = (transition, at) => reader.financialCapacityEvidence(transition.action, at);
  const transition = { type: 'lifecycle', id: winner.id, action: { type: 'capacity-finish', id: winner.id, permitHash: winner.permitHash } };
  const finished = await buildFinancialExecution({ store: { get: (space, id) => space === 'accountRecords' ? f.records.get(id) ?? null : null },
    reads: reader, transitions: [transition], document: f.document, height, at: { counted: height } });
  assert.equal(finished.inputs[0].evidence.commissions.length, 156);
  await verifyFinancialExecution({ files: [{ ops: finished.operations, financialOperations: finished.inputs }],
    reads: reader, document: f.document, network: 'test', height, at: { counted: height } });
});

for (const opaque of [false, true]) test(`public deployer share retains rewards and verifies the chosen inscription holder; opaque=${opaque}`, async () => {
  const [element] = Object.entries(r.LEGACY_DEPLOY_MANIFEST.elements).find(([, rows]) => rows.length === 156);
  const f = fixture({ retainedQuotes: true, deployerShareBps: 500, bitcoinNetwork: 'mainnet', legacyElement: element, baseFee: flat.baseFee, feeSettings: flatSettings,
    ...(opaque ? { publicPaymentV2Height: '100' } : {}) });
  f.setHeight(String(BigInt(r.LEGACY_DEPLOY_SHARE_HEIGHT) - 1n));
  const before = await f.reads.publicMintQuote(f.input);
  assert.equal(before.split.legacyDeploy, undefined);
  assert.equal(before.split.deployer, undefined);
  f.setHeight(r.LEGACY_DEPLOY_SHARE_HEIGHT);
  const legacy = await f.reads.publicMintQuote(f.input), allocated = BigInt(flat.baseFee) / 10n / 156n * 156n;
  assert.equal(legacy.split.legacyDeploy, String(allocated));
  assert.equal(legacy.split.deployer, undefined);
  assert.equal(BigInt(legacy.split.burn), BigInt(before.split.burn) - allocated);
  f.setHeight(String(BigInt(r.MULTI_TICKER_HEIGHT) - 1n));
  assert.deepEqual((await f.reads.publicMintQuote(f.input)).split, legacy.split);
  f.setHeight(r.MULTI_TICKER_HEIGHT);
  const quote = await f.reads.publicMintQuote(f.input);
  assert.equal(quote.price, before.price); assert.equal(quote.split.legacyDeploy, String(allocated));
  assert.equal(quote.split.treasury, before.split.treasury);
  assert.equal(quote.split.deployer, String(BigInt(flat.baseFee) * 500n / 10000n));
  assert.equal(BigInt(quote.split.burn), BigInt(before.split.burn) - allocated - BigInt(flat.baseFee) * 500n / 10000n);
  if (opaque) { await f.register(quote); f.setHeight(r.nextUint(r.MULTI_TICKER_HEIGHT)); }
  const payment = f.pay(quote);
  if (opaque) await f.reveal(quote, payment);
  const result = await f.settle(), winner = result.payments.find(p => p.complete);
  assert.equal(winner.source.legacyDeploy.element, element);
  assert.equal(winner.source.legacyDeploy.amount, String(allocated));
  assert.equal(winner.source.legacyDeploy.count, 156);
  assert.equal(winner.source.legacyDeploy.payoutMinAtoms, '1000000000000000000');
  assert.equal(winner.source.feeItems.some(f => f.role === 'legacyDeploy'), false);
  assert.equal(winner.source.legacyDeploy.authority, f.context.deployment.privilege);
  const { installCapacitySources } = await import('../src/financial-capacity-sources.mjs');
  const source = f.records.get('fi/source/' + winner.id), funding = f.records.get('fp/' + winner.id), height = await f.reads.counted();
  const reader = { ...f.reads, deploymentHolders: async ids => ids.map(id => ({ id, address: '1BitcoinEaterAddressDontSendf59kuE' })),
    mint: async () => ({ accepted: true, fail: false, confirmations: 1, permitHash: winner.permitHash,
      deployment: source.deployment.id, amount: source.amount, receiver: source.receiver, tick: source.deployment.tick,
      committee: source.deployment.privilegePublicKey, block: source.request.block, inscription: r.hash('public-mint') + 'i0' }) };
  installCapacitySources(reader, { network: 'test', bitcoinNetwork: 'mainnet', accepted: async () => ({ source, funding,
    row: { request: source.request, receiver: source.receiver, permit: { prv: { hash: winner.permitHash } } } }) });
  reader.financialEvidence = (transition, at) => reader.financialCapacityEvidence(transition.action, at);
  const transition = { type: 'lifecycle', id: winner.id, action: { type: 'capacity-finish', id: winner.id, permitHash: winner.permitHash } };
  const finished = await buildFinancialExecution({ store: { get: (space, id) => space === 'accountRecords' ? f.records.get(id) ?? null : null },
    reads: reader, transitions: [transition], document: f.document, height, at: { counted: height } });
  assert.equal(finished.inputs[0].evidence.commissions.length, 157);
  const commission = finished.inputs[0].evidence.commissions.find(c => c.role === 'deployer');
  assert.equal(commission.deployment, source.deployment.id);
  assert.equal(commission.amount, String(BigInt(flat.baseFee) * 500n / 10000n));
  await verifyFinancialExecution({ files: [{ ops: finished.operations, financialOperations: finished.inputs }],
    reads: reader, document: f.document, network: 'test', height, at: { counted: height } });
});

for (const opaque of [false, true]) test(`public selected ticker binds its deployment and shares the permanent asset occurrence; opaque=${opaque}`, async () => {
  const f = fixture({ ...(opaque ? { publicPaymentV2Height: '100' } : {}) });
  f.setHeight(r.MULTI_TICKER_HEIGHT);
  const official = f.context.deployment, extra = { ...official, id: r.hash('public-extra') + 'i0', tick: 'chosen', officialDeployment: official.id };
  f.records.set('fd/extra', { asset: f.input.asset, deployment: extra.id, official: 'generation', minted: '0', reserved: '0', maximum: '1000000' });
  f.records.set('fd/external/' + r.hashObject(extra.id), 'extra');
  f.reads.assetContext = async (_a, _b, _at, quote, _admitted, selection) => {
    const selected = selection ?? quote?.deploymentId, deployment = !selected || selected === official.id ? official : [extra.id, extra.tick].includes(selected) ? extra : null;
    assert.ok(deployment, 'asset_unregistered'); return { ...f.context, deployment };
  };
  const quote = await f.reads.publicMintQuote({ ...f.input, deployment: extra.tick });
  assert.equal(quote.intent.deployment, extra.id); assert.equal(quote.feeQuote.deploymentId, extra.id);
  await assert.rejects(f.reads.publicMintQuote({ ...f.input, deployment: r.hash('forged') + 'i0' }), /asset_unregistered/);
  if (opaque) { await f.register(quote); f.setHeight(r.nextUint(r.MULTI_TICKER_HEIGHT)); }
  const payment = f.pay(quote); if (opaque) await f.reveal(quote, payment);
  const result = await f.settle(), winner = result.payments.find(p => p.complete);
  assert.equal(winner.source.deployment.id, extra.id); assert.equal(winner.source.generation, 'extra');
  await assert.rejects(f.reads.publicMintQuote(f.input), /already_minted/);
  await assert.rejects(f.reads.publicMintQuote({ ...f.input, deployment: extra.id }), /already_minted/);
});

for (const opaque of [false, true]) test(`independent ticker public batch pays all rewards and each deploy holder; opaque=${opaque}`, async () => {
  const [element] = Object.entries(r.LEGACY_DEPLOY_MANIFEST.elements).find(([, rows]) => rows.length === 156);
  const f = fixture({ retainedQuotes: true, deployerShareBps: 500, bitcoinNetwork: 'mainnet', legacyElement: element, baseFee: flat.baseFee,
    feeSettings: flatSettings, bitmapMintOpenHeight: '100', ...(opaque ? { publicPaymentV2Height: '100' } : {}) });
  let height = r.PER_TICKER_SUPPLY_HEIGHT; f.setHeight(height);
  const official = f.context.deployment, extra = { ...official, id: r.hash('independent-extra') + 'i0', tick: 'independent', officialDeployment: official.id };
  f.context.find = { asset: f.input.asset, block: f.input.block, count: 3, finder: r.hash('finder'), findHeight: '100', finderUntil: '102', settingsHash: r.hashObject(f.document) };
  f.context.finderAddress = '1BitcoinEaterAddressDontSendf59kuE';
  f.context.discoverer = f.context.finderAddress;
  f.context.link = { block: '100', linkHeight: '99' }; f.context.bitmapHolder = { address: f.context.finderAddress };
  f.records.set('fd/extra', { asset: f.input.asset, deployment: extra.id, official: 'generation', minted: '0', reserved: '0', maximum: '1000000' });
  f.records.set('fd/external/' + r.hashObject(extra.id), 'extra');
  f.reads.assetContext = async (_a, _b, _at, quote, _admitted, selection) => {
    const id = selection ?? quote?.deploymentId; return { ...f.context, deployment: id === extra.id ? extra : official };
  };
  const quotes = [await f.reads.publicMintQuote(f.input), await f.reads.publicMintQuote({ ...f.input, deployment: extra.id })];
  assert.deepEqual(quotes[0].split, quotes[1].split);
  for (const role of ['finder', 'landowner', 'discoverer', 'treasury', 'burn', 'deployer']) assert.ok(BigInt(quotes[0].split[role]) > 0n, role);
  if (opaque) for (const q of quotes) await f.register(q);
  const transitions = [], evidences = [];
  for (const q of quotes) {
    height = r.nextUint(height); f.setHeight(height);
    const reference = f.pay(q); if (opaque) await f.reveal(q, reference);
    const scope = q.intent.supplyScope, id = r.publicPlotId(f.input.asset, f.input.block, scope);
    f.records.set(publicScanKey(id), { next: { height, transactionIndex: '0', inscriptionIndex: '0' }, scannedHeight: String(BigInt(height) - 1n), blockHash: r.hash('block/' + (BigInt(height) - 1n)), winner: null });
    const transition = { type: 'public-scan', id, asset: f.input.asset, block: f.input.block, ...(scope ? { deployment: scope } : {}), previous: r.hashObject(f.records.get(publicScanKey(id))) };
    transitions.push(transition);
  }
  // f.pay seeds the official fixture cursor; restore its first payment block.
  const firstHeight = String(BigInt(height) - 1n), officialId = transitions[0].id;
  f.records.set(publicScanKey(officialId), { next: { height: firstHeight, transactionIndex: '0', inscriptionIndex: '0' }, scannedHeight: String(BigInt(firstHeight) - 1n), blockHash: r.hash('block/' + (BigInt(firstHeight) - 1n)), winner: null });
  transitions[0].previous = r.hashObject(f.records.get(publicScanKey(officialId)));
  for (const transition of transitions) evidences.push({ ...await f.reads.publicMintScan(transition, { counted: height }), claim: { pattern: '0', claimed: false, publicWinner: null } });
  const inputs = [], operations = [];
  for (let i = 0; i < transitions.length; i++) {
    const plan = await financialPlan({ transition: transitions[i], evidence: evidences[i] }, { read: f.reads.financialRecord, height, document: f.document });
    inputs.push({ transition: transitions[i], evidence: evidences[i], operations: plan }); operations.push(...plan);
  }
  await verifyFinancialExecution({ files: [{ ops: operations, financialOperations: inputs }], reads: { ...f.reads, financialEvidence: f.reads.publicMintScan }, document: f.document, network: 'test', height, at: { counted: height } });
  for (const op of operations) await applyPaymentPage({ get: f.reads.financialRecord, put: (k, v) => f.records.set(k, v) }, op, { network: 'test', height, settings: accountSettings(f.document) });
  for (let i = 0; i < 2; i++) {
    const winner = f.records.get(publicScanKey(transitions[i].id)).winner;
    assert.ok(winner); assert.equal(winner.source.deployer.deployment, quotes[i].deployment.id);
    assert.equal(winner.source.deployer.amount, quotes[i].split.deployer);
    assert.deepEqual(winner.source.intent.split, quotes[i].split);
    await assert.rejects(f.reads.publicMintQuote({ ...f.input, ...(i ? { deployment: extra.id } : {}) }), /already_minted/);
  }
  const { installCapacitySources } = await import('../src/financial-capacity-sources.mjs');
  const reader = { ...f.reads, deploymentHolders: async ids => ids.map(id => ({ id,
    address: id === extra.id ? f.input.tapAddress : '1BitcoinEaterAddressDontSendf59kuE' })),
    mint: async id => { const source = f.records.get('fi/source/' + id), funding = f.records.get('fp/' + id); return {
      accepted: true, fail: false, confirmations: 1, permitHash: funding.permitHash, deployment: source.deployment.id,
      amount: source.amount, receiver: source.receiver, tick: source.deployment.tick, committee: source.deployment.privilegePublicKey,
      block: source.request.block, inscription: r.hash('completed/' + id) + 'i0' }; } };
  installCapacitySources(reader, { network: 'test', bitcoinNetwork: 'mainnet', accepted: async id => {
    const source = f.records.get('fi/source/' + id), funding = f.records.get('fp/' + id);
    return { source, funding, row: { request: source.request, receiver: source.receiver, permit: { prv: { hash: funding.permitHash } } } };
  } });
  reader.financialEvidence = (transition, at) => reader.financialCapacityEvidence(transition.action, at);
  const finishes = quotes.map(q => ({ type: 'lifecycle', id: q.id, action: { type: 'capacity-finish', id: q.id,
    permitHash: f.records.get('fp/' + q.id).permitHash } }));
  const finished = await buildFinancialExecution({ store: { get: (space, id) => space === 'accountRecords' ? f.records.get(id) ?? null : null },
    reads: reader, transitions: finishes, document: f.document, height, at: { counted: height } });
  await verifyFinancialExecution({ files: [{ ops: finished.operations, financialOperations: finished.inputs }], reads: reader,
    document: f.document, network: 'test', height, at: { counted: height } });
  for (let i = 0; i < quotes.length; i++) {
    const liability = finished.inputs[i].evidence.commissions.find(c => c.role === 'deployer');
    assert.equal(liability.deployment, quotes[i].deployment.id); assert.equal(liability.amount, quotes[i].split.deployer);
    assert.equal(liability.to, i ? f.input.tapAddress : '1BitcoinEaterAddressDontSendf59kuE');
  }
  for (const op of finished.operations) await applyPaymentPage({ get: f.reads.financialRecord, put: (k, v) => f.records.set(k, v) }, op,
    { network: 'test', height, settings: accountSettings(f.document) });
  assert.equal(f.records.get('fd/generation').minted, '3'); assert.equal(f.records.get('fd/extra').minted, '3');
});

test('finder week follows the find on every public ticker and ends without a deployment wait', async () => {
  const f = fixture(), height = r.PER_TICKER_SUPPLY_HEIGHT; f.setHeight(height);
  const official = f.context.deployment, extra = { ...official, id: r.hash('week-extra') + 'i0', officialDeployment: official.id };
  f.context.find = { findHeight: String(BigInt(height) - 1n), finderUntil: r.nextUint(height) };
  f.context.finderAddress = f.input.tapAddress;
  f.reads.assetContext = async (_a, _b, _at, _q, _admitted, selection) => ({ ...f.context, deployment: selection ? extra : official });
  for (const deployment of [undefined, extra.id]) {
    assert.ok(await f.reads.publicMintQuote({ ...f.input, deployment }));
    const other = fundingAddress(Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(45))).toString('hex'), 'regtest');
    await assert.rejects(f.reads.publicMintQuote({ ...f.input, deployment, tapAddress: other }), /finder_only/);
  }
  f.setHeight(r.nextUint(height));
  f.context.finderAddress = 'different-wallet';
  assert.ok(await f.reads.publicMintQuote({ ...f.input, deployment: extra.id }));
});


test('pre-activation additional public checkout is refunded without taking the official plot after activation', async () => {
  const f = fixture(), height = r.PER_TICKER_SUPPLY_HEIGHT; f.setHeight(String(BigInt(height) - 1n));
  const official = f.context.deployment, extra = { ...official, id: r.hash('crossing-extra') + 'i0', tick: 'crossing', officialDeployment: official.id };
  f.reads.assetContext = async (_a, _b, _at, quote, _admitted, selection) => ({ ...f.context,
    deployment: (selection ?? quote?.deploymentId) === extra.id ? extra : official });
  const quote = await f.reads.publicMintQuote({ ...f.input, deployment: extra.id }); assert.equal(quote.intent.supplyScope, undefined);
  f.setHeight(height); const payment = f.pay(quote), result = await f.settle();
  assert.equal(result.payments[0].complete, false); assert.equal(result.payments[0].refusal, 'public_quote_changed');
  assert.equal(f.records.get(publicScanKey(r.publicPlotId(f.input.asset, f.input.block))).winner, null);
  assert.equal(f.records.get(publicRefundKey({ id: quote.id, reference: payment })).state, 'owed');
  assert.ok(await f.reads.publicMintQuote(f.input));
});

test('a registered public payment confirmed in the grace window can win; a prior claim still wins', async () => {
  for (const claimed of [false, true]) {
    const f = fixture({ publicPaymentV2Height: '103' }), quote = await f.reads.publicMintQuote(f.input);
    await f.register(quote); f.setHeight(r.addUint(quote.feeQuote.validUntil, '1'));
    const reference = f.pay(quote); if (claimed) f.context.find = { count: '3' };
    await f.reveal(quote, reference); const scan = await f.settle();
    assert.equal(scan.payments[0].complete, !claimed);
    if (claimed) assert.equal(scan.payments[0].refusal, 'claimed_first');
    else assert.equal(f.records.get('fp/' + quote.id).state, 'consumed');
  }
});

test('public confirmation allowance is inclusive and follows the quoted settings after a settings change', async () => {
  for (const blocks of [3, 4]) {
    const f = fixture({ lateConfirmBlocks: 3 }), quote = await f.reads.publicMintQuote(f.input);
    f.setPolicy(r.settingsRevision({ network: f.document.network, previous: f.document, effectiveBatch: '2', effectiveBitcoinWindow: '104',
      values: { ...f.document.values, lateConfirmBlocks: 99 } }));
    f.setHeight(r.addUint(quote.feeQuote.validUntil, String(blocks))); f.pay(quote);
    const scan = await f.scan();
    assert.equal(scan.payments[0].complete, blocks === 3);
    if (blocks === 4) assert.equal(scan.payments[0].refusal, 'quote_expired');
  }
});

for (const opaque of [false, true]) test(`new public quotes pay the deployment holder with no deferred shares; opaque=${opaque}`, async () => {
  const [element] = Object.entries(r.LEGACY_DEPLOY_MANIFEST.elements).find(([, rows]) => rows.length === 156);
  const f = fixture({ deployerShareBps: 500, bitcoinNetwork: 'mainnet', legacyElement: element, baseFee: flat.baseFee, feeSettings: flatSettings,
    ...(opaque ? { publicPaymentV2Height: '100' } : {}) });
  f.setHeight(r.MULTI_TICKER_HEIGHT);
  const q = await f.reads.publicMintQuote(f.input), gross = BigInt(flat.baseFee), holder = (await f.reads.deploymentHolders([q.deployment.id]))[0].address;
  assert.equal(q.fees.find(f => f.role === 'deployer').to, holder);
  assert.equal(q.split.deployer, String(gross * 500n / 10000n));
  assert.equal(q.split.burn, String(gross * 3000n / 10000n));
  assert.equal(q.split.legacyDeploy, undefined);
  const self = await f.reads.publicMintQuote({ ...f.input, tapAddress: holder });
  assert.equal(self.fees.some(f => f.role === 'deployer'), false);
  if (opaque) { await f.register(q); f.setHeight(r.nextUint(r.MULTI_TICKER_HEIGHT)); }
  const reference = f.pay(q); if (opaque) await f.reveal(q, reference);
  const result = await f.settle(), winner = result.payments.find(p => p.complete);
  assert.ok(winner); assert.equal(winner.source.deployer, undefined); assert.equal(winner.source.legacyDeploy, undefined);
  assert.equal(winner.source.feeItems.find(f => f.role === 'deployer').to, holder);
});

test('payments for other blocks do not end a plot scan step; only payments for the scanned block count', async () => {
  const f = fixture({ publicPaymentV2Height: '103' }); f.context.publicClaims.unsettled = false;
  let at = 103n;
  const paid = async block => {
    f.setHeight(String(at)); const quote = await f.reads.publicMintQuote({ ...f.input, block });
    await f.register(quote); at++; f.setHeight(String(at));
    const reference = f.pay(quote); await f.reveal(quote, reference); at++;
    return { quote, reference };
  };
  for (let n = 0; n < 8; n++) await paid(String(10 + n));
  const own = await paid(f.input.block);
  f.records.delete(publicScanKey(r.publicPlotId(f.input.asset, f.input.block)));
  f.setHeight(String(at + 2n));
  const step = await f.scan();
  assert.deepEqual(step.from, { height: '100', transactionIndex: '0', inscriptionIndex: '0' });
  assert.deepEqual(step.payments.map(p => p.reference), [own.reference], 'eight other buyers cost no extra step');
  assert.equal(step.payments[0].complete, true);
});

test('one scan step crosses every confirmed block below the newest two and a block index skips repeated downloads', async () => {
  const f = fixture(); f.context.publicClaims.unsettled = false; f.setHeight('200');
  const first = await f.scan();
  assert.deepEqual(first.from, { height: '100', transactionIndex: '0', inscriptionIndex: '0' });
  assert.deepEqual(first.next, { height: '199', transactionIndex: '0', inscriptionIndex: '0' });
  assert.equal(f.calls.length, 99); assert.equal(first.blockHash, r.hash('block/100'));
  f.reads.publicScanCache = new Map(); f.calls.length = 0;
  const cold = await f.scan(), warm = await f.scan();
  assert.equal(f.calls.length, 99, 'the second identical step reads no block again');
  assert.equal(r.stableJSON(cold), r.stableJSON(warm)); assert.equal(r.stableJSON(cold), r.stableJSON(first));
  f.records.set(publicScanKey(r.publicPlotId(f.input.asset, f.input.block)), { next: first.next, scannedHeight: '100', blockHash: r.hash('block/100'), winner: null });
  const tip = await f.scan();
  assert.deepEqual(tip.next, { height: '200', transactionIndex: '0', inscriptionIndex: '0' }, 'the newest blocks advance one per step');
});
