import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createFeePolicy } from '../../src/fees.mjs';
import { migrateRegistry, readRegistry } from '../../src/registry.mjs';
import { Store } from '../../src/store.mjs';
import { edPublic } from '../../src/util.mjs';
import { NETWORK } from '../../../deploy/host-157/state.mjs';
import { rules } from '../../src/rules.mjs';

mock.module('../../src/deployments.mjs', { exports: { verifyDeployment: async () => ({
  inclusion: { height: 100 }, authorityKey: 'committee', deployment: { max: '100', lim: '0' }
}) } });
const { syncRegistry, registryReply, HOST_REGISTRY_CAPACITY, HOST_REGISTRY_REQUEST_TIMEOUT_MS, HOST_REGISTRY_WARM_WAIT_MS } = await import('../../../deploy/host-157/registry.mjs');
const { jsonRequest } = await import('../../../deploy/host-157/admission.mjs');
const { installCapacitySources } = await import('../../src/financial-capacity-sources.mjs');
const { buildFinancialExecution } = await import('../../src/financial-execution.mjs');
const { verifyFinancialExecution } = await import('../../../committee/signer/financial-execution.mjs');

async function fixture(t, count, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'registry-warmup-'))), opened = [];
  t.after(async () => { for (const reads of opened) await reads.close?.(); await store?.close(); await rm(root, { recursive: true, force: true }); });
  const gatewayState = join(root, 'gateway'), signerState = join(root, 'signer');
  for (const dir of [gatewayState, signerState]) await mkdir(dir, { mode: 0o700 });
  const identity = Buffer.alloc(32, 51), gateway = Buffer.alloc(32, 52), member = { id: 'one', identity: edPublic(identity) };
  const pinned = { feePolicy: createFeePolicy('100'), operator: { provisioning: { privilege: 'authority' } }, assets: {} };
  const assets = Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const asset = 'c' + i, entry = { asset, id: rules.hash(asset) + 'i0', kind: 'compound', network: NETWORK,
      authorityKey: 'committee', privilege: 'authority', tick: asset, receiver: 'maker-wallet',
      tap: { treasury: 'tap-treasury' }, ethereum: { treasury: 'eth-treasury' } };
    return [asset, entry];
  }));
  const publicConfig = { registry: pinned, gatewayKey: edPublic(gateway), committee: { publicKey: 'committee' },
    owner: { treasury: { tap: 'tap-treasury', ethereum: 'eth-treasury' } } };
  for (const [state, entries] of [[gatewayState, assets], [signerState, {}]]) {
    const path = join(state, 'registry.json');
    await writeFile(path, JSON.stringify({ ...pinned, assets: entries }), { mode: 0o600 }); await migrateRegistry(path);
  }
  const store = await Store.open(join(root, 'accounts'));
  const document = rules.settingsRevision({ network: NETWORK, effectiveBatch: '1', effectiveBitcoinWindow: '10',
    values: { ...rules.SETTINGS_PROFILE, mintOperationBudget: Math.max(32, count) } });
  const sources = state => {
    const reads = { registry: () => readRegistry(join(state, 'registry.json')), financialRecord: async () => null,
      authority: async () => ({ committee: 'committee' }), tap: async () => '100', counted: async () => 10,
      store: { get: async space => { assert.equal(space, 'types'); return { firstMaker: rules.hash('maker') }; } },
      bindings: { resolve: async () => ({ request: { address: 'maker-wallet' } }) } };
    installCapacitySources(reads, { network: NETWORK });
    reads.financialEvidence = t => reads.financialCapacityEvidence(t.action);
    return reads;
  };
  const local = sources(gatewayState), reads = sources(signerState); opened.push(reads);
  const calls = [], reply = body => registryReply({ state: gatewayState, roster: [member] }, publicConfig, body, gateway);
  await syncRegistry({ state: signerState }, { id: 'one', public: publicConfig, registryWarmWaitMs: 0, ...options.config }, reads, identity,
    async (body, transport) => { calls.push(body.query); return options.request ? options.request(body, transport, reply) : reply(body); });
  const transitions = [];
  for (const asset of Object.keys(assets)) {
    const { id, action } = await local.financialDeployment(asset);
    transitions.push({ type: 'lifecycle', id, action });
  }
  const build = (reader = local, extra = {}) => buildFinancialExecution({ store, reads: reader, transitions, document, height: 10, ...extra });
  const verify = files => verifyFinancialExecution({ files, reads, document, network: NETWORK, height: 10 });
  return { reads, local, transitions, calls, assets, build, verify, document, root };
}

