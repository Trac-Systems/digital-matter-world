import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { temp } from './helpers.mjs';
test('preactivation rollback connections need no custom SQL functions and retain exact counts', async () => {
  const path = await temp(); let s = await Store.openForMaintenance(path);
  try {
    await s.put('rollback', 'one', true); await s.compact(); await s.close();
    const old = new DatabaseSync(join(path, 'index.sqlite'));
    try {
      // The old release prepares these statements before reading any records.
      const put = old.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(space,id) DO UPDATE SET value=excluded.value');
      const del = old.prepare('DELETE FROM records WHERE space=? AND id=?');
      put.run('rollback', 'two', 'true'); put.run('rollback', 'two', 'false'); del.run('rollback', 'one');
      assert.equal(old.prepare('SELECT n FROM record_counts WHERE space=?').get('rollback').n, 1);
    } finally { old.close(); }
    s = await Store.openForMaintenance(path); assert.equal(s.countUint('rollback'), '1'); assert.equal(s.get('rollback', 'two'), false);
    for (const n of ['1', '9', '10', '99', '100', '1099', '9007199254740991', '9223372036854775807', '9'.repeat(80)]) {
      s.db.prepare('UPDATE record_counts_decimal SET n=? WHERE space=?').run(n, 'rollback');
      await s.put('rollback', 'carry', true); assert.equal(s.countUint('rollback'), String(BigInt(n) + 1n));
      await s.put('rollback', 'carry'); assert.equal(s.countUint('rollback'), n);
    }
    s.db.prepare('UPDATE record_counts_decimal SET n=? WHERE space=?').run('1', 'rollback');
    await s.put('rollback', 'two'); assert.equal(s.countUint('rollback'), '0');
  } finally { await s.close(); }
});
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
