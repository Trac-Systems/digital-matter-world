import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { fillPatternTotalsPage } from '../src/pattern-totals-fill.mjs';
import { migratePublicProjections } from '../scripts/migrate-public-projections.mjs';
import { rules } from '../src/rules.mjs';

const pattern = (number = '2', extra = {}) => ({ number, name: 'dmwmuffinite', knownMatchCount: '610', ...extra });
const supply = (asset, issued, burned = '0') => ({ space: 'publicSupply', id: asset,
  value: { asset, issued, burned, outstanding: String(BigInt(issued) - BigInt(burned)) } });
const catalog = (number = '2', extra) => ({ space: 'catalogPatterns', id: 'p2:' + number, value: pattern(number, extra) });
const marker = (asset, block, id = 'mint', scope) => ({ space: 'minted', id: rules.mintPlotKey(asset, block, scope), value: { id } });
const apiFor = store => createPublicAPI({ views: { store } });
const picked = async (store, asset = 'p2:2') => (await apiFor(store).read('/patterns?asset=' + encodeURIComponent(asset) + '&limit=1')).patterns[0];
const totals = row => [row.supply, row.minted];
async function fixture(t, maintenance = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pattern-totals-')), f = { directory, store: await (maintenance ? Store.openForMaintenance(directory) : Store.open(directory)) };
  t.after(async () => { await f.store.close(); await rm(directory, { recursive: true, force: true }); });
  await f.store.put('meta', 'ruleState', { batchVersion: 2, counted: '974100' });
  return f;
}

test('pattern list and named read expose outstanding supply including holds and refresh cached responses', async t => {
  const { store } = await fixture(t), api = apiFor(store);
  await store.transact([catalog(), supply('p2:2', '700', '90')]);
  // Available balances exclude holds; the supply leaf includes them.
  await store.put('publicBalances', 'owner/p2:2', { owner: 'owner', asset: 'p2:2', amount: '600', held: '10' });
  for (const path of ['/patterns', '/table', '/patterns?asset=p2%3A2&limit=1']) {
    const before = await api.response(path);
    assert.deepEqual(totals(JSON.parse(before.bytes).patterns[0]), ['610', '0']);
  }
  const previous = await api.response('/patterns');
  await store.transact([supply('p2:2', '700', '91'), marker('p2:2', '5255')]);
  for (const path of ['/patterns', '/table', '/patterns?asset=p2%3A2&limit=1'])
    assert.deepEqual(totals(JSON.parse((await api.response(path)).bytes).patterns[0]), ['609', '1']);
  assert.notEqual((await api.response('/patterns')).etag, previous.etag);
  await store.put('catalogPatterns', 'p2:2', pattern('2', { name: 'dmwrenamed' }));
  assert.deepEqual(totals(await picked(store)), ['609', '1']);
  await store.transact([supply('p2:2', '1000000000000000000000000000000', '1')]);
  assert.equal((await picked(store)).supply, '999999999999999999999999999999');
  await store.put('publicSupply', 'p2:2');
  assert.deepEqual(totals(await picked(store)), ['0', '1']);
});