for (const count of [40, 80]) test(`one refused signer attempt warms all ${count} assets across observation files`, async t => {
  const f = await fixture(t, count), normal = await f.build();
  const split = Math.floor(count / 2), files = [normal.inputs.slice(0, split), normal.inputs.slice(split)].map(inputs =>
    ({ ops: inputs.flatMap(i => i.operations), financialOperations: inputs }));
  const bytes = Buffer.from(rules.stableJSON(files));
  await assert.rejects(f.verify(files), { message: 'host_registry_warming', status: 503, retryAfterMs: 1000 });
  assert.equal(f.reads.registrySync.status().length, count, 'the first refusal schedules the entire proposal');
  await f.reads.registrySync.drain();
  assert.equal(f.calls.length, count);
  assert.ok(f.reads.registrySync.status().every(row => row.ready), JSON.stringify(f.reads.registrySync.status()));
  await f.verify(files);
  assert.deepEqual(Buffer.from(rules.stableJSON(files)), bytes, 'verification leaves the proposal bytes unchanged');
  const warmed = await f.build(f.reads);
  assert.equal(rules.stableJSON(warmed), rules.stableJSON(normal), 'warm-up changes no evidence, operations, commitments, roots or writes');
  assert.equal(f.calls.length, count, 'the next attempt reuses every ready key, including beyond the old 64-key limit');
  const forged = structuredClone(files); forged[0].financialOperations[0].evidence.confirmations++;
  await assert.rejects(f.verify(forged), /financial_evidence_read/, 'warming never substitutes for independent evidence');
});

test('a cold signer waits for its warm-up and verifies the proposal on the first attempt', async t => {
  const f = await fixture(t, 40, { config: { registryWarmWaitMs: HOST_REGISTRY_WARM_WAIT_MS } }), normal = await f.build();
  const files = [{ ops: normal.inputs.flatMap(i => i.operations), financialOperations: normal.inputs }];
  await f.verify(files);
  assert.equal(f.calls.length, 40);
  assert.ok(f.reads.registrySync.status().every(row => row.ready));
  const forged = structuredClone(files); forged[0].financialOperations[0].evidence.confirmations++;
  await assert.rejects(f.verify(forged), /financial_evidence_read/, 'waiting never substitutes for independent evidence');
});

