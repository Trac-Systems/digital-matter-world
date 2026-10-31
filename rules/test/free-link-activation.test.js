import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { financialLifecyclePlan } from '../src/financial-lifecycle.js';
import { applyFinancialLifecycle } from '../../contract/financial-lifecycle.js';
import { accountSettings } from '../src/account-settings.js';

const height = r.FREE_LINK_HEIGHT, before = String(BigInt(height) - 1n), network = 'dmw-regtest';
const feeSettings = { ...r.FEE_DEFAULTS, link: 0 };
const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: height,
  values: { ...r.SETTINGS_PROFILE, linkMultiplier: 0 } });

test('free link validation selects execution height, preserves other positive multipliers and settings hashes', () => {
  assert.equal(r.freeLinkActive(before), false); assert.equal(r.freeLinkActive(height), true);
  assert.throws(() => r.feeFor('link', '111', 1, feeSettings, before), /^Error: fee_settings$/);
  assert.equal(r.feeFor('link', '111', 1, feeSettings, height), '0');
  assert.equal(r.feeFor('find', '111', 1, feeSettings, height), '111');
  for (const changed of [{ link: -1 }, { compoundMinimum: 0 }, { tierMultipliers: [0, 1, 1, 1, 1] }])
    assert.throws(() => r.feeFor('link', '111', 1, { ...feeSettings, ...changed }, height), /fee_settings/);
  assert.throws(() => r.validateSettings(document.values, undefined, before), /^Error: settings_value$/);
  assert.throws(() => r.validateSettingsDocument(document, before), /^Error: settings_value$/);
  assert.equal(r.validateSettingsDocument(document, height), document);
  assert.throws(() => r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: before, values: document.values }), /settings_value/);
  assert.equal(r.hashObject(r.validateSettingsDocument(document)), r.hashObject(document));
  assert.equal(r.feeFor('link', '111', 1, { ...feeSettings, link: 7 }, height), '777');
});

test('free link planner requires the effective zero settings and empty fees, and creates no funding operation', async () => {
  const id = r.hash('free'), owner = r.hash('owner'), until = String(BigInt(height) + 20n);
  const evidence = { requestId: id, state: 'reservable', owner, bitmapOwner: owner, block: '42', until, link: null,
    settingsHash: r.hashObject(document), quote: { baseFee: '111', feeSettings }, fees: [] };
  const input = e => ({ transition: { type: 'lifecycle', id, action: { type: 'link-reserve', id, owner, block: '42', until, terms: r.hashObject(e) } }, evidence: e });
  const context = { read: async () => null, height, document };
  const operations = await financialLifecyclePlan(input(evidence), context);
  assert.equal(operations.length, 1); assert.equal(operations[0].type, 'lifecycle');
  await assert.rejects(financialLifecyclePlan(input(evidence), { ...context, height: before }), /financial_link_reservation/);
  for (const e of [{ ...evidence, fees: [{ key: r.hash('fee'), amount: '1' }] },
    { ...evidence, quote: { baseFee: '111', feeSettings: { ...feeSettings, link: 1 } } }])
    await assert.rejects(financialLifecyclePlan(input(e), context), /financial_link_(reservation|price)/);
  const charged = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: height, values: { ...document.values, linkMultiplier: 1 } });
  await assert.rejects(financialLifecyclePlan(input(evidence), { ...context, document: charged }), /financial_link_price/);
  await assert.rejects(financialLifecyclePlan(input({ ...evidence, settingsHash: r.hashObject(charged) }), { ...context, document: charged }), /financial_link_price/);
  // Even a quorum-shaped free operation cannot execute before activation.
  const store = { get: async () => null, put: () => assert.fail('premature write') };
  const { ed25519 } = await import('@noble/curves/ed25519');
  const { lifecycleDigest } = await import('../../contract/financial-lifecycle.js');
  const secret = new Uint8Array(32).fill(9), action = { ...operations[0].action, owner: r.bytesToHex(ed25519.getPublicKey(secret)) };
  action.sig = r.bytesToHex(ed25519.sign(lifecycleDigest(network, action), secret));
  await assert.rejects(applyFinancialLifecycle(store, { ...operations[0], action }, { network, height: before, limits: accountSettings(document) }), /link_funding/);
});

test('contract refuses zero settings proposals before actual execution activation even with a future boundary', async () => {
  const { proposeSettings, authorizeSettings } = await import('../../contract/settings-v2.js');
  const previous = r.settingsRevision({ network, effectiveBatch: '0', effectiveBitcoinWindow: '0', values: r.SETTINGS_PROFILE });
  const next = r.settingsRevision({ network, previous, effectiveBatch: '1', effectiveBitcoinWindow: height, values: document.values });
  const rows = new Map([['v2/settings', previous]]), state = { get: async key => rows.get(key) ?? null,
    put: (key, value) => rows.set(key, value), batchLast: async () => ({ n: '0' }) };
  await assert.rejects(proposeSettings(state, next, before), /^Error: settings_value$/);
  await assert.rejects(authorizeSettings(state, next, before), /^Error: settings_value$/);
  assert.equal(rows.size, 1);
  assert.equal(await proposeSettings(state, next, height), null);
  assert.equal(await authorizeSettings(state, next, height), null);
  assert.equal(rows.get('v2/settings-next').values.linkMultiplier, 0);
});