test('minted counts official blocks, excludes additional tickers on either side of activation and is idempotent', async t => {
  const { store } = await fixture(t);
  await store.transact([catalog(),
    { space: 'accountRecords', id: 'fd/official', value: { asset: 'p2:2', minted: '1200' } },
    { space: 'accountRecords', id: 'fd/extra', value: { asset: 'p2:2', official: 'official', minted: '1200' } },
    { space: 'accountRecords', id: 'dc/official-mint', value: { deployment: 'official', amount: '600', plot: '5255', state: 'minted' } },
    { space: 'accountRecords', id: 'dc/extra-mint', value: { deployment: 'extra', amount: '600', plot: '5255', state: 'minted' } }]);
  assert.equal((await picked(store)).minted, '0', 'token capacity is not a block count');
  await store.transact([marker('p2:2', '5255', 'official-mint'), marker('p2:2', '5255', 'extra-mint', 'additional-deploy')]);
  assert.equal((await picked(store)).minted, '1');
  await store.transact([marker('p2:2', '5256', 'extra-mint'), marker('p2:2', '5257', 'extra-mint', 'additional-deploy')]);
  assert.equal((await picked(store)).minted, '1', 'old shared keys also exclude additional deployments');
  await store.transact([marker('p2:2', '5255', 'official-mint'), marker('p2:2', '5255', 'official-mint'), marker('p2:2', '5258', 'official-mint')]);
  assert.equal((await picked(store)).minted, '2');
  await store.put('minted', 'p2:2/5255');
  await store.put('minted', 'p2:2/5255');
  assert.equal((await picked(store)).minted, '1');
  await store.put('mints', 'old-extra', { request: { v: 2 }, context: { deployment: { officialDeployment: 'official' } } });
  await store.transact([marker('p2:2', '5259', 'old-extra')]);
  assert.equal((await picked(store)).minted, '1', 'saved deployment identifies old unscoped additional mints too');
});

test('supply and minted sorting and cursors change with totals without a catalog rewrite', async t => {
  const { store } = await fixture(t), api = apiFor(store);
  await store.transact([supply('p2:2', '2'), marker('p2:2', '5255'), catalog(), catalog('3'), supply('p2:3', '1')]);
  const paths = ['/patterns?sort=supply&limit=1', '/table?sort=minted&limit=1'];
  const pages = await Promise.all(paths.map(path => api.read(path)));
  assert.ok(pages.every(page => page.patterns[0].asset === 'p2:3' && page.nextCursor));
  await store.transact([supply('p2:3', '3'), marker('p2:3', '5256'), marker('p2:3', '5257')]);
  for (const [i, path] of paths.entries()) {
    assert.equal((await api.read(path)).patterns[0].asset, 'p2:2');
    await assert.rejects(api.read(path + '&cursor=' + pages[i].nextCursor), /page_cursor_stale/);
  }
});

test('imported patterns use their ledger supply and count canonical and legacy block aliases once', async t => {
  const { store } = await fixture(t);
  await store.transact([catalog('0', { legacy: { asset: 'p0' } }), supply('p0', '610', '1'), supply('p2:0', '999'),
    marker('p0', '5255'), marker('p2:0', '5255')]);
  assert.deepEqual(totals(await picked(store, 'p2:0')), ['609', '1']);
  await store.put('minted', 'p0/5255');
  assert.equal((await picked(store, 'p2:0')).minted, '1');
  await store.put('minted', 'p2:0/5255');
  assert.equal((await picked(store, 'p2:0')).minted, '0');
});

test('pattern totals roll back with records and survive restart, offline rebuild and journal replay', async t => {
  const f = await fixture(t, true);
  await f.store.transact([catalog(), supply('p2:2', '610'), marker('p2:2', '5255')]);
  const evidence = f.store.evidenceIndex.root();
  assert.throws(() => f.store.apply([{ sequence: rules.nextUint(f.store.sequence), operations: [
    marker('p2:2', '5256'), supply('p2:2', '9'), { space: 'links', id: 'bad', value: { block: 'invalid' } },
  ] }]), /integer_v2/);
  assert.deepEqual(totals(await picked(f.store)), ['610', '1']);
  await f.store.close(); f.store = await Store.open(f.directory);
  assert.deepEqual(totals(await picked(f.store)), ['610', '1']);
  await migratePublicProjections(f.store, { pageRows: 2 });
  assert.deepEqual(totals(await picked(f.store)), ['610', '1']);
  assert.equal(f.store.evidenceIndex.root(), evidence);
  await f.store.close();
  for (const file of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) await rm(join(f.directory, file), { force: true });
  f.store = await Store.open(f.directory);
  assert.deepEqual(totals(await picked(f.store)), ['610', '1']);
});

