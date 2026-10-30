import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { financialSplit } from '../src/financial-fees.js';
const deployment = { id: 'e'.repeat(64) + 'i0', privilege: 'f'.repeat(64) + 'i0',
  elementId: Object.entries(r.LEGACY_DEPLOY_MANIFEST.elements).find(([, rows]) => rows.length === 2)[0] };
const document = { values: { ...r.SETTINGS_PROFILE, legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '100', deployerShareBps: 500 } };
test('deployer and legacy share only reduce burn, on both rails and both mint kinds', () => {
  for (const kind of ['find', 'compound', 'link']) for (const linked of [false, true]) for (const publicMint of [false, true]) {
    const split = financialSplit('10000', { kind, linked, publicMint, discovered: true }, document);
    const result = r.deploymentHolderFee('10000', split, { kind, deployment, document, height: r.MULTI_TICKER_HEIGHT });
    const legacy = kind === 'find' ? 1000n : 0n, deployer = kind === 'link' ? 0n : 500n;
    assert.equal(BigInt(result.split.burn), BigInt(split.burn) - legacy - deployer);
    for (const role of ['finder', 'firstMaker', 'discoverer', 'landowner', 'treasury']) assert.equal(result.split[role], split[role]);
    for (const rail of ['tap', 'ethereum']) {
      const items = r.mintFeeItems(result.split, { finder: 'f', firstMaker: 'm', discoverer: 'd', landowner: 'l', treasury: 't' }, null, null, rail);
      assert.equal(items.reduce((n, i) => n + BigInt(i.amount), 0n), 10000n);
      assert.equal(items.find(i => i.role === 'treasury').amount, String(BigInt(split.treasury) + legacy + deployer));
    }
  }
});
test('deployer activation preserves already active legacy shares and missing settings preserve old bytes', () => {
  const split = financialSplit('999', { kind: 'find', linked: true }, document);
  for (const height of ['0', String(BigInt(r.LEGACY_DEPLOY_SHARE_HEIGHT) - 1n), r.LEGACY_DEPLOY_SHARE_HEIGHT, String(BigInt(r.MULTI_TICKER_HEIGHT) - 1n)]) {
    const options = { kind: 'find', deployment, document, height };
    assert.deepEqual(r.deploymentHolderFee('999', split, options), r.legacyDeployFee('999', split, options));
  }
  assert.deepEqual(r.deploymentHolderFee('999', split, { kind: 'compound', deployment, document: { values: r.SETTINGS_PROFILE }, height: r.MULTI_TICKER_HEIGHT }), { split });
});
test('settings forbid combined shares above either burn and require the shared threshold', () => {
  r.validateSettings(document.values); r.validateSettings({ ...r.SETTINGS_PROFILE, deployerShareBps: 0 });
  for (const patch of [{ deployerShareBps: 1001 }, { compoundBurnBps: 499 }, { legacyDeployPayoutMinAtoms: '0' }, { deployerShareBps: -1 }])
    assert.throws(() => r.validateSettings({ ...document.values, ...patch }));
});
test('deployer liabilities bind the chosen inscription and a valid current Bitcoin holder', () => {
  const liability = { deployment: deployment.id, amount: '5', payoutMinAtoms: '100' }, holder = { id: deployment.id, address: '1BitcoinEaterAddressDontSendf59kuE' };
  assert.equal(r.deployerCommission('mint', liability, holder).to, holder.address);
  assert.throws(() => r.deployerCommission('mint', liability, { ...holder, id: 'forged' }), /deployer_liability/);
  assert.throws(() => r.deployerCommission('mint', liability, { ...holder, address: 'forged' }));
});
