import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HeaderHistory, verifyHistory } from '../../rules/src/headers.js';
import { FileHistory, loadFileHistory } from '../src/file-history.mjs';
import { temp } from './helpers.mjs';
import { loadHistory, historyProof, assertHistoryTip } from '../../kit/lib/headers.mjs';

test('file-backed verified headers match all fields and digest across tiny page boundaries', async t => {
  const directory = await temp('file-history-'), file = join(directory, 'headers.bin');
  const bytes = Buffer.from((await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  await writeFile(file, bytes); const memory = new HeaderHistory(bytes), history = loadFileHistory(file, { pageHeaders: 3 }); t.after(() => history.close());
  assert.deepEqual(history.proof, verifyHistory(memory));
  const client = await loadHistory(file, { fileBacked: true, pageHeaders: 2, count: 32 }); t.after(() => client.close());
  assert.deepEqual(historyProof(client), verifyHistory(new HeaderHistory(bytes.subarray(0, 32 * 80))));
  assertHistoryTip(client, { height: 31, hash: memory.get(31).hash });
  for (const h of [0, 3, 63, 2, 34, 1]) {
    assert.deepEqual(history.get(h), memory.get(h)); assert.deepEqual(history.raw(h), Buffer.from(memory.raw(h)));
    for (const field of [4, 10, 11]) assert.equal(history.field(h, field), memory.field(h, field));
    assert(history.page.length <= 240);
  }
  assert.throws(() => history.raw(-1), /history_height/); assert.throws(() => history.raw('01'), /history_height/);
  const corrupted = Buffer.from(bytes); corrupted[100] ^= 1; await writeFile(join(directory, 'bad.bin'), corrupted);
  assert.throws(() => loadFileHistory(join(directory, 'bad.bin')), /header_pow|header_link/);
  await writeFile(file, bytes.subarray(0, 80)); assert.throws(() => history.raw(20), /headers_changed/);
  assert.throws(() => new FileHistory(file, { pageHeaders: 0 }), /header_page_settings/);
});
