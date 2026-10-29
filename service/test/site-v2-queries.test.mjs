import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { temp, agent } from './helpers.mjs';

// Every read the public site's views make, as the views build them: each list with every sort and every
// filter option. The v2 read API (the server's own validation) must accept all of them. Keep this table in
// step with the views; the count below fails when a list is added or removed without it.
const me = encodeTracAddress(agent(3).address), H = 5;
const lists = [
  // world.js
  { at: 'world.js map', path: '/world/map?from=0&to=100' },
  { at: 'world.js refresh', path: `/world?from=${H}&to=${H}` },
  { at: 'world.js claims', path: '/feed?type=claim&sort=sequence&order=desc&limit=200' },
  { at: 'world.js block', path: `/blocks/${H}` },
  // Without a connected player the panel reads no rights: v2 lists one owner's rights only.
  { at: 'world.js mint rights', path: `/blocks/${H}/mintRights?owner=${me}`, limit: 8 },
  { at: 'world.js matches', path: `/blocks/${H}/matches`, limit: 8 },
  { at: 'world.js claims', path: `/blocks/${H}/claims`, limit: 8, sorts: ['agent:asc', 'window:desc'], filters: { header: ['', 'true'] } },
  { at: 'world.js draws', path: `/blocks/${H}/draws`, limit: 3 },
  // table.js
  { at: 'table.js patterns', path: '/patterns', limit: 60, sorts: ['number:asc', 'rarity:asc', 'tier:desc', 'supply:desc', 'minted:desc', 'name:asc'], filters: { tier: ['', '1', '2', '3', '4', '5'] } },
  { at: 'table.js compounds', path: '/compounds', limit: 10, sorts: ['supply:desc', 'tier:desc', 'name:asc'], filters: { tier: ['', '1', '2', '3', '4', '5'] } },
  { at: 'table.js pattern blocks', path: '/patterns/p2:0/claimed-blocks', limit: 25, sorts: ['block:desc', 'block:asc'], filters: { found: ['', 'true', 'false'], minted: ['', 'true', 'false'] } },
  { at: 'table.js lookup', path: '/patterns?asset=p2%3A0&limit=1' },
  { at: 'table.js lookup', path: '/compounds?asset=c2%3A0&limit=1' },
  // agents.js
  { at: 'agents.js leaderboard', path: '/agents?q=trac', limit: 20, sorts: ['finds:desc', 'discoveries:desc', 'crafts:desc', 'mints:desc', 'address:asc'] },
  { at: 'agents.js profile', path: `/agents/${me}?limit=1` },
  { at: 'agents.js balances', path: `/agents/${me}/balances?nonzero=true`, limit: 10, sorts: ['asset:asc', 'amount:desc'] },
  { at: 'agents.js sealed', path: `/agents/${me}/discoveries?state=sealed&limit=1&sort=opensAt&order=asc` },
  { at: 'agents.js discoveries', path: `/agents/${me}/discoveries?state=accepted`, limit: 5, sorts: ['name:asc'] },
  { at: 'agents.js history', path: `/agents/${me}/history`, limit: 10, sorts: ['sequence:desc', 'sequence:asc'], filters: { category: ['', 'chain', 'money'] } },
  { at: 'agents.js first made', path: `/compounds?firstMaker=${me}`, limit: 5, sorts: ['supply:desc', 'name:asc'] },
  { at: 'agents.js made real', path: `/results/mints?owner=${me}&state=minted`, limit: 5, sorts: ['block:desc', 'price:desc'] },
  { at: 'agents.js names', path: '/patterns?asset=p0&limit=1' },
  // feed.js and the live stream (api.js)
  { at: 'feed.js history', path: '/feed', limit: 50, sorts: ['sequence:desc', 'sequence:asc'] },
  { at: 'feed.js history', path: '/feed?category=chain', limit: 50, sorts: ['sequence:desc', 'sequence:asc'] },
  { at: 'feed.js history', path: '/feed?category=money', limit: 50, sorts: ['sequence:desc', 'sequence:asc'] },
  { at: 'feed.js retained', path: '/feed?limit=1' },
  { at: 'api.js stream', path: '/feed?limit=200&order=desc' },
  { at: 'api.js stream', path: '/feed?since=0&order=asc&limit=200' },
  { at: 'api.js patterns', path: '/patterns?limit=200' },
  // results.js
  { at: 'results.js summary', path: '/results' },
  { at: 'results.js mints', path: '/results/mints', limit: 25, sorts: ['id:desc', 'block:desc', 'price:desc', 'asset:asc'], filters: { kind: ['', 'tap', 'ethereum'], state: ['', 'awaiting_payment', 'partly_paid', 'permit_issued', 'minted', 'expired'] } },
  { at: 'results.js payments', path: '/results/payments', limit: 25, sorts: ['block:desc', 'total:desc'], filters: { action: ['', 'claim', 'refund'] } },
  { at: 'results.js ethereum', path: '/results/ethereum', limit: 25, sorts: ['id:desc', 'amount:desc'] },
  { at: 'results.js payouts', path: '/results/payouts', limit: 25, sorts: ['owed:desc', 'accrued:desc', 'beneficiary:asc'] },
  { at: 'results.js owed', path: '/results/owed', limit: 25, sorts: ['amount:desc', 'role:asc'], filters: { role: ['', 'discoverer', 'landowner'] } },
  { at: 'results.js paid', path: '/results/paid', limit: 25 },
  { at: 'results.js links', path: '/results/links', limit: 25, sorts: ['block:desc', 'linkHeight:desc'] },
  // records.js
  { at: 'records.js rarest', path: '/patterns', limit: 10, sorts: ['rarity:asc', 'rarity:desc'] },
  { at: 'records.js compounds', path: '/compounds', limit: 10, sorts: ['tier:desc', 'supply:desc', 'madeReal:desc'] },
  { at: 'records.js discoverers', path: '/agents', limit: 10, sorts: ['discoveries:desc', 'finds:desc'] },
  { at: 'records.js finds', path: '/finds', limit: 10, sorts: ['findHeight:desc', 'count:desc'] },
  { at: 'records.js batches', path: '/records/batches', limit: 10 },
  { at: 'records.js receipts', path: '/receipts', limit: 10 },
  // /records/highlights is the site's own read (web.mjs), not the public API.
  { at: 'records.js batch', path: '/records/batches/1' },
  // money.js (Mint & wallets) reads only /public-mints, covered by the public mint API's own tests.
];
// What pagedTable sends (paged.js): limit, then sort/order, then each non-empty filter.
function requests({ path, limit, sorts = [], filters = {} }) {
  if (limit === undefined) return [path];
  const one = (sort, values) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (sort) { const [k, o] = sort.split(':'); params.set('sort', k); if (o) params.set('order', o); }
    for (const [k, v] of Object.entries(values)) if (v !== '') params.set(k, v);
    return `${path}${path.includes('?') ? '&' : '?'}${params}`;
  };
  const defaults = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, v[0]]));
  const out = (sorts.length ? sorts : [null]).map(s => one(s, defaults));
  for (const [k, options] of Object.entries(filters)) for (const v of options) out.push(one(sorts[0], { ...defaults, [k]: v }));
  return [...new Set(out)];
}

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
