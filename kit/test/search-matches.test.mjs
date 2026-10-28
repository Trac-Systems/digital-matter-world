import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadHistory } from '../lib/headers.mjs';
import { searchMatchPage } from '../lib/search-matches.mjs';
import { findPatterns } from '../lib/search.mjs';
import { encodeTracAddress } from '../../rules/src/index.js';
import { temp } from './helpers.mjs';

test('local search returns real paged heights and resumes the same snapshot after restart and header growth', async t => {
  const path = join(await temp(t), 'headers.bin');
  const bytes = Buffer.from((await readFile(new URL('./fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  await writeFile(path, bytes.subarray(0, 32 * 80));
  let history = await loadHistory(path), tip = history.get(31);
  const proposal = { name: 'dmwones', pat: '1', fld: 4, dt: 'n' };
  const first = await searchMatchPage({ history, tip, proposal, pageSize: 3 });
  assert.deepEqual(first.matches.map(m => [m.height, m.count]), [['1', '1'], ['10', '1'], ['11', '2']]);
  for (const m of first.matches) assert.equal(m.hash, history.get(Number(m.height)).hash);
  await writeFile(path, bytes); history = await loadHistory(path); tip = history.get(63);
  const rows = [...first.matches]; let cursor = first.nextCursor;
  while (cursor) {
    const page = await searchMatchPage({ history, tip, proposal, pageSize: 3, cursor });
    assert.equal(page.localResultId, first.localResultId); assert.equal(page.searchSnapshot.height, 31);
    rows.push(...page.matches); cursor = page.nextCursor;
  }
  assert.deepEqual(rows.map(m => m.height), Array.from({ length: 32 }, (_, h) => String(h)).filter(h => h.includes('1')));
  await assert.rejects(searchMatchPage({ history, tip, proposal: { ...proposal, pat: '2' }, cursor: first.nextCursor }), /snapshot or cursor changed/);
  const result = await findPatterns({ history, tip, existing: [], owner: encodeTracAddress('11'.repeat(32)), candidates: [proposal], maxCandidates: 1 });
  const found = result.accepted[0]; assert.equal(found.localMatchCount, String(found.record.rarity)); assert.ok(found.matches.length >= 3);
  assert.equal(found.completeLocalSearch, true); assert.deepEqual(found.searchedRange, { from: 0, to: 63 });
});
