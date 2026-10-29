import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { closureTimeouts } from '../../rules/src/closure-timeouts.js';
import { runtimeResources, configuredResources } from '../src/r3-settings.mjs';

test('closure deadlines derive from each budget and reach gateway, replay and evidence configuration', () => {
  const document = r.settingsRevision({ network: 'fixture', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
  const resources = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE } });
  const base = closureTimeouts(document, resources), mapped = runtimeResources(resources, document);
  assert.equal(mapped.committee.prepareMs, base.prepareMs); assert.equal(mapped.committee.timeoutMs, base.sessionMs);
  assert.equal(mapped.committee.requestMs, resources.values.committeeRequestMs);
  assert.equal(mapped.committee.historyPage, resources.values.committeeHistoryPage);
  assert.equal(mapped.replay.timeoutMs, base.replayMs); assert.equal(mapped.evidence.maxAgeMs, base.evidenceMs);
  for (const key of ['closureWorkBudget', 'closureReadBudget', 'closureByteBudget']) {
    const larger = { ...document, values: { ...document.values, [key]: document.values[key] * 2 } };
    assert.ok(closureTimeouts(larger, resources).prepareMs > base.prepareMs, key);
  }
  const config = configuredResources({ v2: { document, resources }, prod: { evidence: { settings: {} } } });
  assert.equal(config.prod.evidenceSettings.maxAgeMs, base.evidenceMs); assert.equal(config.prod.evidence.settings.maxAgeMs, base.evidenceMs);
  assert.equal(closureTimeouts({ values: {} }, resources), null);
  const old = { ...resources, version: 3, values: Object.fromEntries(Object.entries(resources.values).filter(([k]) => !k.startsWith('closure') && !k.startsWith('committee') && !k.startsWith('assetPublic') && k !== 'relayObservationPage')) };
  assert.equal(r.validateResourceDocument(old), old); assert.throws(() => r.runtimeCapabilities(document, old), /resource_closure_capacity/);
});
