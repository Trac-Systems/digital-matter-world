import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { recordPage } from '../src/claimed-public.mjs';
import { claimedEventsV2 } from '../src/claimed-v2.mjs';
import { fillPatternSymbolsPage } from '../src/pattern-symbol-fill.mjs';
import { migratePublicProjections } from '../scripts/migrate-public-projections.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { rules } from '../src/rules.mjs';

const owner = 'a'.repeat(64), names = ['dmwmuffinite', 'dmwmudstone', 'dmwmuddite', 'dmwmusstone'];
const pattern = (number, name = names[Number(number)]) => ({ number: String(number), name, discoverer: owner, knownMatchCount: '1' });
const put = p => ({ space: 'catalogPatterns', id: 'p2:' + p.number, value: p });
const assignments = store => store.db.prepare('SELECT asset,symbol FROM publicPatternSymbols ORDER BY asset').all().map(r => [r.asset, r.symbol]);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pattern-symbols-')), f = { directory, store: await Store.open(directory) };
  t.after(async () => { await f.store.close(); await rm(directory, { recursive: true, force: true }); });
  await f.store.put('meta', 'ruleState', { batchVersion: 2, counted: '0' });
  return f;
}

test('public collections, named lookups and pattern records expose symbols without changing evidence', async t => {
  const { store } = await fixture(t), p = pattern(0);
  await store.put('patternsByAsset', 'p2:0', p);
  const evidenceRoot = store.evidenceIndex.root();
  await store.transact([put(p), { space: 'discoveriesByAgent/' + owner, id: 'p2:0', value: p }, ...names.slice(1).map((name, i) => put(pattern(i + 1, name)))]);
  assert.equal(store.evidenceIndex.root(), evidenceRoot);
  assert.equal(store.get('patternsByAsset', 'p2:0').symbol, undefined);
  assert.equal(store.get('catalogPatterns', 'p2:0').symbol, 'Mu');
  assert.equal(store.get('discoveriesByAgent/' + owner, 'p2:0').symbol, 'Mu');
  const api = createPublicAPI({ views: { store } });
  for (const path of ['/patterns', '/table']) assert.deepEqual((await api.read(path)).patterns.map(p => p.symbol), ['Mu', 'Md', 'Mi', 'Ms']);
  assert.equal((await api.read('/patterns?asset=p2%3A1&limit=1')).patterns[0].symbol, 'Md');
  assert.equal((await api.read('/agents/' + encodeTracAddress(owner) + '/discoveries')).discoveries[0].symbol, 'Mu');
  assert.equal(recordPage(store, 'catalogPatterns', new URLSearchParams()).rows[0].symbol, 'Mu');
});

test('assignments survive updates, deletion, restart, offline rebuild and journal replay', async t => {
  const f = await fixture(t);
  await f.store.transact(names.map((name, i) => put(pattern(i, name))));
  await f.store.put('catalogPatterns', 'p2:0', { ...pattern(0, 'dmwrenamed'), symbol: 'Wrong' });
  await f.store.put('catalogPatterns', 'p2:1');
  await f.store.transact([put(pattern(4, 'dmwmudstones'))]);
  const expected = assignments(f.store);
  assert.deepEqual(expected, [['p2:0', 'Mu'], ['p2:1', 'Md'], ['p2:2', 'Mi'], ['p2:3', 'Ms'], ['p2:4', 'Mt']]);
  await f.store.close(); f.store = await Store.open(f.directory);
  assert.deepEqual(assignments(f.store), expected);
  await migratePublicProjections(f.store, { pageRows: 2 });
  assert.deepEqual(assignments(f.store), expected);
  assert.equal((await createPublicAPI({ views: { store: f.store } }).read('/patterns?asset=p2%3A0')).patterns[0].symbol, 'Mu');
  await f.store.close();
  for (const file of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) await rm(join(f.directory, file), { force: true });
  f.store = await Store.open(f.directory);
  assert.deepEqual(assignments(f.store), expected);
  assert.equal(f.store.get('catalogPatterns', 'p2:0').symbol, 'Mu');
  await f.store.transact([put(pattern(1))]);
  assert.equal(f.store.get('catalogPatterns', 'p2:1').symbol, 'Md', 'reappearing records retain their original reservation');
});

function seedOldCatalog(store) {
  const numbers = ['0', '2', '10', '9007199254740993'];
  for (const [i, number] of numbers.entries()) {
    const value = pattern(number, names[i]), asset = 'p2:' + number;
    store.putStmt.run('catalogPatterns', asset, JSON.stringify(value));
    store.putStmt.run('discoveriesByAgent/' + owner, asset, JSON.stringify(value));
  }
  store.db.exec("DELETE FROM public_projection_fixes WHERE name='pattern-symbols-v1'");
  return [['p2:0', 'Mu'], ['p2:10', 'Mi'], ['p2:2', 'Md'], ['p2:9007199254740993', 'Ms']];
}