function seedOldStore(store) {
  for (const op of [catalog(), supply('p2:2', '610', '1'), marker('p2:2', '5255'), marker('p2:2', '5256'), marker('p2:2', '5257', 'extra', 'extra')])
    store.putStmt.run(op.space, op.id, JSON.stringify(op.value));
  store.db.exec("DELETE FROM public_projection_fixes WHERE name='pattern-totals-v1'");
}

test('old stores fill totals automatically in bounded restartable pages before serving reads', async t => {
  const f = await fixture(t, true);
  seedOldStore(f.store);
  const sequence = f.store.sequence, evidence = f.store.evidenceIndex.root();
  assert.equal(fillPatternTotalsPage(f.store, { pageRows: 1 }), false);
  assert.equal(f.store.db.prepare('SELECT n FROM publicPatternMintCounts WHERE asset=?').get('p2:2').n, '1');
  await f.store.close(); f.store = await Store.open(f.directory);
  assert.deepEqual(totals(await picked(f.store)), ['609', '2']);
  assert.equal(f.store.sequence, sequence);
  assert.equal(f.store.evidenceIndex.root(), evidence);
  assert.equal(fillPatternTotalsPage(f.store), true);
});

test('failed startup fill pages roll back counters, membership and progress together', async t => {
  const { store } = await fixture(t, true); seedOldStore(store);
  store.db.exec("CREATE TEMP TRIGGER stop_totals BEFORE INSERT ON publicPatternMintBlocks WHEN NEW.block='5256' BEGIN SELECT RAISE(ABORT,'injected_fill_failure'); END");
  assert.throws(() => fillPatternTotalsPage(store, { pageRows: 4 }), /injected_fill_failure/);
  assert.equal(store.db.prepare('SELECT n FROM publicPatternMintCounts WHERE asset=?').get('p2:2'), undefined);
  assert.equal(store.db.prepare('SELECT cursor FROM publicPatternTotalsFill WHERE id=1').get(), undefined);
  store.db.exec('DROP TRIGGER stop_totals');
  while (!fillPatternTotalsPage(store, { pageRows: 2 })) {}
  assert.deepEqual(totals(await picked(store)), ['609', '2']);
});

test('startup fills old markers before replaying a durable mint tail without counting twice', async t => {
  const f = await fixture(t, true); seedOldStore(f.store);
  const sequence = rules.nextUint(f.store.sequence);
  await f.store.close();
  const body = Buffer.from(JSON.stringify({ sequence, operations: [marker('p2:2', '5255'), marker('p2:2', '5258')] }));
  const header = Buffer.alloc(36); header.writeUInt32BE(body.length); Buffer.from(rules.hash(body), 'hex').copy(header, 4);
  await appendFile(join(f.directory, 'pending.log'), Buffer.concat([header, body]));
  f.store = await Store.open(f.directory);
  assert.deepEqual(totals(await picked(f.store)), ['609', '3']);
  assert.equal(f.store.sequence, sequence);
});

test('pattern reads and completed startup fills use no record enumeration or aggregate queries', async t => {
  const { store } = await fixture(t);
  await store.transact([catalog(), supply('p2:2', '609'), marker('p2:2', '5255')]);
  store.list = () => { throw Error('record_scan'); };
  const prepare = store.db.prepare.bind(store.db), statements = [];
  store.db.prepare = sql => { statements.push(sql); return prepare(sql); };
  const api = apiFor(store);
  for (const path of ['/patterns', '/patterns?sort=minted', '/patterns?asset=p2%3A2&limit=1'])
    assert.deepEqual(totals((await api.read(path)).patterns[0]), ['609', '1']);
  assert.ok(statements.every(sql => !/count\s*\(|sum\s*\(|FROM records/i.test(sql)));
  const completed = { storePageRows: 128, db: { prepare(sql) { statements.push(sql); return prepare(sql); } } };
  statements.length = 0;
  assert.equal(fillPatternTotalsPage(completed), true);
  assert.deepEqual(statements, ['SELECT 1 FROM public_projection_fixes WHERE name=?']);
});
