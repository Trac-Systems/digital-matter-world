import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rules } from '../src/rules.mjs';
import { Links } from '../src/links.mjs';
import { Store } from '../src/store.mjs';
import { FeeQuotes, createFeePolicy, changeFeePolicy, changeBaseFee, currentFee, issueFeeTerms, validateQuotedTerms, LAUNCH_FEE_SETTINGS } from '../src/fees.mjs';
import { reloadFees, feeArguments } from '../scripts/base-fee.mjs';
import { temp } from './helpers.mjs';
import { fixture } from '../../committee/test/fixture.mjs';
import { Policy } from '../../committee/signer/policy.mjs';
import { linkInput } from '../../committee/test/link-fixture.mjs';
import { observationFixture, network, gateway, gatewaySecret, hashAt } from '../../rules/test/observation-fixture.mjs';

test('old and 3× link quotes survive changes, payment verification and all five independent committee approvals', async () => {
  let now = 1000, registry = { feePolicy: createFeePolicy(rules.parseTapAmount('22.6')), link: { treasury: 'local-treasury' }, assets: {} };
  const readRegistry = async () => structuredClone(registry), store = await Store.open(await temp('lp1-links-'));
  const issuer = new FeeQuotes({ network, secret: gatewaySecret, now: () => now, registry: readRegistry });
  const payments = new Map(), reads = { registry: readRegistry, feeQuotes: issuer, counted: async () => 95,
    bitmap: async () => ({ agent: linkInput().request.owner, address: 'local-holder' }), link: async () => null,
    linkPaymentFor: async row => payments.get(row.id), linkPayment: async id => payments.get(id),
    validateFeeTerms: (kind, row) => validateQuotedTerms(reads, kind, row),
    linkTerms: async id => validateQuotedTerms(reads, 'link', store.get('linkRequests', id)) };
  const links = new Links({ store, network, reads, terms: (...args) => issueFeeTerms(reads, 'link', ...args) });
  const inputs = [];
  try {
    for (const [height, expected] of [[42, '452'], [43, '67.8']]) {
      if (height === 43) registry = changeFeePolicy(registry, { link: 3 }, ++now);
      const original = linkInput(height), body = { request: original.request, sig: original.sig, payer: original.terms.payer, paymentHash: original.terms.hash };
      const quote = await links.request(body);
      assert.equal(rules.formatTapAmount(quote.price), expected);
      assert.equal(quote.split.burn, quote.split.treasury);
      const paymentId = rules.hash('payment/' + height) + 'i0:0';
      const payment = { ...original.payment, id: paymentId, settlement: { ...original.payment.settlement, paymentId }, total: quote.price, base: quote.split.treasury,
        allocations: rules.tapPaymentAllocations(quote.split, {}, 'link') };
      payments.set(quote.id, payment);
      inputs.push({ body, quote, payment });
    }
    registry = changeFeePolicy(registry, { link: 7, compoundMinimum: 12, tierMultipliers: [2, 4, 12, 40, 120] }, ++now);
    registry = changeBaseFee(registry, rules.parseTapAmount('30'), ++now);
    now += 300001; // Admission windows expired; saved authorizations still hold.
    for (const { body, quote, payment } of inputs) {
      assert.deepEqual(await links.request(body), quote, 'retry retains the same saved terms');
      assert.equal((await links.payment({ id: quote.id, paymentId: payment.id })).state, 'queued');
    }
    const paid = await links.inputs({ height: 95, tip: 100, tipHash: hashAt(100) });
    assert.equal(paid.length, 2);
    const observations = observationFixture(); observations.add(100, 95, { linkOperations: paid });
    const built = observations.build(), proposal = { network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(rules.bytesToHex) };
    for (let member = 0; member < 5; member++) {
      const f = fixture(), independent = { ...f.reads, ...reads,
        feeQuotes: new FeeQuotes({ network, gateway, registry: readRegistry }),
        counted: async () => 95, batchContext: async () => observations.context(),
        batchStamp: async () => ({ counted: 95, tip: 100, tipHash: hashAt(100), revision: 0, last: { n: 0, to: 94 } }) };
      independent.linkTerms = id => validateQuotedTerms(independent, 'link', store.get('linkRequests', id));
      await new Policy({ network, publicKey: f.publicKey, reads: independent }).approve(proposal);
    }
    assert.equal(built.batch.ops.filter(op => op.key?.startsWith('link/')).length, 2);
    const row = store.get('linkRequests', inputs[1].quote.id);
    await assert.rejects(validateQuotedTerms(reads, 'link', { ...row, terms: { ...row.terms, feeSettings: { ...LAUNCH_FEE_SETTINGS, link: 1 } } }), /link_policy/);
    const wrongPayment = { ...paid[1].payment, total: rules.parseTapAmount('22.6') };
    assert.throws(() => rules.verifyLinkInput({ ...paid[1], payment: wrongPayment }, network, 95));
  } finally { await store.close(); }
});

