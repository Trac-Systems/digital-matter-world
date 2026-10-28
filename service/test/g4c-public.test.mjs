import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Feeds } from '../src/feeds.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { PublicRegistry } from '../src/public-registry.mjs';
import { SubmittedBitmaps } from '../src/submitted-bitmaps.mjs';
import { rationalKey, rankingHighlights, expireRankings } from '../src/public-rankings.mjs';
import { migratePublicProjections } from '../scripts/migrate-public-projections.mjs';
import { rules } from '../src/rules.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { serve } from '../src/http.mjs';
import { temp, agent } from './helpers.mjs';

const owner = agent(3).address, address = encodeTracAddress(owner), other = agent(4).address;
const event = (number, block, discoverer = owner) => ({ height: String(block), tip: String(block),
  occurrences: [{ block: String(block), pattern: String(number), asset: 'p2:' + number, hash: rules.hash('header-' + block), count: '1', agent: discoverer }],
  discoveries: [{ record: { number: String(number), key: rules.hash('pattern-' + number), discoverer, knownMatchCount: '1', anchor: { height: String(block) }, catalogRevision: '1' } }] });
async function setup() {
  const root = await temp(), store = await Store.open(root), files = new Files(join(root, 'static'));
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '100' });
  const feeds = new Feeds({ store, files, history: { get() { throw Error('unnamed_header_read'); } }, reads: {}, settings: { feedEventRows: 1 } });
  const views = { store, patterns() { throw Error('catalog_scan'); }, rows() { throw Error('history_scan'); }, reads: new Proxy({}, { get() { throw Error('source_request'); } }) };
  return { root, store, files, feeds, api: createPublicAPI({ views, files }) };
}

test('scoped pending fences and cursors survive unrelated writes and restart', async () => {
  const f = await setup(); let { store } = f;
  try {
    await store.put('feedEvents', '1', event(0, 20)); while (store.count('feedEvents')) await f.feeds.events();
    const first = await f.api.response('/patterns/p2:0/claimed-blocks?limit=1');
    await store.put('jobs', 'unrelated', { state: 'waiting' });
    assert.equal(await f.api.response('/patterns/p2:0/claimed-blocks?limit=1'), first, 'serialized cache survives an unrelated journal write');
    await store.put('feedEvents', '2', event(1, 30, other)); await f.feeds.events();
    assert.equal((await f.api.read('/patterns/p2:0/claimed-blocks')).rows.length, 1);
    await assert.rejects(f.api.read('/patterns/p2:1/claimed-blocks'), /public_projection_pending/);
    const profile = await f.api.read('/agents/' + address); assert.equal(profile.discoveryCount, '1');
    await store.put('commissionOwed', 'one', { amount: '1' }); await store.put('commissionOwed', 'two', { amount: '2' });
    const p = await f.api.read('/payouts/owed?limit=1'); await store.put('jobs', 'second', true);
    await store.close(); store = await Store.open(f.root);
    const api = createPublicAPI({ views: { store }, files: f.files });
    assert.equal((await api.read('/payouts/owed?' + new URLSearchParams({ cursor: p.nextCursor }))).owed[0].id, 'two');
    await store.put('commissionOwed', 'three', { amount: '3' });
    await assert.rejects(api.read('/payouts/owed?' + new URLSearchParams({ cursor: p.nextCursor })), /cursor_stale/);
  } finally { await store.close(); }
});

test('owner-wide rights, submitted Bitmap inventory, results and maps never call a source', async () => {
  const f = await setup(), { store, api } = f;
  try {
    const snapshot = { height: '100', hash: rules.hash('tip') };
    await store.transact([{ space: 'meta', id: 'head', value: { tip: '100', hash: snapshot.hash } },
      { space: 'headers', id: '0000000000000100', value: { hash: snapshot.hash } },
      { space: 'publicDeployments', id: 'p2:0', value: { id: 'deployment', suspended: false } },
      { space: 'publicBalances', id: owner + '/p2:0', value: { owner, asset: 'p2:0', amount: '10' } }]);
    for (let i = 0; i < 5; i++) await store.put('finds', rules.findIdV2(String(i), '0'), { block: String(i), pattern: '0', asset: 'p2:0', count: '1', finder: i === 0 ? owner : other, findHeight: '10', finderUntil: i < 2 ? '200' : '50' });
    await store.put('links', '0000000000000002', { block: '2', linkHeight: '5' });
    let verifies = 0;
    const submitted = new SubmittedBitmaps({ store, verify: async block => { verifies++; return { block, agent: owner, address: 'public-wallet', inscription: 'a'.repeat(64) + 'i0', snapshot }; } });
    await submitted.submit({ block: '2' }); assert.equal(verifies, 1);
    const inventory = await api.read('/agents/' + address + '/bitmaps'); assert.equal(inventory.bitmaps[0].current, true); assert.equal(inventory.completeness, 'submitted_items_only');
    const rights = await api.read('/mint-rights?' + new URLSearchParams({ owner: address, allowed: 'true' }));
    assert.deepEqual(rights.mintRights.map(r => r.block), ['0', '2', '3', '4']); assert.equal(verifies, 1);
    await store.put('meta', 'head', { tip: '101', hash: rules.hash('next') });
    assert.equal((await api.read('/agents/' + address + '/bitmaps')).bitmaps[0].current, false);
    const stale = await api.read('/mint-rights?' + new URLSearchParams({ owner: address, block: '2' })); assert.equal(stale.mintRights[0].eligible, null);
    assert.equal((await api.read('/world/map?from=0&to=100&limit=2')).marks.length, 2);
    assert.equal((await api.read('/blocks/2/finds')).finds.length, 1);
    await store.put('publicResults/payments', 'paid', { id: 'paid', amount: '100', action: 'paid' });
    assert.equal((await api.read('/results/payments')).payments.length, 1);
    assert.equal((await api.read('/results')).collections.payments, '/results/payments');
    const query = store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM publicOrderV2 INDEXED BY publicOrderV2Asset WHERE kind=? AND scope=? AND sort=? AND asset=? AND (key,id)>(?,?) ORDER BY key,id LIMIT ?").all('finds', '', 'block', 'p2:0', '', '', 2);
    assert.match(JSON.stringify(query), /SEARCH.*publicOrderV2Asset/); assert.doesNotMatch(JSON.stringify(query), /TEMP B-TREE/);
  } finally { await store.close(); }
});

