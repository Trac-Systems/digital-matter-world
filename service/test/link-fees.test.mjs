import test from 'node:test';
import assert from 'node:assert/strict';
import { rules } from '../src/rules.mjs';
import { linkFeePlan } from '../src/link-fees.mjs';
import { PublicViews } from '../src/public-views.mjs';

test('retained link fees make no settings read before activation and select only execution height', async () => {
  const document = rules.settingsRevision({ network: 'dmw-regtest', effectiveBatch: '0', effectiveBitcoinWindow: '0', values: { ...rules.SETTINGS_PROFILE, linkBurnBps: 1234 } });
  const terms = { baseFee: '101', settingsHash: rules.hashObject(document) }, height = rules.MULTI_TICKER_HEIGHT, before = String(BigInt(height) - 1n);
  let calls = 0;
  const reads = { counted: async () => height, financialSettings: async hash => { calls++; assert.equal(hash, terms.settingsHash); return document; } };
  const old = await linkFeePlan(reads, terms, { counted: height, executionHeight: before });
  assert.equal(calls, 0); assert.deepEqual(old.split, rules.splitFee(old.price, { kind: 'link' }));
  const active = await linkFeePlan(reads, terms, { counted: before, executionHeight: height });
  assert.equal(calls, 1); assert.deepEqual(active.split, rules.financialSplit(old.price, { kind: 'link' }, document));
  assert.notDeepEqual(active.split, old.split);
  await assert.rejects(linkFeePlan(reads, { baseFee: '101' }, { executionHeight: height }), /link_settings/);
  await assert.rejects(linkFeePlan({ ...reads, financialSettings: async () => ({ ...document, values: { ...document.values, linkBurnBps: 5000 } }) }, terms, { executionHeight: height }), /link_settings/);
});

test('public fee preview adds the pinned link split only at activation', async () => {
  const document = rules.settingsRevision({ network: 'dmw-regtest', effectiveBatch: '0', effectiveBitcoinWindow: '0', values: { ...rules.SETTINGS_PROFILE, linkBurnBps: 1234 } });
  let counted = String(BigInt(rules.MULTI_TICKER_HEIGHT) - 1n);
  const policy = { baseFee: '101', feeSettings: rules.FEE_DEFAULTS };
  const view = Object.assign(Object.create(PublicViews.prototype), { network: document.network,
    store: { get: () => null, hasRows: () => false }, head: async () => ({ tip: { height: counted }, counted }),
    reads: { rulesContext: async () => ({ ready: true, settings: document, settingsHash: rules.hashObject(document), last: { n: '1', to: counted } }),
      tip: async () => ({ tip: counted }) }, feePolicyV2: async () => policy });
  assert.deepEqual((await view.statusV2()).feePolicy, policy);
  counted = rules.MULTI_TICKER_HEIGHT;
  assert.deepEqual((await view.statusV2()).feePolicy, { ...policy, linkBurnBps: 1234 });
});
