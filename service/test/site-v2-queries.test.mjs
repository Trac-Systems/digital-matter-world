import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { lists, requests } from './site-v2-query-fixture.mjs';
import { temp } from './helpers.mjs';

// Every read the public site's views make, as the views build them: each list with every sort and every
// filter option. The v2 read API (the server's own validation) must accept all of them. Keep this table in
// step with the views; the count below fails when a list is added or removed without it.
// pagedTable calls per served file; agents.js has two more in "Hunting now", which only the console shows.
const pagedTables = { 'playground/console/js/views/world.js': 4, 'playground/console/js/views/table.js': 4, 'playground/console/js/views/agents.js': 8,
  'playground/console/js/views/feed.js': 1, 'playground/console/js/views/results.js': 1, 'service/public/web/records.js': 6, 'service/public/web/money.js': 2 };
test('the table covers every paged list on the public pages', () => {
  for (const [file, n] of Object.entries(pagedTables)) assert.equal(readFileSync(new URL('../../' + file, import.meta.url), 'utf8').split('pagedTable({').length - 1, n, file);
});

test('every read the public site makes is a valid v2 query', async t => {
  const root = await temp(), store = await Store.open(root);
  t.after(() => store.close());
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '100' });
  await store.put('meta', 'head', { tip: '100', hash: 'tip' });
  const api = createPublicAPI({ views: { store }, files: new Files(join(root, 'static')) });
  const refused = [];
  for (const list of lists) for (const path of requests(list)) {
    try { await api.read(path); }
    // A named record missing from this empty store is not a query error; anything else, 5xx included, is.
    catch (e) { if (!/^(batch|block|event)_not_found$/.test(e.message)) refused.push(`${list.at}: ${path} → ${e.message}`); }
  }
  assert.deepEqual(refused, []);
});
