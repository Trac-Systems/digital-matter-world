import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '../lib/agent.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { TakenCache } from '../lib/taken-cache.mjs';
import { chooseClaims } from '../strategies/default.mjs';
import { Store } from '../../service/src/store.mjs';
import { createPublicAPI } from '../../service/src/public-api.mjs';
import { serve } from '../../service/src/http.mjs';
import { fillTaken, takenSchema } from '../../service/src/taken-index.mjs';
import { rules } from '../../service/src/rules.mjs';
import { temp, cleanup } from './helpers.mjs';

test('100000 claimed slots across five patterns: identical choices with bounded incremental GETs', { timeout: 120000 }, async t => {
  const directory = await temp(t), store = await Store.open(join(directory, 'gateway'));
  cleanup(t, () => store.close()); await store.put('meta', 'ruleState', { batchVersion: 2, counted: '25000' });
  const patterns = Array.from({ length: 5 }, (_, number) => ({ number, key: 'ab'.repeat(32), name: 'digits' + number,
    pat: '[0-9]', fld: 4, dt: 'n', knownMatchCount: '20000' }));
  // Seed an existing database without timing 100,000 journal submissions. The
  // normal SQL triggers build the old claimed-block index; the actual startup
  // migration then builds the new read index from those same persisted rows.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const pattern of patterns) for (let block = 0; block < 20000; block++) {
      const asset = 'p2:' + pattern.number, height = String(block), number = String(pattern.number);
      store.putStmt.run('claimed2/' + asset, rules.uintKeyV2(height), JSON.stringify({ height, pattern: number,
        hash: 'ab'.repeat(32), count: '1', found: true, minted: false, contribution: null, provenance: null }));
      store.putStmt.run('finds', rules.findIdV2(height, number), JSON.stringify({ block: height, pattern: number, asset,
        finder: 'cd'.repeat(32), count: '1', findHeight: '25000', finderUntil: '26008' }));
    }
    store.db.exec('DELETE FROM takenControl; DELETE FROM takenSlots; DELETE FROM takenChanges; COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  takenSchema(store.db); await fillTaken(store);
  const publicAPI = createPublicAPI({ views: { store }, files: {} });
  // Baseline deliberately sends the old 2,000-request burst. The limiter is
  // covered separately; disable it only on this disposable loopback benchmark.
  const http = await serve({ publicAPI, files: { serve: async () => false }, readBudget: { enabled: false } });
  cleanup(t, () => http.close()); let requests = 0, bytes = 0;
  const service = new ServiceClient({ origin: http.url, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET'); requests++; const response = await fetch(url, options);
    bytes += Number(response.headers.get('content-length') ?? 0); return response;
  } });
  // Exact pre-change takenSlots traversal: five found=true collections, 50 rows.
  const baseline = {};
  for (const pattern of patterns) {
    const set = baseline[pattern.number] = new Set(); let cursor;
    do {
      const page = await service.readPage('/patterns/p2:' + pattern.number + '/claimed-blocks', { found: true, limit: 50, cursor });
      for (const row of page.rows) { assert.ok(row.found || row.minted); set.add(Number(row.block)); }
      cursor = page.nextCursor;
    } while (cursor);
  }
  const before = requests, beforeBytes = bytes; assert.equal(before, 2000);
  const agent = { service, network: 'scale-fixture', journal: { directory, scope: 'scale' } };
  requests = 0; bytes = 0;
  const cold = await Agent.prototype.takenSlots.call(agent, patterns), coldRequests = requests, coldBytes = bytes;
  assert.deepEqual(cold, baseline); assert.equal(coldRequests, 25);
  const history = { length: 25001, get: height => ({ height }) }, args = { history, patterns, claimsPerWindow: 100, claimableHeight: 25000, window: 25000 };
  assert.deepEqual(await chooseClaims({ ...args, taken: cold }), await chooseClaims({ ...args, taken: baseline }));
  requests = 0; bytes = 0;
  assert.deepEqual(await Agent.prototype.takenSlots.call(agent, patterns), baseline);
  const unchanged = requests, unchangedBytes = bytes; assert.equal(unchanged, 1);
  await store.transact(patterns.map(p => ({ space: 'claimed2/p2:' + p.number, id: rules.uintKeyV2('20000'),
    value: { height: '20000', pattern: String(p.number), found: true, count: '1' } })));
  for (const set of Object.values(baseline)) set.add(20000);
  requests = 0; bytes = 0;
  const updated = await Agent.prototype.takenSlots.call(agent, patterns), changed = requests, changedBytes = bytes;
  assert.deepEqual(updated, baseline); assert.equal(changed, 1);
  assert.deepEqual(await chooseClaims({ ...args, taken: updated }), await chooseClaims({ ...args, taken: baseline }));
  requests = 0;
  const restarted = { ...agent, takenCache: undefined };
  assert.deepEqual(await Agent.prototype.takenSlots.call(restarted, patterns), baseline);
  const restart = requests; assert.equal(restart, 1);
  const bounded = new TakenCache({ service, directory, scope: 'bounded-scale', settings: { maxRequests: 8 } }), catchup = [];
  let ready;
  do { requests = 0; ready = await bounded.sync(patterns); catchup.push(requests); assert.ok(requests <= 8); } while (!ready);
  assert.deepEqual(ready, baseline); assert.deepEqual(catchup, [8, 8, 8, 1]);
  t.diagnostic(JSON.stringify({ claimedSlots: 100000, patterns: 5, before, cold: coldRequests, unchanged, changed, restart,
    catchupWithEightRequestBudget: catchup, beforeBytes, coldBytes, unchangedBytes, changedBytes, cacheBytes: (await stat(agent.takenCache.path)).size }));
});
