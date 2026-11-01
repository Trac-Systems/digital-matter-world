import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, canonicalEvidenceJSON } from '../src/store.mjs';
import { rules } from '../src/rules.mjs';
import { projectionRevision } from '../src/projection-state.mjs';
import { projectEvidence } from '../src/evidence-projection.mjs';
import { publicPageBytes } from '../src/public-page-bytes.mjs';
import { publicIdentities } from '../../rules/src/trac-address.js';
import { projectionFixture } from './store-projection-fixture.mjs';

// Captured from the pre-optimization implementation (887ddff), then updated for
// the additive public symbol and pattern totals fields/indexes. Evidence roots and unrelated HTTP
// response bytes remain identical to that fixture.
test('projection updates, deletes and restart match the expected response bytes and durable state', async () => {
  const expected = JSON.parse(await readFile(new URL('./store-projection-fixture.json', import.meta.url)));
  assert.deepEqual(await projectionFixture(), expected);
});

test('evidence canonical bytes retain JSON normalization for every supported value shape', () => {
  const values = [null, true, 'é漢😀', 0, Number.MAX_SAFE_INTEGER, { z: [1, false, null], a: { b: 'x', a: 'y' } },
    { absent: undefined, z: 1 }, { zero: -0, nan: NaN, positive: Infinity, negative: -Infinity }, [undefined, , 2],
    new Date('2020-01-01T00:00:00Z'), new Uint8Array([1, 2])];
  for (const value of values) assert.equal(canonicalEvidenceJSON(value), rules.stableJSON(JSON.parse(JSON.stringify(value))));
  assert.throws(() => canonicalEvidenceJSON('\ud800'), /unicode_surrogate/);
  for (const space of ['mints', 'batches', 'receiptObservations', 'financialLinks', 'linkRequests', 'payoutBindings', 'payoutTransitions', 'finds', 'patternsByAsset', 'ceremonies']) {
    const value = projectEvidence(space, 'mint/test', { id: 'one', request: { z: '1', a: ['x', 'y'] }, result: {}, absent: undefined });
    assert.equal(canonicalEvidenceJSON(value), rules.stableJSON(JSON.parse(JSON.stringify(value))), space);
  }
});

