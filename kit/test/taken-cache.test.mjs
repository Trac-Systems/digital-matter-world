import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '../lib/agent.mjs';
import { TakenCache } from '../lib/taken-cache.mjs';
import { Journal } from '../lib/journal.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { Store } from '../../service/src/store.mjs';
import { createPublicAPI } from '../../service/src/public-api.mjs';
import { serve } from '../../service/src/http.mjs';
import { rules } from '../../service/src/rules.mjs';
import { temp, cleanup } from './helpers.mjs';

const patterns = [0, 1].map(number => ({ number, key: 'ab'.repeat(32) }));
const row = (asset, block, found = true) => ({ space: 'claimed2/' + asset, id: rules.uintKeyV2(String(block)),
  value: { height: String(block), pattern: asset.slice(3), count: '1', found, minted: false } });
async function fixture(t, { pageRows = 4096, changeRows = 16384, maxRequests = 32 } = {}) {
  const directory = await temp(t), store = await Store.open(join(directory, 'gateway'), { takenChangeRows: changeRows });
  cleanup(t, () => store.close()); await store.put('meta', 'ruleState', { batchVersion: 2, counted: '0' });
  const publicAPI = createPublicAPI({ views: { store }, files: {}, settings: { takenPageRows: pageRows } });
  const http = await serve({ publicAPI, files: { serve: async () => false } }); cleanup(t, () => http.close());
  const calls = [], service = new ServiceClient({ origin: http.url, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET'); calls.push(new URL(url).pathname + new URL(url).search); return fetch(url, options);
  } });
  const journal = await Journal.open(directory, 'test-signer'); cleanup(t, () => journal.close());
  const makeAgent = () => ({ service, network: 'test-network', journal, miningReads: { maxRequests } });
  const agent = makeAgent(), taken = () => Agent.prototype.takenSlots.call(agent, patterns);
  return { directory, store, service, journal, agent, makeAgent, taken, calls };
}

test('mining caches in the signer directory, resumes after restart and preserves journal formats', async t => {
  const f = await fixture(t);
  await f.store.transact([row('p2:0', 5), row('p2:1', 2), row('p2:0', 3, false)]);
  const journalBytes = await readFile(join(f.directory, 'journal.sqlite'));
  assert.deepEqual(await f.taken(), { 0: new Set([5]), 1: new Set([2]) });
  assert.equal(f.calls.length, 1);
  assert.equal((await stat(f.agent.takenCache.path)).mode & 0o777, 0o600);
  assert.equal(f.agent.takenCache.path.startsWith(f.directory + '/taken-slots-'), true);
  f.calls.length = 0;
  const restarted = f.makeAgent();
  assert.deepEqual(await Agent.prototype.takenSlots.call(restarted, patterns), { 0: new Set([5]), 1: new Set([2]) });
  assert.equal(f.calls.length, 1); assert.match(f.calls[0], /since=/);
  await f.store.transact([row('p2:0', 3), row('p2:1', 2, false), row('p2:2', 9)]);
  f.calls.length = 0;
  assert.deepEqual(await f.taken(), { 0: new Set([5, 3]), 1: new Set() });
  assert.equal(f.calls.length, 1);
  // A new catalog pattern already has its slots in the shared global cache.
  assert.deepEqual(await Agent.prototype.takenSlots.call(restarted, [...patterns, { number: 2, key: 'ab'.repeat(32) }]),
    { 0: new Set([5, 3]), 1: new Set(), 2: new Set([9]) });
  assert.deepEqual(await readFile(join(f.directory, 'journal.sqlite')), journalBytes);
});

test('large snapshots and delta backlogs stop at the pass budget and persist safe progress', async t => {
  const f = await fixture(t, { pageRows: 1, maxRequests: 2 });
  await f.store.transact([row('p2:0', 1), row('p2:0', 2), row('p2:1', 3)]);
  assert.equal(await f.taken(), null); assert.equal(f.calls.length, 2);
  f.calls.length = 0;
  const restarted = f.makeAgent();
  assert.deepEqual(await Agent.prototype.takenSlots.call(restarted, patterns), { 0: new Set([1, 2]), 1: new Set([3]) });
  assert.equal(f.calls.length, 1); assert.match(f.calls[0], /cursor=/);
  await f.store.transact([row('p2:0', 4), row('p2:0', 5), row('p2:0', 6)]);
  f.calls.length = 0;
  assert.equal(await f.taken(), null); assert.equal(f.calls.length, 2);
  f.calls.length = 0;
  assert.deepEqual(await f.taken(), { 0: new Set([1, 2, 4, 5, 6]), 1: new Set([3]) });
  assert.equal(f.calls.length, 1);
});

test('expired revisions rebuild once with the same bounded request allowance', async t => {
  const f = await fixture(t, { pageRows: 1, changeRows: 1, maxRequests: 2 });
  await f.store.transact([row('p2:0', 1)]); await f.taken();
  await f.store.transact([row('p2:0', 2), row('p2:0', 3)]);
  f.calls.length = 0;
  assert.equal(await f.taken(), null);
  assert.equal(f.calls.length, 2); assert.match(f.calls[0], /since=/); assert.equal(f.calls[1], '/patterns/taken');
  f.calls.length = 0;
  assert.deepEqual(await f.taken(), { 0: new Set([1, 2, 3]), 1: new Set() });
  assert.equal(f.calls.length, 2);
});

