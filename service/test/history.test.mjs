import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { History } from '../src/history.mjs';
import { temp, fixtureHistory } from './helpers.mjs';
import { readFile } from 'node:fs/promises';
import { rules } from '../src/rules.mjs';
const mainnet = (await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim().match(/.{160}/g);
test('a shorter canonical chain hides stale higher hashes and rejects header gaps', async () => {
  const store = await Store.open(await temp()), original = fixtureHistory(12), history = new History(store);
  try {
    for (let h = 0; h <= 10; h++) await history.append(h, original.raw(h));
    await history.setTip(5); assert.equal(history.length, 6); assert.equal(history.hashAt(6), null); assert.throws(() => history.raw(6), /header_missing/);
    await assert.rejects(history.append(7, original.raw(7)), /header_gap/);
    await history.append(6, original.raw(6)); assert.equal(history.hashAt(6), original.hashAt(6)); assert.equal(history.hashAt(7), null);
  } finally { await store.close(); }
});

test('grouped mainnet append stores identical rows with one journal sync instead of one per header', async t => {
  const single = await Store.open(await temp()), grouped = await Store.open(await temp());
  try {
    const a = new History(single), b = new History(grouped);
    const singleSync = t.mock.method(single.fd, 'sync'), groupedSync = t.mock.method(grouped.fd, 'sync');
    const expected = [];
    for (const [height, raw] of mainnet.entries()) expected.push(await a.append(height, raw));
    assert.deepEqual(await b.appendMany(0, mainnet), expected);
    for (const space of ['headers', 'headerObjects', 'meta']) assert.deepEqual(grouped.list(space), single.list(space));
    assert.equal(b.length, 64); assert.equal(grouped.get('meta', 'headerHeight'), 63);
    assert.equal(singleSync.mock.callCount(), 64); assert.equal(groupedSync.mock.callCount(), 1);
  } finally { await single.close(); await grouped.close(); }
});

test('grouped append rejects bad parse, PoW and internal links before writing its group', async () => {
  const store = await Store.open(await temp()), history = new History(store);
  try {
    for (const [raw, error] of [['00', /header/], [mainnet[12].slice(0, -2) + 'ff', /header_pow/], [mainnet[13], /header_link/]]) {
      const changed = [...mainnet]; changed[12] = raw;
      await assert.rejects(history.appendMany(0, changed), error);
      assert.equal(history.length, 0); assert.equal(store.count('headers'), 0); assert.equal(store.count('headerObjects'), 0);
    }
    await history.appendMany(0, mainnet.slice(0, 12));
    await assert.rejects(history.appendMany(12, [mainnet[13]]), /header_link/);
    await assert.rejects(history.appendMany(13, [mainnet[13]]), /header_gap/);
    assert.equal(history.length, 12);
  } finally { await store.close(); }
});

test('grouped append bounds large frames, links across groups and survives reopening', async () => {
  const directory = await temp(), fixture = fixtureHistory(4100), raws = Array.from({ length: fixture.length }, (_, h) => fixture.raw(h));
  let store = await Store.open(directory), history = new History(store);
  try {
    await history.appendMany(0, raws);
    assert.equal(store.sequence, 3); assert.equal(history.length, raws.length);
    await store.close(); store = await Store.open(directory); history = new History(store);
    for (const h of [0, 2047, 2048, 4095, 4096, 4100]) assert.equal(history.raw(h), raws[h]);
    assert.equal(store.get('meta', 'headerHeight'), 4100);
    assert.equal(history.hashAt(4100), fixture.hashAt(4100));
  } finally { await store.close(); }
});

test('a failure in the next group leaves only the fully durable preceding group', async () => {
  const store = await Store.open(await temp()), fixture = fixtureHistory(2050), history = new History(store);
  try {
    const raws = Array.from({ length: fixture.length }, (_, h) => fixture.raw(h));
    raws[2048] = raws[2049];
    await assert.rejects(history.appendMany(0, raws), /header_link/);
    assert.equal(history.length, 2048); assert.equal(store.count('headers'), 2048);
    assert.equal(history.hashAt(2047), fixture.hashAt(2047)); assert.equal(history.hashAt(2048), null);
  } finally { await store.close(); }
});

test('grouped overwrites and truncated history preserve append metadata semantics', async () => {
  const store = await Store.open(await temp()), history = new History(store);
  try {
    await history.appendMany(0, mainnet);
    await history.appendMany(10, mainnet.slice(10, 20)); assert.equal(history.length, 64);
    await history.setTip(10); await history.appendMany(11, mainnet.slice(11, 20));
    assert.equal(history.length, 20); assert.equal(history.hashAt(20), null);
    assert.deepEqual(await history.append(20, mainnet[20]), rules.parseHeader(mainnet[20], 20));
    assert.equal(history.length, 21); assert.deepEqual(await history.appendMany(21, []), []);
  } finally { await store.close(); }
});
