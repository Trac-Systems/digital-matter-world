import test from 'node:test';
import assert from 'node:assert/strict';
import { installFinancialSources } from '../src/financial-sources.mjs';
import { warmFinancialRegistry, warmBatchRegistry } from '../src/financial-registry.mjs';
import { rules } from '../src/rules.mjs';

test('registry pre-pass resolves current, chosen, quoted, bulk and accepted deployment keys', async () => {
  const document = rules.settingsRevision({ network: 'test', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: rules.SETTINGS_PROFILE });
  let requested;
  const reads = { feeQuotes: {}, ensureRegistryAssets: async queries => { requested = queries; throw Error('host_registry_warming'); } };
  const stamp = { counted: 10, last: { n: 1 } }, seen = [];
  installFinancialSources(reads, { network: 'test', document,
    request: async id => { if (id === 'missing') throw Error('request_missing'); return { request: { asset: 'c3', deployment: 'chosen' }, quote: { feeQuote: { deploymentId: 'quoted' } } }; },
    reservation: async (_id, at) => { assert.equal(at, stamp); return { request: { asset: 'c5' }, deployment: { id: 'accepted' } }; },
    record: async (key, at) => { seen.push(key); assert.equal(at, stamp); return key.startsWith('fp/') ? { manifest: { asset: 'c6', deployment: 'bulk-accepted' } } : null; } });
  const transitions = [
    { type: 'lifecycle', action: { type: 'deployment-open', asset: 'c1', deployment: 'current' } },
    { type: 'lifecycle', action: { type: 'deployment-add', asset: 'c2', deployment: 'additional' } },
    { type: 'reserve', id: 'missing' }, { type: 'reserve', id: 'one' },
    { type: 'reserve-many', terms: { asset: 'c4', deployment: 'bulk' } },
    { type: 'consume', id: 'two' }, { type: 'bulk-consume', id: 'three' },
    { type: 'public-scan', asset: 'c7', deployment: 'public' }
  ];
  await assert.rejects(warmFinancialRegistry(reads, transitions, stamp), /host_registry_warming/);
  assert.deepEqual(requested, [
    { asset: 'c1', deploymentId: null }, { asset: 'c2', deploymentId: 'additional' },
    { asset: 'c3', deploymentId: 'quoted' }, { asset: 'c4', deploymentId: 'bulk' },
    { asset: 'c5', deploymentId: 'accepted' }, { asset: 'c6', deploymentId: 'bulk-accepted' },
    { asset: 'c7', deploymentId: 'public' }
  ]);
  assert.deepEqual(seen, ['fi/source/two', 'fp/three']);
});

test('mixed proposal pre-pass includes legacy mint quotes and public payment generations', async () => {
  let requested;
  const reads = { ensureRegistryAssets: async queries => { requested = queries; },
    financialRegistryQuery: async transition => ({ asset: 'c1', deploymentId: transition.id }) };
  const request = { asset: 'c1', owner: '01'.repeat(32), amount: '1', receive: '02'.repeat(32), nonce: '03'.repeat(32), until: 10, expires: 20 };
  const payment = { source: { asset: 'c2', quote: { deploymentId: 'old-generation' } } };
  const files = [{ mintOperations: [{ request }], financialOperations: [{ transition: { type: 'public-scan', asset: 'c2' }, evidence: { payments: [payment] } }] }];
  await warmBatchRegistry(reads, files, 'test');
  assert.deepEqual(requested, [{ asset: 'c2', deploymentId: 'old-generation' },
    { asset: 'c1', deploymentId: rules.pendingId('test', request) }, { asset: 'c2', deploymentId: null }]);
});

test('local registry readers retain their original path without a synchronization adapter', async () => {
  await warmFinancialRegistry({}, [null]);
  await warmBatchRegistry({}, [null], 'test');
});
