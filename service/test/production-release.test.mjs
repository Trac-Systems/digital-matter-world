import test from 'node:test';
import assert from 'node:assert/strict';
import { rules as r } from '../src/rules.mjs';
import { hash } from '../src/util.mjs';
import { productionRuntimeBinding, validateProductionRelease, requireProductionRelease } from '../src/production-release.mjs';
import { configuredResources } from '../src/r3-settings.mjs';
function fixture() {
  const revision = 'a'.repeat(40), manifest = { effectiveBatch: '103', previousBatchRoot: 'b'.repeat(64) }, manifestHash = r.hashObject(manifest);
  const document = r.settingsRevision({ network: 'dmw-mainnet', effectiveBatch: '103', effectiveBitcoinWindow: '1', values: { ...r.SETTINGS_PROFILE } });
  const resources = r.resourceRevision({ operator: 'release-test', values: { ...r.RESOURCE_PROFILE } });
  const v2 = { manifest, manifestHash, document, resources, receiptProtocol: 1, gateway: 'c'.repeat(64), receiptSigners: [] };
  const deployment = { v2 }, terminal = { notary: 'd'.repeat(64), legacyNotary: 'e'.repeat(64), manifestHash, ...manifest };
  const config = { network: 'dmw-mainnet', data: '/var/lib/dmw/gateway/host-157/gateway-data', v2,
    committee: [], assetRecoveryVersion: 2, prod: { trac: { bootstrap: terminal.notary } } };
  const release = { revision, oldRevision: 'f'.repeat(40), nodeVersion: 'v24.22.1', platform: 'linux', arch: 'x64' }, releaseBytes = JSON.stringify(release);
  const capture = { reconciled: true, inventoryHash: '1'.repeat(64), reconciliationHash: '2'.repeat(64), sourceInventoryHash: '4'.repeat(64) };
  const plan = { revision, oldRevision: release.oldRevision, terminal, capture, activation: { sha256: '3'.repeat(64) }, releaseManifestSHA256: hash(releaseBytes) };
  const proof = { version: 1, plan, planHash: r.hashObject(plan), release, releaseBytes,
    installedAccounts: ['dmw', ...[1,2,3,4,5].map(n => 'dmw-operator' + n)], runtimeHash: productionRuntimeBinding(config),
    captureHash: r.hashObject(capture), activationSHA256: plan.activation.sha256,
    terminalObservation: { source: 'independent-notary', notary: terminal.notary, manifestHash, ready: true, synchronized: true,
      observedAt: Date.now(), last: { n: '102', root: manifest.previousBatchRoot },
      sendIntentsResolved: true, pendingTransactions: [], deploymentHash: r.hashObject(deployment) } };
  return { config, proof, activation: manifestHash, revision, deployment, current: { ready: true, manifestHash, manifest, last: { n: '102' } } };
}
test('release gate requires all installed accounts, the exact plan, capture, config and independent terminal', () => {
  const f = fixture(); assert.equal(validateProductionRelease(f).manifestHash, f.activation);
  for (const change of [
    f => { f.proof.planHash = '0'.repeat(64); },
    f => { f.proof.installedAccounts.pop(); },
    f => { f.proof.releaseBytes += ' '; },
    f => { f.config.prod.trac.bootstrap = 'e'.repeat(64); },
    f => { f.proof.captureHash = '0'.repeat(64); },
    f => { f.activation = '0'.repeat(64); },
    f => { f.current.ready = false; },
    f => { f.current.last.n = '101'; },
    f => { f.proof.terminalObservation.source = 'gateway'; },
    f => { f.proof.terminalObservation.pendingTransactions.push('uncertain'); },
    f => { f.proof.terminalObservation.synchronized = false; },
    f => { f.proof.terminalObservation.last.n = '103'; },
    f => { f.proof.terminalObservation.last.root = '0'.repeat(64); },
    f => { delete f.proof.terminalObservation.observedAt; },
    f => { f.deployment.v2.receiptProtocol = 0; }
  ]) { const bad = structuredClone(fixture()); change(bad); assert.throws(() => validateProductionRelease(bad), /v2_release_/); }
});
test('production cannot enable v2 with a flag or a supplied observer function alone', async () => {
  for (const v2 of [undefined, { force: true }, { releaseFile: '/tmp/forged.json' }])
    await assert.rejects(requireProductionRelease({ config: { mode: 'prod', v2 }, reads: { rulesContext() {}, trac() {} } }), /v2_release_/);
});
test('an already advanced independently observed terminal can restart without weakening the predecessor plan', () => {
  const f = fixture(); f.current.last.n = '99999999999999999999999'; assert.equal(validateProductionRelease(f).notary, f.proof.plan.terminal.notary);
});
test('saved and resource-expanded runtime configurations have the same release binding', () => {
  const f = fixture(), effective = configuredResources(f.config);
  assert.notDeepEqual(effective.prod, f.config.prod);
  assert.equal(productionRuntimeBinding(f.config), productionRuntimeBinding(effective));
  assert.equal(validateProductionRelease({ ...f, config: effective }).manifestHash, f.activation);
  const changed = structuredClone(effective); changed.prod.registry = '/different/registry.json';
  assert.throws(() => validateProductionRelease({ ...f, config: changed }), /v2_release_plan/);
  changed.prod = effective.prod;
  changed.v2.resources = r.resourceRevision({ operator: 'release-test', previous: changed.v2.resources,
    values: { ...changed.v2.resources.values, sourceRps: changed.v2.resources.values.sourceRps + 1 } });
  assert.throws(() => validateProductionRelease({ ...f, config: changed }), /v2_release_plan/);
});
