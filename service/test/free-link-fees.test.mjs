import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { validateFeeSettings, createFeePolicy, changeFeePolicy, FeeQuotes, currentFee } from '../src/fees.mjs';
import { feeArguments, reloadFees } from '../scripts/base-fee.mjs';
import { writeFile, readFile } from 'node:fs/promises';
import { temp, network, secret } from './helpers.mjs';
import { migrateRegistry, readRegistry } from '../src/registry.mjs';

const height = r.FREE_LINK_HEIGHT, before = String(BigInt(height) - 1n), free = { ...r.FEE_DEFAULTS, link: 0 };
test('fee registry and signed quotes gate zero without changing retained revisions; charging can resume', async () => {
  assert.throws(() => validateFeeSettings(free, before), /^Error: fee_settings$/);
  assert.deepEqual(validateFeeSettings(free, height), free);
  assert.throws(() => createFeePolicy('111', 0, free, before), /fee_settings/);
  let registry = { feePolicy: createFeePolicy('111', 0, { ...free, link: 1 }) }, now = 10;
  const old = JSON.stringify(registry.feePolicy.revisions[0]);
  assert.throws(() => changeFeePolicy(registry, { link: 0 }, now, before), /fee_settings/);
  registry = changeFeePolicy(registry, { link: 0 }, now, height);
  assert.equal(currentFee(registry).executionHeight, height);
  assert.equal(JSON.stringify({ ...registry.feePolicy.revisions[0], retiredAt: null }), old);
  let document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: height, values: {
    ...r.SETTINGS_PROFILE, feePolicyRevision: currentFee(registry).id, linkMultiplier: 0 } });
  const quotes = new FeeQuotes({ network, secret, registry: async () => registry, settings: () => document, settingsHistory: { get: async () => document }, now: () => now });
  await assert.rejects(quotes.issue('link/free', before), /settings_value|fee_settings/);
  const q = await quotes.issue('link/free', height);
  assert.equal(r.feeFor('link', q.baseFee, 1, q.feeSettings, height), '0');
  await quotes.validate(q, q.scope);
  registry = changeFeePolicy(registry, { link: 2 }, ++now, height);
  document = r.settingsRevision({ network, previous: document, effectiveBatch: '2', effectiveBitcoinWindow: height,
    values: { ...document.values, feePolicyRevision: currentFee(registry).id, linkMultiplier: 2 } });
  const paid = await quotes.issue('link/paid', height);
  assert.equal(r.feeFor('link', paid.baseFee, 1, paid.feeSettings, height), '222');
});

for (const keyed of [false, true]) test(`base-fee zero dry-run and apply use explicit height, keyed=${keyed}`, async t => {
  assert.throws(() => feeArguments(['/config', '--link', '0']), /^Error: fee_integer$/);
  assert.throws(() => feeArguments(['/config', '--link', '0', '--execution-height', before]), /^Error: fee_integer$/);
  const path = await temp('free-link-registry-') + '/registry.json';
  await writeFile(path, JSON.stringify({ assets: {}, feePolicy: createFeePolicy('111', 0, { ...free, link: 1 }) }));
  if (keyed) await migrateRegistry(path);
  const previous = await readFile(path, 'utf8');
  const args = feeArguments([path, '--registry', '--link', '0', '--execution-height', height, '--at', '100', '--dry-run']);
  const preview = await reloadFees(...args);
  assert.equal(preview.feeSettings.link, 0); assert.equal(await readFile(path, 'utf8'), previous);
  const applied = await reloadFees(args[0], args[1], { ...args[2], dryRun: false });
  assert.deepEqual(applied, preview); assert.equal(currentFee(await readRegistry(path)).id, preview.revision);
  const charged = await reloadFees(path, { link: 1 }, { registryFile: true, at: 101, executionHeight: height });
  assert.equal(charged.feeSettings.link, 1);
});
