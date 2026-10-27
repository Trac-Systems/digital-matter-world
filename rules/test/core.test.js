import test from 'node:test';
import assert from 'node:assert/strict';
import { stableJSON, parseCanonical, findId, parseFindId, heightToPlot, plotToHeight, plotRegion, randomIndex,
  HeaderHistory, parseHeader, verifyHistory, targetFromBits, bitsFromTarget } from '../src/index.js';
const genesis = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
test('canonical JSON rejects ambiguous or unsupported values and duplicate keys', () => {
  assert.equal(stableJSON({ z: 1, a: ['😀', true, null] }), '{"a":["😀",true,null],"z":1}');
  for (const v of [undefined, NaN, Infinity, 1.5, -0, 1n, new Date(), [, 1]]) assert.throws(() => stableJSON(v));
  for (const s of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{ "a":1}', '1e0', '-0']) assert.throws(() => parseCanonical(s));
  assert.deepEqual(parseCanonical('{"a":1}'), { a: 1 });
});
test('spiral orientation, adjacency and inversion across 210,001 heights', () => {
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => heightToPlot(i)), [
    {x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1},{x:-1,y:1},{x:-1,y:0},{x:-1,y:-1},{x:0,y:-1},{x:1,y:-1}]);
  let prev = heightToPlot(0);
  for (let h = 0; h <= 210000; h++) {
    const p = heightToPlot(h); assert.equal(plotToHeight(p.x, p.y), h);
    if (h) assert.equal(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y), 1); prev = p;
  }
  for (const h of [0xffffffff, 840000, 972850]) { const p = heightToPlot(h); assert.equal(plotToHeight(p.x, p.y), h); }
  assert.equal(plotRegion(210000).halving, 1); assert.equal(plotRegion(2016).region, 1);
});
test('compact find identifiers round trip unsigned 32-bit boundaries', () => {
  for (const h of [0, 1, 972850, 0xffffffff]) for (const p of [0, 36, 0xffffffff]) assert.deepEqual(parseFindId(findId(h, p)), { height: h, pattern: p });
  assert.throws(() => parseFindId('f00')); assert.throws(() => findId(2 ** 32, 0));
});
test('header parsing never mutates Uint8Array or Node Buffer', () => {
  const raw = Buffer.from(genesis, 'hex'); raw[4] = 1; const before = Buffer.from(raw);
  parseHeader(raw); assert.deepEqual(raw, before);
  const history = new HeaderHistory(Buffer.from(genesis, 'hex')); assert.equal(verifyHistory(history).count, 1);
  assert.equal(history.field(0, 11, 'h'), '1d00ffff'); assert.equal(history.field(0, 10), '2083236893');
  assert.throws(() => new HeaderHistory(new Uint8Array(79))); assert.throws(() => history.field(0, 4, 'h'));
  for (const b of [0x1d00ffff, 0x17034219, 0x207fffff]) assert.equal(bitsFromTarget(targetFromBits(b)), b);
  for (const b of [0, 0x1d80ffff, 0x23000001]) assert.throws(() => targetFromBits(b));
});
test('rejection sampled draws are deterministic and domain separated', () => {
  const seed = '12'.repeat(32), values = Array.from({ length: 1000 }, (_, n) => randomIndex(seed, `test:${n}`, 7));
  assert.equal(new Set(values).size, 7); assert.deepEqual(values, Array.from({ length: 1000 }, (_, n) => randomIndex(seed, `test:${n}`, 7)));
});

test('persistent indexes share history, survive serialization and prune deleted cache entries', async () => {
  const { recordGet, recordSet, recordDelete, recordObject, recordSize } = await import('../src/index.js');
  const base = { old: 7 }; let index = base;
  assert.equal(recordGet(base, 'old'), 7); assert.equal(recordSize(base), 1); assert.equal(recordObject(base), base);
  const replaced = recordSet(base, 'old', 8);
  assert.equal(replaced.base, base); assert.equal(recordSize(replaced), 1); assert.equal(base.old, 7);
  assert.equal(recordGet(JSON.parse(JSON.stringify(replaced)), 'old'), 8);
  for (let i = 0; i < 1000; i++) index = recordSet(index, `key${i}`, i);
  assert.equal(recordSize(index), 1001); assert.equal(index.base, base);
  index = JSON.parse(JSON.stringify(index));
  for (let i = 0; i < 1000; i++) assert.equal(recordGet(index, `key${i}`), i);
  const snapshot = index;
  for (let i = 0; i < 1000; i++) index = recordDelete(index, `key${i}`);
  assert.equal(index.root, null); assert.deepEqual(recordObject(index), base);
  index = recordDelete(index, 'old'); assert.equal(recordSize(index), 0); assert.equal(recordGet(index, 'old'), undefined);
  assert.deepEqual(recordObject(index), {}); assert.equal(recordGet(snapshot, 'key4'), 4);
  index = JSON.parse(JSON.stringify(index));
  assert.equal(recordGet(index, 'old'), undefined); assert.deepEqual(recordObject(index), {});
  index = recordSet(index, 'old', 9);
  assert.equal(recordSize(index), 1); assert.deepEqual(recordObject(index), { old: 9 }); assert.equal(base.old, 7);
});
