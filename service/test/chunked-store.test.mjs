import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { temp } from './helpers.mjs';

test('multi-frame acceptance is invisible before its commit marker and survives restart', async () => {
  const directory = await temp(), options = { journalFrameBytes: 4096, journalFragmentBytes: 512, checkpointBytes: 10_000_000 };
  let store = await Store.open(directory, options);
  const value = { rounds: Array.from({ length: 2000 }, (_, i) => ({ i, text: 'escape\n"😀' })) };
  const apply = store.apply.bind(store); let stages = 0;
  store.apply = rows => {
    apply(rows);
    stages += rows.filter(r => r.stage).length;
    if (rows.some(r => r.stage) && !rows.some(r => r.commit)) { assert.equal(store.get('meta', 'accepted'), null); assert.equal(store.get('meta', 'state'), null); }
  };
  await store.transact([{ space: 'meta', id: 'state', value }, { space: 'meta', id: 'accepted', value: true }]);
  assert.ok(stages > 1); assert.deepEqual(store.get('meta', 'state'), value); assert.equal(store.count('meta'), 2);
  const log = await readFile(join(directory, 'pending.log')); await store.close();
  let offset = 0, commitAt;
  while (offset < log.length) {
    const size = log.readUInt32BE(offset), row = JSON.parse(log.subarray(offset + 36, offset + 36 + size));
    assert.ok(size <= options.journalFrameBytes); if (row.commit) commitAt = offset;
    offset += 36 + size;
  }
  for (const complete of [false, true]) {
    const recovery = await temp(); await writeFile(join(recovery, 'pending.log'), complete ? log : log.subarray(0, commitAt));
    store = await Store.open(recovery, options);
    assert.equal(store.get('meta', 'accepted'), complete ? true : null);
    assert.equal(store.count('meta'), complete ? 2 : 0);
    if (complete) assert.deepEqual(store.get('meta', 'state'), value);
    await store.close();
  }
});
