import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as r from '../../rules/src/index.js';
import { CLAIM_CAPACITY_VALUES } from '../../deploy/host-157/settings-successor.mjs';
import { temp } from './helpers.mjs';

const execute = promisify(execFile), root = fileURLToPath(new URL('../../', import.meta.url));

test('gateway and signer resume partially closed and partially paid windows across a capacity successor', { timeout: 120000 }, async () => {
  const directory = await temp('claim-capacity-switch-');
  const run = async (name, changes = {}) => {
    const output = join(directory, name);
    await execute(process.execPath, ['service/scripts/benchmark-settlement-paging.mjs'], { cwd: root, maxBuffer: 16 * 1024 * 1024,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BENCH_'))),
        BENCH_OUT: output, BENCH_MODE: 'closure', BENCH_PUBLIC: '1', BENCH_PAIRS: '1000', BENCH_PAGES: '2',
        BENCH_BACKLOG_WINDOWS: '1', BENCH_BACKLOG_PAGES: '10', BENCH_UNCLOSED_WINDOWS: '1',
        BENCH_BATCHES: '30', BENCH_TRACK_SETTLEMENTS: '1', ...changes } });
    return JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'));
  };
  const original = await run('original'), switched = await run('switched', {
    BENCH_SWITCH_BATCH: '3', BENCH_SWITCH_VALUES: JSON.stringify(CLAIM_CAPACITY_VALUES),
  });
  assert.equal(original.final.windows, 0); assert.equal(switched.final.windows, 0);
  assert.ok(switched.rows.length < original.rows.length);
  assert.deepEqual(switched.successor.values, { ...switched.originalDocument.values, ...CLAIM_CAPACITY_VALUES });
  const boundary = switched.rows.find(row => row.settingsRevision === '1');
  assert.equal(boundary.n + 2, 3);
  const closing = boundary.beforeRounds.find(round => round.window === '9000001');
  const paging = boundary.beforeRounds.find(round => round.window === '9000000');
  assert.ok(closing.closing && !closing.closed, 'the successor must resume an existing closure');
  assert.equal(paging.cursor, '2'); assert.ok(BigInt(paging.cursor) < BigInt(paging.pages), 'payout must already be in progress');
  const completed = switched.rows.flatMap(row => row.closureResults).find(row => row.window === closing.window);
  assert.equal(completed.draw.seed, closing.closing.seed);
  assert.deepEqual(completed.draw.policy, closing.policy);
  assert.equal(completed.draw.senderPageRows, closing.closing.layout.rows);
  for (const row of switched.rows) assert.equal(row.settingsHash, r.hashObject(row.n + 2 < 3 ? switched.originalDocument : switched.successor));

  const delivered = result => result.rows.flatMap(row => row.settlementResults)
    .filter(page => ['9000000', '9000001'].includes(page.window))
    .sort((a, b) => a.window.localeCompare(b.window) || Number(a.page) - Number(b.page) || a.from - b.from);
  // Every benchmark batch separately checks gateway audit bytes, signer replay
  // bytes, signing digest and contract preflight. Also compare eventual payout
  // bytes to an uninterrupted run under the original settings.
  const pages = delivered(switched);
  assert.equal(r.stableJSON(pages), r.stableJSON(delivered(original)));
  const spans = new Set();
  for (const page of pages) for (let row = page.from; row < page.to; row++) {
    const key = `${page.window}/${page.page}/${row}`;
    assert.ok(!spans.has(key), 'a settlement row cannot be processed twice'); spans.add(key);
  }
  assert.equal(spans.size, 3000);
  assert.equal(pages.flatMap(page => page.winners).length, 1500);
});
