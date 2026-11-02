import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedStamp } from '../prod/trac.mjs';

test('point-read pages share one recent Trac stamp and refresh on demand or after the reuse window', async () => {
  let clock = 0, calls = 0, fail = false;
  const stamp = async () => { calls++; if (fail) throw Error('trac_down'); return { revision: String(calls) }; };
  const page = sharedStamp(stamp, 1000, () => clock);
  assert.equal((await page()).revision, '1');
  clock = 999; assert.equal((await page()).revision, '1', 'reused inside the window');
  assert.equal((await page(true)).revision, '2', 'a caller needing a newer clock gets a fresh stamp');
  clock = 2000; assert.equal((await page()).revision, '3', 'refreshed after the window');
  fail = true; await assert.rejects(page(true), /trac_down/);
  fail = false; assert.equal((await page()).revision, '5', 'a failed stamp is never reused');
  assert.equal(calls, 5);
});

test('the reuse window starts when a slow stamp arrives, and callers share the stamp in flight', async () => {
  let clock = 0, calls = 0, release;
  const stamp = () => { calls++; return new Promise(resolve => { release = () => resolve({ revision: String(calls) }); }); };
  const page = sharedStamp(stamp, 1000, () => clock);
  const first = page(), second = page();
  clock = 5000; release();
  assert.equal((await first).revision, '1'); assert.equal((await second).revision, '1');
  clock = 5900; assert.equal((await page()).revision, '1', 'still inside the window measured from arrival');
  assert.equal(calls, 1);
});