test('multipliers are revision-bound even if a gateway signs a mismatched quote', async () => {
  const registry = { feePolicy: createFeePolicy('100', 0, LAUNCH_FEE_SETTINGS) };
  const issuer = new FeeQuotes({ network, secret: gatewaySecret, registry: async () => registry, now: () => 1000 });
  const quote = await issuer.issue('link/test', 10), { signature, ...payload } = quote;
  for (const feeSettings of [undefined, { ...quote.feeSettings, link: 1 }]) {
    const changed = { ...payload }; delete changed.feeSettings;
    if (feeSettings) changed.feeSettings = feeSettings;
    await assert.rejects(issuer.validate(issuer.sign('dmw-fee-quote-v1', changed), quote.scope), /fee_quote_policy/);
  }
  for (const changes of [{ link: 0 }, { link: 1.2 }, { link: 10001 }, { link: '3' }, { compoundMinimum: -1 },
    { tierMultipliers: [1, 3] }, { tierMultipliers: [1, 3, 10, 30, Infinity] }, { unknown: 1 }, { baseFee: rules.TAP_MAX_ATOMS.toString() }]) {
    assert.throws(() => changeFeePolicy(registry, changes, 1001));
  }
});

test('one operator command updates all multipliers atomically and preserves unrelated registry data', async () => {
  const root = await temp('lp1-operator-'), path = join(root, 'registry.json');
  const original = { feePolicy: createFeePolicy('100'), link: { treasury: 'unchanged' }, assets: { p0: { tick: 'unchanged' } } };
  await writeFile(path, JSON.stringify(original));
  const args = feeArguments([path, '--registry', '--at', '1000', '--base-fee', '22.6', '--link', '3', '--tier-multipliers', '1,3,10,30,100', '--compound-minimum', '10']);
  const result = await reloadFees(...args), saved = JSON.parse(await readFile(path));
  assert.deepEqual(result.feeSettings, LAUNCH_FEE_SETTINGS);
  assert.equal(rules.feeFor('link', result.baseFee, 1, result.feeSettings), rules.parseTapAmount('67.8'));
  assert.deepEqual(saved.assets, original.assets); assert.deepEqual(saved.link, original.link);
  assert.deepEqual(saved.feePolicy.revisions[0], { ...original.feePolicy.revisions[0], retiredAt: 1000 });
  assert.equal((await reloadFees(...args)).revision, result.revision, 'repeat is idempotent');
  await assert.rejects(reloadFees(path, { link: 0 }, { registryFile: true, at: 2000 }));
  assert.equal(currentFee(JSON.parse(await readFile(path))).id, result.revision);
  for (const args of [[path, '--link', '03'], [path, '--link', '3.0'], [path, '--link', '-1'], [path, '--link', '3', 'extra'], [path]]) assert.throws(() => feeArguments(args));
});

test('public and installed-kit read projections preserve signed multiplier vectors even at limit one', async () => {
  const { createPublicAPI } = await import('../src/public-api.mjs');
  const { presentRead } = await import('../../kit/lib/reads.mjs');
  const registry = { feePolicy: createFeePolicy('100', 0, LAUNCH_FEE_SETTINGS) };
  const issuer = new FeeQuotes({ network, secret: gatewaySecret, registry: async () => registry });
  const id = '44'.repeat(32), quote = await issuer.issue('link/' + id, 10);
  const api = createPublicAPI({ views: { mints: { public: () => ({ feeQuote: quote, feeSettings: LAUNCH_FEE_SETTINGS }) } } });
  const response = presentRead(await api.read('/mint/' + id + '?limit=1'));
  assert.deepEqual(response.feeQuote, quote); assert.deepEqual(response.feeSettings, LAUNCH_FEE_SETTINGS);
  await issuer.validate(response.feeQuote, 'link/' + id);
});
