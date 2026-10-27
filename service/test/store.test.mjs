import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { temp } from './helpers.mjs';
test('fsynced grouped writes, deletions, restart, and compaction preserve acknowledged records', async () => {
  const path = await temp(); let s = await Store.open(path);
  try {
    await Promise.all(Array.from({ length: 500 }, (_, i) => s.put('pending', String(i), { claim: i })));
    assert.equal(s.count('pending'), 500); await s.transact([{ space: 'pending', id: '0' }]);
    await s.compact(); assert.equal(await s.bytes(), 0); await s.close(); s = await Store.open(path);
    assert.equal(s.count('pending'), 499); assert.equal(s.get('pending', '0'), null); assert.deepEqual(s.get('pending', '499'), { claim: 499 });
    await s.put('pending', 'next', true); await s.close(); s = await Store.open(path); assert.equal(s.get('pending', 'next'), true);
  } finally { await s.close(); }
});
test('a truncated unacknowledged tail is removed; complete checksum corruption fails closed', async () => {
  const path = await temp(); let s = await Store.open(path); await s.put('x', '1', true); await s.close();
  await appendFile(join(path, 'pending.log'), Buffer.from([0, 0, 0])); s = await Store.open(path);
  assert.equal(s.get('x', '1'), true); await s.close();
  const bytes = await readFile(join(path, 'pending.log')); bytes[4] ^= 1; await writeFile(join(path, 'pending.log'), bytes);
  await assert.rejects(Store.open(path), /checksum/);
});
test('exclusive writer lock rejects a concurrent process without deleting its lock', async () => {
  const path = await temp(), s = await Store.open(path);
  try { await assert.rejects(Store.open(path), /store_in_use/); assert.equal(JSON.parse(await readFile(join(path, 'writer.lock'), 'utf8')).pid, process.pid); }
  finally { await s.close(); }
});