test('an imported-pattern find is indexed under its ledger asset and resolves as p0 and p2:0', async () => {
  const f = await setup(), { store, api } = f;
  try {
    const find = { block: '1', pattern: '0', asset: 'p0', count: '3', finder: owner, findHeight: '90', finderUntil: '200' };
    await store.transact([
      { space: 'patternsByAsset', id: 'p2:0', value: { number: '0', legacy: { asset: 'p0' } } },
      { space: 'finds', id: 'f2:1:0', value: find },
      { space: 'publicBalances', id: owner + '/p0', value: { owner, asset: 'p0', amount: '3' } }
    ]);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM publicRightsV2 WHERE asset='p0'").get().n, 1);
    const before = store.sequence;
    for (const asset of ['p0', 'p2:0']) {
      const page = await api.read('/mint-rights?' + new URLSearchParams({ owner: address, asset, block: '1' }));
      assert.equal(page.mintRights.length, 1); assert.equal(page.candidateWork, 1);
      const candidate = page.mintRights[0];
      assert.equal(candidate.asset, 'p0'); assert.equal(candidate.find.asset, 'p0');
      assert.equal(candidate.find.finder, address); assert.equal(candidate.rightAllowed, true);
      assert.equal(candidate.reason, 'asset_unregistered'); assert.equal(candidate.link, null);
    }
    assert.equal(store.sequence, before, 'candidate read does not rebuild indexes');
    assert.equal((await api.read('/mint-rights?' + new URLSearchParams({ owner: address, asset: 'p2:0', block: '2' }))).mintRights.length, 0);
    // The owner-wide list includes imported ledger assets.
    const all = await api.read('/mint-rights?' + new URLSearchParams({ owner: address }));
    assert.deepEqual(all.mintRights.map(r => [r.asset, r.block]), [['p0', '1']]);
  } finally { await store.close(); }
});

test('exact pinned rankings and expiry use indexed deltas', async () => {
  const values = []; for (let n = 0; n < 40; n++) for (let d = 1; d < 40; d++) values.push({ n: BigInt(n), d: BigInt(d), key: rationalKey(n, d) });
  values.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (let i = 1; i < values.length; i++) assert.ok(values[i - 1].n * values[i].d <= values[i].n * values[i - 1].d);
  const f = await setup(), { store } = f;
  try {
    await store.put('catalogPatterns', 'p2:0', event(0, 100).discoveries[0].record);
    await store.put('headers', '0000000000000010', { fields: { time: 1000 } });
    const find = { asset: 'p2:0', block: '2', pattern: '0', finder: owner, findHeight: '10', finderUntil: '200', count: '1' };
    await store.put('findsByAgent/' + owner, 'f2:2:0', find);
    await expireRankings(store, { now: 1000001 }); assert.equal(rankingHighlights(store).rarestFinds.today.block, '2');
    await store.put('catalogPatterns', 'p2:0', { ...event(0, 100).discoveries[0].record, knownMatchCount: '99' });
    assert.equal(rankingHighlights(store).rarestFinds.ever.rarity.numerator, '1', 'later rarity changes do not rewrite historical scores');
    await expireRankings(store, { now: 8 * 86400000 }); assert.equal(rankingHighlights(store).rarestFinds.week, null);
    assert.equal(rankingHighlights(store).rarestFinds.ever.block, '2');
  } finally { await store.close(); }
});

