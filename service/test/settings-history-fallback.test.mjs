import test from 'node:test';
import assert from 'node:assert/strict';
import { rules as r } from '../src/rules.mjs';
import { installFinancialSources } from '../src/financial-sources.mjs';
import { FeeQuotes, createFeePolicy } from '../src/fees.mjs';

const network = 'dmw-regtest', feePolicy = createFeePolicy('100');
const settings = effectiveBatch => r.settingsRevision({ network, effectiveBatch, effectiveBitcoinWindow: '100',
  values: { ...r.SETTINGS_PROFILE, feePolicyRevision: feePolicy.current, linkMultiplier: r.FEE_DEFAULTS.link } });
const install = (current, history = new Map()) => installFinancialSources({ settingsByHash: async hash => history.get(hash) ?? null, rulesContext: async () => ({ ruleset: 'dmw-v2', settings: current }),
  feeQuotes: new FeeQuotes({ network, registry: async () => ({ feePolicy }) }) },
  { network, document: current, bitcoinNetwork: 'regtest', recoveryVersion: 2, request: () => null, reservation: () => null, record: () => null });

test('the current Trac settings resolve by their exact hash when the history has no entry for them', async () => {
  const current = settings('1'), reads = install(current);
  assert.equal(r.hashObject(await reads.financialSettings(r.hashObject(current))), r.hashObject(current));
});

test('an older document missing from the history still fails closed', async () => {
  const older = settings('1'), current = settings('2'), reads = install(current);
  await assert.rejects(reads.financialSettings(r.hashObject(older)), /financial_settings_history/);
});
