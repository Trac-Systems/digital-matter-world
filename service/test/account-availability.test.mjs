import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountAvailability } from '../src/account-availability.mjs';
import { accountKey, accountTree, accountLeaf, accountBranch, accountEmptyRoot, verifyAccountProof, readAccountLeaf } from '../../contract/account-tree.js';

test('partial cold updates persist frontier nodes split out of compressed paths', () => {
  const records = new Map(), store = { get: (_, id) => records.get(id) }, entries = new Map();
  let root = accountEmptyRoot(0);
  const keys = Array.from({ length: 12 }, (_, i) => accountKey('balance', 'partial-' + i));
  const changes = keys.map((key, i) => new Map([[key, { available: String(i + 1), held: '0' }]]));
  changes.push(new Map([[keys[3], null], [keys[8], { available: '99', held: '0' }]]));
  for (const replacements of changes) {
    const oldRoot = root, oldEntries = new Map(entries);
    const proof = JSON.parse(JSON.stringify(new AccountAvailability(store).prove(root, [...replacements.keys()])));
    // Updating need not use the instance that produced the wire proof.
    const writer = new AccountAvailability(store);
    root = writer.update(root, proof, replacements);
    for (const { id, value } of writer.writes()) records.set(id, value);
    for (const [key, value] of replacements) entries.set(key, value);
    const reference = accountTree(entries);
    assert.equal(root, reference.root);
    for (const key of keys) assert.deepEqual(new AccountAvailability(store).prove(root, [key]), reference.prove([key]));
    assert.deepEqual(new AccountAvailability(store).prove(oldRoot, keys), accountTree(oldEntries).prove(keys));
  }
});

test('compact availability preserves exact sparse proofs through cold updates, absence and deletion', () => {
  const records = new Map(), store = { get: (_, key) => records.get(key) };
  const entries = new Map(Array.from({ length: 100 }, (_, i) => [accountKey('balance', 'p' + i), { available: String(i + 1), held: '0' }]));
  const reference = accountTree(entries), first = new AccountAvailability(store);
  assert.equal(first.update(accountEmptyRoot(0), { empty: true }, entries), reference.root);
  const writes = first.writes();
  assert.ok(writes.length <= entries.size * 4, `100 assets retained ${writes.length} availability rows`);
  for (const { id, value } of writes) records.set(id, value);
  const keys = [...entries.keys(), accountKey('balance', 'absent')].sort();
  const cold = new AccountAvailability(store), proof = cold.prove(reference.root, keys);
  assert.deepEqual(proof, reference.prove(keys), 'compression cannot change the wire proof');
  const changed = new Map(keys.map((k, i) => [k, i % 3 ? { available: '999', held: '0' } : null]));
  const next = cold.update(reference.root, proof, changed);
  assert.equal(next, accountTree(changed).root);
  for (const { id, value } of cold.writes()) records.set(id, value);
  for (const [key, value] of changed) assert.deepEqual(readAccountLeaf(next, new AccountAvailability(store).prove(next, [key]), key), value);
  // Earlier roots remain available after another account update.
  assert.deepEqual(new AccountAvailability(store).prove(reference.root, keys), reference.prove(keys));
  const bad = structuredClone(records.get(reference.root));
  if (bad.skip) bad.child = '0'.repeat(64); else bad.left = '0'.repeat(64);
  assert.throws(() => new AccountAvailability({ get: (_, id) => id === reference.root ? bad : records.get(id) }).prove(reference.root, keys), /account_availability/);
});

test('mixed legacy binary nodes and compact paths authenticate without rebuilding old storage', () => {
  const key = accountKey('balance', 'old'), value = { available: '7', held: '0' }, records = new Map();
  let root = accountLeaf(key, value); records.set(root, { key, value });
  for (let depth = 255; depth >= 0; depth--) {
    const right = (parseInt(key[Math.floor(depth / 4)], 16) >> (3 - depth % 4)) & 1, empty = accountEmptyRoot(depth + 1);
    const row = right ? { left: empty, right: root } : { left: root, right: empty };
    root = accountBranch(row.left, row.right); records.set(root, row);
  }
  const store = { get: (_, id) => records.get(id) }, a = new AccountAvailability(store), second = accountKey('balance', 'new');
  const proof = a.prove(root, [second]), replacements = new Map([[second, { available: '5', held: '0' }]]);
  const next = a.update(root, proof, replacements);
  assert.equal(next, verifyAccountProof(root, proof, replacements));
  for (const { id, value } of a.writes()) records.set(id, value);
  assert.deepEqual(readAccountLeaf(next, new AccountAvailability(store).prove(next, [key]), key), value);
  const compact = a.writes().find(r => r.value.skip);
  for (const malformed of [{ skip: 'x', child: compact.value.child }, { ...compact.value, skip: '1'.repeat(257) }, { ...compact.value, child: '0'.repeat(64) }]) {
    assert.throws(() => new AccountAvailability({ get: (_, id) => id === compact.id ? malformed : records.get(id) }).prove(compact.id, [second]), /account_availability/);
  }
});