test('500 public clients read after restart across more than 4096 retained result records', async t => {
  const f = await setup(); let store = f.store;
  try {
    const rows = Array.from({ length: 4200 }, (_, i) => ({ space: 'publicResults/payments', id: String(i).padStart(8, '0'), value: { id: String(i), amount: '1', action: 'paid' } }));
    await store.transact(rows); await store.close(); store = await Store.open(f.root);
    const api = createPublicAPI({ views: { store }, files: f.files });
    const http = await serve({ intake: { store }, files: f.files, publicAPI: api });
    try {
      const started = performance.now();
      const clients = Array.from({ length: 500 }, () => new ServiceClient({ origin: http.url }));
      const pages = await Promise.all(clients.map(client => client.results({ collection: 'payments', limit: 2 })));
      assert.ok(pages.every(p => p.payments.length === 2 && p.next));
      t.diagnostic(JSON.stringify({ clients: 500, historicalResults: 4200, elapsedMs: performance.now() - started, sourceRequests: 0, scope: 'public_read_load_only' }));
    } finally { await http.close(); }
    // Older projection stores require an explicit offline migration; read
    // requests neither rebuild nor silently report an empty successful result.
    store.db.exec('UPDATE projectionControl SET ready=0 WHERE id=1');
    await assert.rejects(api.read('/results/payments'), /projection_migration_required/);
    await migratePublicProjections(store);
    assert.equal((await api.read('/results/payments?limit=2')).payments.length, 2);
  } finally { await store.close(); }
});


test('queued corrections fence prior owners and registry refresh remains bounded', async () => {
  const f = await setup(), { store, api } = f;
  try {
    await store.put('feedEvents', '1', event(0, 20, owner));
    await store.put('feedEvents', '2', event(0, 20, other));
    assert.ok(store.db.prepare('SELECT 1 FROM projectionPending WHERE scope=? AND event=?').get('agent/' + owner, '2'));
    while (store.count('feedEvents')) await f.feeds.events();
    assert.equal((await api.read('/agents/' + address)).discoveryCount, '0');
    let revision = 1, visits = 0;
    const registry = new PublicRegistry({ store, rows: 1, registry: async () => ({ revision, settings: { pageRows: 10 },
      page: (_, { after, limit }) => { assert.equal(limit, 1); visits++; return ['p2:0', 'p2:1'].filter(id => id > after).slice(0, limit).map(id => ({ id, value: { id: 'verified', generation: 1, suspended: revision === 2 } })); } }) });
    await registry.tick(); assert.equal(store.count('publicDeployments'), 1);
    await registry.tick(); await registry.tick(); await registry.tick(); assert.equal(visits, 3);
    revision = 2; await registry.tick(); assert.equal(store.get('publicDeployments', 'p2:0').suspended, true);
    assert.notEqual(store.get('publicDeployments', 'p2:1').registryRevision, store.get('meta', 'publicRegistryRevision'));
  } finally { await store.close(); }
});

test('owner rights skip unrelated assets and continue across owned patterns and compounds', async () => {
  const f = await setup(), { store, api } = f, compound = 'c2:' + '1'.repeat(64);
  try {
    for (const asset of ['p2:0', 'p2:1', compound]) await store.transact([
      { space: 'publicBalances', id: owner + '/' + asset, value: { owner, asset, amount: '100' } },
      { space: 'publicDeployments', id: asset, value: { id: 'verified' } }]);
    for (let n = 0; n < 2; n++) for (let block = 0; block < 3; block++) await store.put('finds', rules.findIdV2(String(block), String(n)), {
      asset: 'p2:' + n, pattern: String(n), block: String(block), finder: owner, count: '1', finderUntil: '200', findHeight: '10' });
    const put = store.db.prepare('INSERT INTO publicRightsV2 VALUES(?,?,?,?,?,?,?,?)');
    store.db.exec('BEGIN');
    for (let n = 0; n < 5000; n++) put.run('unrelated/' + n, 'p2:99', String(n), rules.uintKeyV2(String(n)), other, rules.uintKeyV2('200'), rules.uintKeyV2('1'), '{}');
    store.db.exec('COMMIT');
    let cursor, work = 0; const found = [];
    do {
      const page = await api.read('/mint-rights?' + new URLSearchParams({ owner: address, limit: '2', allowed: 'true', ...(cursor ? { cursor } : {}) }));
      found.push(...page.mintRights.map(r => [r.asset, r.block])); work += page.examined; cursor = page.next;
    } while (cursor);
    assert.equal(found.length, 7); assert.equal(new Set(found.map(JSON.stringify)).size, 7); assert.ok(work < 30);
    assert.equal(found.at(-1)[0], compound);
    await store.put('claimed2/p2:0', rules.uintKeyV2('0'), { height: '0', pattern: '0', count: '1', found: true, minted: false });
    const before = await api.response('/patterns/p2:0/claimed-blocks?minted=true');
    await store.put('minted', 'p2:0/0', { inscription: 'verified' });
    assert.notEqual(await api.response('/patterns/p2:0/claimed-blocks?minted=true'), before);
    assert.equal((await api.read('/patterns/p2:0/claimed-blocks?minted=true')).rows.length, 1);
    assert.equal((await api.read('/patterns/p2:0/claimed-blocks?minted=false')).rows.length, 0);
  } finally { await store.close(); }
});