test('one-time fill uses bounded numeric-order pages and resumes across restart', async t => {
  const f = await fixture(t), expected = seedOldCatalog(f.store), sequence = f.store.sequence, root = f.store.evidenceIndex.root();
  for (let i = 0; i < 3; i++) assert.equal(fillPatternSymbolsPage(f.store, { pageRows: 2 }), false);
  assert.deepEqual(assignments(f.store), [], 'catalog identities must all be queued before allocating');
  assert.equal(fillPatternSymbolsPage(f.store, { pageRows: 2 }), false);
  assert.deepEqual(assignments(f.store), [['p2:0', 'Mu'], ['p2:2', 'Md']], 'numeric priority across lexical page boundaries');
  await f.store.close(); f.store = await Store.open(f.directory);
  assert.deepEqual(assignments(f.store), expected);
  assert.equal(f.store.sequence, sequence, 'fill is projection metadata, not new journal/consensus operations');
  assert.equal(f.store.evidenceIndex.root(), root);
  assert.equal(f.store.get('discoveriesByAgent/' + owner, 'p2:10').symbol, 'Mi');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM publicPatternSymbolQueue').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM publicPatternSymbolFill').get().n, 0);
  const revision = f.store.db.prepare("SELECT revision FROM projectionRevisions WHERE scope='catalogPatterns'").get().revision;
  assert.equal(fillPatternSymbolsPage(f.store, { pageRows: 1 }), true);
  assert.equal(f.store.db.prepare("SELECT revision FROM projectionRevisions WHERE scope='catalogPatterns'").get().revision, revision);
  await f.store.transact([put(pattern('9007199254740994', 'dmwmuffin'))]);
  assert.equal(f.store.get('catalogPatterns', 'p2:9007199254740994').symbol, 'Mf');
});

test('failed fill pages roll back reservations, catalog fields and progress together', async t => {
  const { store } = await fixture(t), expected = seedOldCatalog(store);
  fillPatternSymbolsPage(store, { pageRows: 8 });
  store.db.exec("CREATE TEMP TRIGGER stop_symbols BEFORE INSERT ON publicPatternSymbols WHEN NEW.asset='p2:10' BEGIN SELECT RAISE(ABORT,'injected_fill_failure'); END");
  assert.throws(() => fillPatternSymbolsPage(store, { pageRows: 8 }), /injected_fill_failure/);
  assert.deepEqual(assignments(store), []);
  assert.equal(store.get('catalogPatterns', 'p2:0').symbol, undefined);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM publicPatternSymbolQueue').get().n, 4);
  store.db.exec('DROP TRIGGER stop_symbols');
  assert.equal(fillPatternSymbolsPage(store, { pageRows: 8 }), true);
  assert.deepEqual(assignments(store), expected);
});

test('startup fills existing patterns before replaying an acknowledged discovery tail', async t => {
  const f = await fixture(t), expected = seedOldCatalog(f.store);
  const sequence = rules.nextUint(f.store.sequence);
  await f.store.close();
  // A durable frame with no SQLite commit is the normal crash-recovery tail.
  const body = Buffer.from(JSON.stringify({ sequence, operations: [put(pattern('9007199254740994', 'dmwmuffin'))] }));
  const header = Buffer.alloc(36); header.writeUInt32BE(body.length);
  Buffer.from(rules.hash(body), 'hex').copy(header, 4);
  await appendFile(join(f.directory, 'pending.log'), Buffer.concat([header, body]));
  f.store = await Store.open(f.directory);
  assert.deepEqual(assignments(f.store), [...expected, ['p2:9007199254740994', 'Mf']]);
  assert.equal(f.store.sequence, sequence);
});

test('reads and completed fills do not enumerate the catalog or allocate symbols', async t => {
  const { store } = await fixture(t);
  await store.transact(names.map((name, i) => put(pattern(i, name))));
  const before = assignments(store);
  store.list = () => { throw Error('catalog_scan'); };
  // A completed fill uses exactly its completion-key lookup, including after
  // restart when no prepared statements are cached for the new connection.
  const statements = [];
  const completed = { storePageRows: 128, db: { prepare(sql) { statements.push(sql); return store.db.prepare(sql); } } };
  assert.equal(fillPatternSymbolsPage(completed), true);
  assert.deepEqual(statements, ['SELECT 1 FROM public_projection_fixes WHERE name=?']);
  const api = createPublicAPI({ views: { store } });
  for (const path of ['/patterns?sort=name&limit=1', '/table?order=desc&limit=1', '/patterns?asset=p2%3A2']) assert.equal((await api.read(path)).patterns.length, 1);
  assert.deepEqual(assignments(store), before);
});

test('a failed record transaction cannot reserve a symbol', async t => {
  const { store } = await fixture(t);
  assert.throws(() => store.apply([{ sequence: rules.nextUint(store.sequence), operations: [put(pattern(0)), { space: 'links', id: 'bad', value: { block: 'invalid' } }] }]), /integer_v2/);
  assert.deepEqual(assignments(store), []);
  assert.equal(store.get('catalogPatterns', 'p2:0'), null);
  await store.transact([put(pattern(0))]);
  assert.equal(store.get('catalogPatterns', 'p2:0').symbol, 'Mu');
});

test('discovery chunks allocate in pattern-number order and preserve source records', async t => {
  const f = await fixture(t), discoveries = [pattern(10, names[2]), pattern(2, names[1]), pattern(0, names[0])].map(record => ({ record }));
  await f.store.put('feedEvents', '1', { height: '0', tip: '0', discoveries });
  // Stop after one unit of work so reopening still tests a partial discovery phase.
  const feed = () => ({ store: f.store, history: { get() { throw Error('history_scan'); } }, settings: { feedEventRows: 1, feedEventsPerTick: 1 } });
  while (assignments(f.store).length < 1) await claimedEventsV2(feed());
  assert.deepEqual(assignments(f.store), [['p2:0', 'Mu']]);
  assert.deepEqual(f.store.get('feedEvents', '1').discoveries, discoveries);
  await f.store.close(); f.store = await Store.open(f.directory);
  while (f.store.hasRows('feedEvents')) await claimedEventsV2(feed());
  assert.deepEqual(assignments(f.store), [['p2:0', 'Mu'], ['p2:10', 'Mi'], ['p2:2', 'Md']]);
});