test('a warm-up that outlasts the wait still refuses explicitly', async t => {
  const f = await fixture(t, 2, { config: { registryWarmWaitMs: 200 }, request: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(f.reads.ensureRegistryAsset('c0'), /host_registry_warming/);
  assert.ok(Date.now() - started >= 200);
});

test('strict and deferred financial builders discover the entire cold set', async t => {
  const f = await fixture(t, 40);
  await assert.rejects(f.build(f.reads), /host_registry_warming/);
  assert.equal(f.reads.registrySync.status().length, 40);
  await f.reads.registrySync.drain();
  assert.equal((await f.build(f.reads)).inputs.length, 40);
  const g = await fixture(t, 40, { request: async (_body, _options, _reply) => { throw Error('host_registry_unavailable'); } });
  const deferred = await g.build(g.reads, { defer: true });
  assert.equal(g.reads.registrySync.status().length, 40);
  assert.equal(deferred.inputs.length, 0);
  assert.equal(deferred.deferred.length, 40);
  assert.ok(deferred.deferred.every(row => row.reason === 'host_registry_warming'));
});

test('oversized warm-up fails explicitly before evicting or scheduling any key', async t => {
  const f = await fixture(t, 1), queries = Array.from({ length: HOST_REGISTRY_CAPACITY + 1 }, (_, i) => ({ asset: 'c' + i }));
  await assert.rejects(f.reads.ensureRegistryAssets(queries), /host_registry_capacity/);
  assert.deepEqual(f.reads.registrySync.status(), []); assert.equal(f.calls.length, 0);
  await assert.rejects(f.reads.ensureRegistryAssets(Array(100).fill({ asset: 'c0' })), /host_registry_warming/);
  await f.reads.registrySync.drain();
  await f.reads.ensureRegistryAssets([{ asset: 'c0' }]); assert.equal(f.calls.length, 1);
});

test('a full cache evicts unrelated jobs while retaining every ready key in the next proposal', async t => {
  const f = await fixture(t, 2, { request: (body, _options, reply) => {
    if (body.query.deploymentId?.startsWith('missing-')) throw Error('host_registry_unavailable');
    return reply(body);
  } });
  const needed = [{ asset: 'c0' }, { asset: 'c1' }];
  await assert.rejects(f.reads.ensureRegistryAssets(needed), /host_registry_warming/);
  await f.reads.registrySync.drain();
  const fillers = Array.from({ length: HOST_REGISTRY_CAPACITY - 2 }, (_, i) => ({ asset: 'c0', deploymentId: 'missing-' + i }));
  await assert.rejects(f.reads.ensureRegistryAssets(fillers), /host_registry_warming/);
  await f.reads.registrySync.drain();
  assert.equal(f.reads.registrySync.status().length, HOST_REGISTRY_CAPACITY);
  const next = [...needed, { asset: 'c0', deploymentId: f.assets.c0.id }];
  await assert.rejects(f.reads.ensureRegistryAssets(next), /host_registry_warming/);
  await f.reads.registrySync.drain();
  await f.reads.ensureRegistryAssets(next);
  assert.equal(f.calls.filter(q => q.deploymentId === null).length, 2, 'both current keys stay warm');
  assert.equal(f.reads.registrySync.status().length, HOST_REGISTRY_CAPACITY);
});

test('a stalled gateway response body times out, cancels the socket, and retries', async t => {
  let attempts = 0, cancelled = false, reply;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (++attempts === 1) {
      res.on('close', () => { cancelled = true; }); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return;
    }
    try { res.end(JSON.stringify(await reply(JSON.parse(Buffer.concat(chunks))))); }
    catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const f = await fixture(t, 1, { config: { registryRequestTimeoutMs: 200 }, request: (body, options, gatewayReply) => {
    reply = gatewayReply; return jsonRequest(url, { body, ...options });
  } });
  await assert.rejects(f.reads.ensureRegistryAsset('c0'), /host_registry_warming/);
  await f.reads.registrySync.drain();
  assert.deepEqual(f.reads.registrySync.status(), [{ asset: 'c0', ready: false, reason: 'host_registry_timeout' }]);
  await delay(1100);
  assert.ok(cancelled, 'timeout closes the incomplete response');
  await assert.rejects(f.reads.ensureRegistryAsset('c0'), /host_registry_warming/);
  await f.reads.registrySync.drain();
  await f.reads.ensureRegistryAsset('c0'); assert.equal(attempts, 2);
});

test('closing registry synchronization cancels pending requests and skips queued jobs', async t => {
  let active;
  const f = await fixture(t, 8, { request: (_body, { signal }) => new Promise((_resolve, reject) => {
    active = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await assert.rejects(f.build(f.reads), /host_registry_warming/);
  await f.reads.registrySync.close(); assert.ok(active.aborted); assert.equal(f.calls.length, 4);
  await assert.rejects(f.reads.ensureRegistryAsset('c0'), /host_registry_closed/);
});

test('a transport that ignores cancellation cannot keep a job pending or publish a late reply', async t => {
  let release, finish;
  const blocked = new Promise(resolve => { release = resolve; });
  const finished = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, 1, { config: { registryRequestTimeoutMs: 25 }, request: async (body, _options, reply) => {
    try { await blocked; return await reply(body); } finally { finish(); }
  } });
  try {
    await assert.rejects(f.reads.ensureRegistryAsset('c0'), /host_registry_warming/);
    await f.reads.registrySync.drain();
    assert.equal(f.reads.registrySync.status()[0].reason, 'host_registry_timeout');
  } finally { release(); await finished; }
  assert.equal((await f.reads.registry()).asset('c0'), null);
  assert.equal(f.reads.registrySync.status()[0].ready, false);
});

test('registry request deadline has a bounded default and rejects invalid overrides', async () => {
  assert.equal(HOST_REGISTRY_REQUEST_TIMEOUT_MS, 15000);
  for (const registryRequestTimeoutMs of [0, -1, 600001, Infinity, '15000'])
    await assert.rejects(syncRegistry({}, { registryRequestTimeoutMs }, {}, null, () => {}), /host_registry_settings/);
});
