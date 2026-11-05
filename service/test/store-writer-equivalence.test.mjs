import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Store } from '../src/store.mjs';
import { temp } from './helpers.mjs';
import { writerEquivalence } from './store-writer-fixture.mjs';

// Captured with the unchanged e9c2d2f Store. Every table and four independently
// verified range proofs are compared after each seeded batch and both restarts.
test('random writes, deletes, iterable frames and restarts match the original Store tables and proofs', async () => {
  const expected = JSON.parse(await readFile(new URL('./store-writer-fixture.json', import.meta.url)));
  assert.deepEqual(await writerEquivalence(Store, await temp('writer-equivalence-')), expected);
});