test('a snapshot changing between pages never exposes partial or stale exclusions', async t => {
  const f = await fixture(t, { pageRows: 1, maxRequests: 2 });
  await f.store.transact([row('p2:0', 1), row('p2:0', 2), row('p2:1', 3)]);
  assert.equal(await f.taken(), null);
  await f.store.transact([row('p2:0', 1, false), row('p2:0', 0)]);
  f.calls.length = 0;
  assert.equal(await f.taken(), null); assert.equal(f.calls.length, 2);
  assert.deepEqual(await f.taken(), { 0: new Set([0, 2]), 1: new Set([3]) });
});

test('cache checksum corruption rebuilds and cache scope separates gateways/signers', async t => {
  const f = await fixture(t);
  await f.store.transact([row('p2:0', 1)]); await f.taken();
  const saved = JSON.parse(await readFile(f.agent.takenCache.path)); saved.data.slots = [];
  await writeFile(f.agent.takenCache.path, JSON.stringify(saved)); f.calls.length = 0;
  assert.deepEqual(await f.taken(), { 0: new Set([1]), 1: new Set() });
  assert.equal(f.calls[0], '/patterns/taken');
  const separate = new TakenCache({ directory: f.directory, scope: 'another signer or gateway', service: f.service });
  assert.notEqual(separate.path, f.agent.takenCache.path);
  f.calls.length = 0; await separate.sync(patterns); assert.equal(f.calls[0], '/patterns/taken');
});

test('bad chains, unsafe heights and uncertain reads preserve the last valid cache and do not fall back to scans', async t => {
  const f = await fixture(t);
  await f.store.transact([row('p2:0', 1)]); await f.taken();
  const original = await readFile(f.agent.takenCache.path), real = f.service.fetchImpl;
  for (const [status, code] of [[429, 'read_request_rate'], [503, 'service_busy'], [503, 'public_projection_pending'], [404, 'not_found']]) {
    let requests = 0;
    f.service.fetchImpl = async () => { requests++; return Response.json({ error: code }, { status, headers: { 'Retry-After': '4' } }); };
    await assert.rejects(f.taken(), error => status === 404 ? error.code === 'taken_reads_unavailable' : error.status === status && error.retryAfterMs === 4000);
    assert.equal(requests, 1); assert.deepEqual(await readFile(f.agent.takenCache.path), original);
  }
  let requests = 0;
  f.service.fetchImpl = async () => { requests++; throw Object.assign(Error('socket closed'), { code: 'ECONNRESET' }); };
  await assert.rejects(f.taken()); assert.equal(requests, 1);
  await f.store.transact([row('p2:0', 2)]);
  f.service.fetchImpl = async (url, options) => {
    const page = await (await real(url, options)).json(); page.changes[0][1] = '999'; return Response.json(page);
  };
  await assert.rejects(f.taken(), /Broken taken revision chain/);
  assert.deepEqual(await readFile(f.agent.takenCache.path), original);
  f.service.fetchImpl = real;
  assert.deepEqual(await f.taken(), { 0: new Set([1, 2]), 1: new Set() });
  await f.store.transact([row('p2:0', '9007199254740992')]);
  await assert.rejects(f.taken(), /adapter_integer_capability/);
});

test('runOnce sends the header while catching up, never runs strategy on partial data, and resumes saved selections', async () => {
  let strategies = 0, syncs = 0, headers = 0, saved = null;
  const agent = { trac: { head: async () => ({ tip: { height: 10 }, counted: 10 }), hashAt: async () => 'ab'.repeat(32), settings: async () => ({ claimsPerWindow: 1 }) },
    catalog: async () => patterns, service: { latest: async () => ({ summary: {} }), publication: async () => ({ tip: '10', height: '10', tipHash: 'ab'.repeat(32) }) },
    journal: { get: () => saved }, takenSlots: async () => { syncs++; return null; }, postHeader: async () => { headers++; return { state: 'dry-run', action: 'header' }; },
    claim: async ({ plots }) => ({ plots }) };
  const args = { history: { length: 11, get: () => ({ hash: 'ab'.repeat(32) }), raw: () => '00' }, strategy: () => { strategies++; return []; } };
  const result = await Agent.prototype.runOnce.call(agent, args);
  assert.equal(result.claimState, 'taken_syncing'); assert.equal(headers, 1); assert.equal(strategies, 0); assert.equal(syncs, 1);
  saved = { body: { p: { plots: [{ block: '1', patterns: ['0'] }], header: { height: '10', raw: '00' } } } };
  assert.deepEqual((await Agent.prototype.runOnce.call(agent, args)).plots, [{ block: 1, patterns: [0] }]);
  assert.equal(syncs, 1); assert.equal(strategies, 0);
});