async function fixture(t) {
  const directory = await mkdtemp(join(process.env.DMW_BUILD_ROOT ?? tmpdir(), 'projection-writes-'));
  const store = await Store.open(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.put('meta', 'ruleState', { batchVersion: 2 });
  return store;
}

test('all public projection dispatch branches retain previous reads; unrelated spaces do not', async t => {
  const store = await fixture(t), reads = [], original = store.get.bind(store);
  store.get = (space, id) => { reads.push([space, id, original(space, id)]); return original(space, id); };
  const spaces = ['catalogPatterns', 'catalogTypes', 'catalogAgents', 'finds', 'rankExpiry', 'links', 'minted', 'publicBalances',
    'submittedBitmaps', 'publicEvents', 'publicSupply', 'mints', 'linkRequests', 'payoutTotals', 'commissionOwed', 'payoutPaid',
    'discoveriesByAgent/owner', 'findsByAgent/owner', 'publicResults/credits', 'window/1/winners'];
  for (const space of spaces) {
    const previous = { marker: space, block: '1', owner: 'owner', agent: 'agent', asset: 'p2:1', finder: 'finder', request: { v: 2 } };
    store.putStmt.run(space, 'row', JSON.stringify(previous));
    await store.put(space, 'row');
    assert.ok(reads.some(([s, id, value]) => s === space && id === 'row' && value?.marker === space), space);
  }
  reads.length = 0;
  await store.transact(['claimNodes', 'accountNodes', 'headers', 'dedupe', 'observations'].map(space => ({ space, id: 'one', value: { x: 1 } })));
  assert.deepEqual(reads, []);
});

test('equivalent updates preserve revision increments with no sort writes; one changed key touches one sort', async t => {
  const store = await fixture(t), value = { number: '1', name: 'first', knownMatchCount: '2' };
  await store.put('catalogPatterns', 'p2:1', value);
  store.db.exec(`CREATE TEMP TABLE mutations(action TEXT);
    CREATE TEMP TABLE revisionMutations(scope TEXT);
    CREATE TEMP TRIGGER revision_update AFTER UPDATE ON projectionRevisions BEGIN INSERT INTO revisionMutations VALUES(NEW.scope); END;
    CREATE TEMP TRIGGER order_insert AFTER INSERT ON publicOrderV2 BEGIN INSERT INTO mutations VALUES('insert'); END;
    CREATE TEMP TRIGGER order_delete AFTER DELETE ON publicOrderV2 BEGIN INSERT INTO mutations VALUES('delete'); END;
    CREATE TEMP TRIGGER order_update AFTER UPDATE ON publicOrderV2 BEGIN INSERT INTO mutations VALUES('update'); END;`);
  const before = projectionRevision(store, 'items/patterns/');
  await store.transact(Array.from({ length: 20 }, () => ({ space: 'catalogPatterns', id: 'p2:1', value })));
  assert.equal(projectionRevision(store, 'items/patterns/'), String(BigInt(before) + 20n));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mutations').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM revisionMutations').get().n, 3, 'one physical revision update for each of collection, point and item scope');
  await store.put('catalogPatterns', 'p2:1', { ...value, name: 'second' });
  assert.deepEqual(store.db.prepare('SELECT action FROM mutations ORDER BY action').all().map(r => r.action), ['delete', 'insert']);
  const revision = projectionRevision(store, 'catalogPatterns');
  assert.throws(() => store.apply([{ sequence: rules.nextUint(store.sequence), operations: [
    { space: 'catalogPatterns', id: 'p2:1', value }, { space: 'links', id: 'bad', value: { block: 'invalid' } },
  ] }]), /integer_v2/);
  assert.equal(projectionRevision(store, 'catalogPatterns'), revision);
  assert.equal(store.get('catalogPatterns', 'p2:1').name, 'second');
  assert.equal(store.projectionRevisions, null); assert.equal(store.projectionItems, null);
  const beforeFailure = store.db.prepare('SELECT * FROM projectionRevisions ORDER BY scope').all();
  assert.throws(() => store.apply([{ sequence: rules.nextUint(store.sequence), operations: [
    ...Array.from({ length: 300 }, (_, i) => ({ space: 'publicResults/credits', id: String(i), value: { amount: String(i) } })),
    { space: 'links', id: 'bad', value: { block: 'invalid' } },
  ] }]), /integer_v2/);
  assert.deepEqual(store.db.prepare('SELECT * FROM projectionRevisions ORDER BY scope').all(), beforeFailure);
  assert.equal(store.db.prepare("SELECT 1 FROM publicItemsV2 WHERE kind='credits' LIMIT 1").get(), undefined);
});


test('incremental public byte sizing matches full-prefix identity encoding at exact boundaries', () => {
  const values = [{ owner: 'a'.repeat(64), nested: { from: 'b'.repeat(64) }, name: 'é漢😀', escaped: '\"\\\n' },
    { split: { owner: 'a'.repeat(64) }, route: '/agents/' + 'a'.repeat(64), amount: 12n }, null, ['a'.repeat(64), 'é']];
  for (const key of ['rows', 'owners', 'finds']) for (const limit of [1, 100, 1000, 10000]) {
    const envelope = { v: 3, revision: '9', [key]: [], total: null, next: null, nextCursor: null, limit }, fits = publicPageBytes(envelope, key);
    for (const value of values) {
      const cursor = Buffer.from(JSON.stringify({ after: envelope[key].length, key })).toString('base64url');
      const candidate = { ...envelope, [key]: [...envelope[key], value], next: cursor, nextCursor: cursor };
      const size = Buffer.byteLength(JSON.stringify(publicIdentities(candidate)));
      assert.equal(fits(value, cursor, size - 1), false);
      assert.equal(fits(value, cursor, size), true);
      envelope[key].push(value);
    }
  }
});


test('falsy stored public items retain their existing sort entries when replaced', async t => {
  const store = await fixture(t);
  for (const value of [false, 0, '']) {
    await store.put('publicResults/credits', 'scalar', value);
    await store.put('publicResults/credits', 'scalar', { id: 'scalar', amount: '2' });
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM publicOrderV2 WHERE kind='credits' AND id='scalar'").get().n, 4);
    assert.equal(JSON.parse(store.db.prepare("SELECT value FROM publicItemsV2 WHERE kind='credits' AND id='scalar'").get().value).amount, '2');
  }
});
