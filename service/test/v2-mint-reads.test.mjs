import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { configFixture } from '../prod/test/helpers.mjs';
import { migrateRegistry, updateRegistryAsset } from '../src/registry.mjs';
import { createFeePolicy } from '../src/fees.mjs';
import { rules as r } from '../src/rules.mjs';

// Reader logic uses real authenticated catalog/find roots and deployment
// verification. Configuration and remote transports are fixtures; no private
// files outside this checkout or live services are needed by this unit test.
const configuration = await import('../prod/config.mjs');
mock.module('../prod/config.mjs', { exports: { ...configuration, validateConfig: async () => {} } });
let active;
mock.module('../prod/bitcoin.mjs', { exports: {
  createBitcoin: async () => ({ tip: async () => active.tip, blockHash: async () => active.tip.hash, included: (...args) => active.reads.included(...args) }),
  BitcoinViews: class { ordinal(n) { return Number(n); } async view() { return { hashAt: () => active.tip.hash }; } close() {} }
} });
mock.module('../prod/tap.mjs', { exports: { createTap: async () => ({
  tap: path => path.startsWith('getMintTokensLeft/') ? '1000000' : active.reads.tap(path),
  content: id => active.reads.content(id), inscription: id => active.reads.inscription(id),
  at: (_at, fn) => fn(), stamp: async () => active.tip, bitcoin: { blockHash: async () => active.tip.hash }
}) } });
mock.module('../prod/ethereum.mjs', { exports: { createEthereum: async () => ({ rpc: () => assert.fail('unexpected Ethereum read'), escrow: {} }) } });
mock.module('../prod/trac.mjs', { exports: { configuredTrac: async () => {
  const trac = async (method, args) => {
    if (method === 'rulesContext') return active.context;
    if (method === 'head') return { counted: '100', tip: active.tip };
    if (method === 'authority') return active.reads.authority();
    if (['read', 'record'].includes(method) && /^(k\/)?link\//.test(args[0])) return null;
    assert.fail('unexpected Trac read ' + method);
  };
  trac.close = async () => {}; return trac;
} } });
const { productionReads } = await import('../prod/reads.mjs');

for (const imported of [false, true]) test(`production mint reader authenticates ${imported ? 'imported p0' : 'pure p2'} finds and deployment definitions`, async t => {
  const f = await provisioningFixture(t), { config } = await configFixture(t);
  const asset = imported ? 'p0' : 'p2:1', catalogAsset = imported ? 'p2:0' : asset, number = catalogAsset.slice(3);
  const definition = { ...f.pattern, number: Number(number), name: imported ? 'dmwflorite' : 'dmwnullspar', tier: 1 };
  const pattern = { ...definition, number, key: r.hash('reader-pattern-' + asset), ...(imported ? { legacy: { asset, record: definition } } : {}) };
  const document = r.settingsRevision({ network: f.network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
  const named = r.emptyNamedDiscovery();
  named.records = r.namedSet(r.namedSet(named.records, 'number/' + number, pattern.key), 'pattern/' + pattern.key, pattern);
  const saved = new r.NamedStorage({ get: () => undefined, cacheSize: 8 }).save(named);
  const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: '100' } }, '100'), claims = new r.ClaimStorage({ get: () => undefined, cacheSize: 8 });
  const hot = claims.load({ ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot) });
  const find = { asset, block: '1', pattern: number, finder: definition.discoverer, count: '3', findHeight: '90', finderUntil: '200', settingsHash: r.hashObject(document) };
  hot.finds = r.recordSet(hot.finds, r.findIdV2('1', number), find);
  const claim = claims.save(hot);
  await f.store.transact([...saved.writes, ...claim.writes,
    { space: 'assetCheckpoint', id: 'current', value: { named: saved.snapshot, claims: claim.state.claimSnapshot } },
    { space: 'patternsByAsset', id: catalogAsset, value: pattern }]);
  await writeFile(f.registryPath, JSON.stringify({ assets: {}, feePolicy: createFeePolicy('100') }));
  const job = await f.complete(asset, definition);
  await migrateRegistry(f.registryPath);
  active = { reads: f.reads, tip: { height: 100, hash: r.hash('block/100') }, context: { ready: true,
    catalogRoot: r.namedStateRoot(named), claimsRoot: claim.state.claimRoot, settings: document } };
  config.network = f.network;
  config.v2 = { document, resources: r.resourceRevision({ operator: 'test', values: { ...r.RESOURCE_PROFILE } }) };
  config.prod.registry = f.registryPath; config.prod.warmReads = false;
  const reads = await productionReads(config, f.store); t.after(() => reads.close());
  for (const name of ['element', 'privilegeAuthority', 'included']) reads[name] = f.reads[name];
  reads.bindings.resolve = async () => null;
  const result = await reads.assetContext(asset, '1', 'tap');
  assert.deepEqual(result.find, find); assert.equal(result.deployment.id, job.entry.id);
  assert.equal(result.beneficiaries.finder, definition.discoverer); assert.ok(result.assetRevision);
  // Registry hints cannot substitute another definition for the accepted one.
  await updateRegistryAsset(f.registryPath, asset, entry => ({ ...entry, pattern: { ...entry.pattern, pat: '999' } }));
  await assert.rejects(reads.assetContext(asset, '1', 'tap'), /asset_provenance_deployment/);
});
