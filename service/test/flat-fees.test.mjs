import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as r from '../../rules/src/index.js';
import { FeeQuotes, createFeePolicy, changeFeePolicy, currentFee } from '../src/fees.mjs';
import { presentRead } from '../../kit/lib/reads.mjs';
import { secret, gateway, network } from './helpers.mjs';

const proposal = JSON.parse(await readFile(new URL('./fixtures/flat-fees.json', import.meta.url)));
const { baseFee, ...feeSettings } = proposal.changes;

test('operator proposal rounds the USD reference up by less than one TAP atom and flattens every fee', () => {
  const target = r.parseTapAmount(proposal.targetUsd), price = r.parseTapAmount(proposal.reference.tapUsd);
  const numerator = BigInt(target) * 10n ** 18n, atoms = BigInt(baseFee), rate = BigInt(price);
  assert.ok(atoms * rate >= numerator);
  assert.ok((atoms - 1n) * rate < numerator);
  assert.equal(r.parseTapAmount(proposal.baseFeeTap), baseFee);
  for (const kind of ['find', 'compound', 'link']) for (let tier = 1; tier <= 5; tier++) {
    assert.equal(r.feeFor(kind, baseFee, tier, feeSettings), baseFee);
    const split = r.splitFee(baseFee, { kind, linked: true, discovered: true });
    assert.equal(Object.values(split).reduce((n, amount) => n + BigInt(amount), 0n).toString(), baseFee);
  }
});

test('old admitted quotes retain exact bytes and prices across a flat fee settings activation', async () => {
  let now = 1000;
  let registry = { feePolicy: createFeePolicy(r.parseTapAmount('22.6'), 0,
    { tierMultipliers: [1, 3, 10, 30, 100], compoundMinimum: 1, link: 1 }) };
  const old = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '100',
    values: { ...r.SETTINGS_PROFILE, feePolicyRevision: currentFee(registry).id, linkMultiplier: 1 } });
  let document = old;
  const history = new Map([[r.hashObject(old), old]]);
  const options = { network, registry: async () => registry, now: () => now, settings: () => document,
    settingsHistory: { get: async hash => history.get(hash) } };
  const issuer = new FeeQuotes({ ...options, secret }), verifier = new FeeQuotes({ ...options, gateway });
  const quote = await issuer.issue('mint/old', '100');
  const accepted = await issuer.accept(quote, quote.scope, 'old', '532', '100');
  const bytes = r.stableJSON({ quote, accepted }), prices = [1, 2, 3, 4, 5].map(tier => r.feeFor('find', quote.baseFee, tier, quote.feeSettings));
  registry = changeFeePolicy(registry, proposal.changes, ++now);
  const next = r.settingsRevision({ network, previous: old, effectiveBatch: '2', effectiveBitcoinWindow: '110',
    values: { ...old.values, feePolicyRevision: currentFee(registry).id, linkMultiplier: feeSettings.link } });
  history.set(r.hashObject(next), next);
  document = r.effectiveSettings(old, next, '2', '109');
  assert.equal(document, old);
  await assert.rejects(issuer.issue('mint/new', '109'), /fee_settings_pin/);
  document = r.effectiveSettings(old, next, '2', '110');
  const fresh = await issuer.issue('mint/new', '110');
  for (const kind of ['find', 'compound', 'link']) for (let tier = 1; tier <= 5; tier++)
    assert.equal(r.feeFor(kind, fresh.baseFee, tier, fresh.feeSettings), baseFee);
  assert.equal(fresh.settingsHash, r.hashObject(next));
  assert.deepEqual(presentRead({ feeQuote: fresh }).feeQuote, fresh, 'kit keeps quote bytes exact');
  await verifier.validate(fresh, fresh.scope);
  const { signature, ...payload } = fresh;
  for (const changed of [{ ...payload, baseFee: '1' }, { ...payload, feeSettings: quote.feeSettings }, { ...payload, settingsHash: r.hashObject(old) }])
    await assert.rejects(verifier.validate(issuer.sign('dmw-fee-quote-v1', changed), fresh.scope), /fee_(quote_policy|settings_pin)/);
  now += old.values.quoteLifetimeMs + 1;
  const terms = await verifier.accepted(accepted, quote.scope, 'old', '532');
  assert.equal(r.stableJSON({ quote, accepted }), bytes);
  assert.deepEqual([1, 2, 3, 4, 5].map(tier => r.feeFor('find', terms.baseFee, tier, terms.feeSettings)), prices);
  assert.equal(r.formatTapAmount(prices.at(-1)), '2260');
  assert.equal(terms.settingsHash, r.hashObject(old));
});
