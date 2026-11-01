import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Agent } from '../lib/agent.mjs';
import { readInteger, patternId, nextCursor, claimSelection } from '../lib/api-values.mjs';

const recording = JSON.parse(await readFile(new URL('./fixtures/v2-live-reads.json', import.meta.url)));
const recorded = path => structuredClone(recording.records.find(r => r.path === path).body);

test('v2 read integers are exact and confined to local algorithm boundaries', () => {
  assert.equal(readInteger(recorded('/health').tip), 973604);
  for (const n of [0, 973604, Number.MAX_SAFE_INTEGER]) assert.equal(readInteger(String(n)), n);
  for (const n of ['01', '-1', '1e3', '9007199254740992', Number.MAX_SAFE_INTEGER + 1, null, true]) assert.throws(() => readInteger(n));
  const summary = recorded(recorded('/latest.json').summary.path);
  assert.equal(typeof summary.tip, 'string'); assert.equal(readInteger(summary.tip), 973604);
  assert.equal(patternId({ number: '35', key: 'ab'.repeat(32) }), 'p2:35');
  assert.equal(patternId({ number: 35 }), 'pz', 'legacy records keep their original identity');
});

test('v2 cursors do not rely on null totals, nonempty pages, or the next alias', () => {
  const page = recorded('/compounds?limit=2');
  assert.equal(page.total, null); assert.equal(nextCursor(page), null);
  const receipts = recorded('/receipts?limit=2');
  assert.equal(typeof receipts.total, 'string'); assert.equal(nextCursor(receipts), receipts.nextCursor);
  assert.equal(nextCursor({ nextCursor: 'opaque' }), 'opaque');
  assert.throws(() => nextCursor({ next: null, nextCursor: 'opaque' }));
  assert.throws(() => nextCursor({}));
});

test('v2 taken slots drain the recorded compact snapshot and apply its validated delta', async () => {
  const recorded = JSON.parse(await readFile(new URL('./fixtures/taken-reads.json', import.meta.url)));
  const calls = [], pages = recorded.records.map(r => structuredClone(r.body));
  const service = { takenSlotsPage: async options => { calls.push(options); return pages.shift(); } };
  const agent = { service }, patterns = [{ number: 0, key: 'aa'.repeat(32) }];
  const taken = await Agent.prototype.takenSlots.call(agent, patterns);
  assert.deepEqual([...taken[0]], [10, 973603]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {});
  assert.equal(calls[1].cursor, recorded.records[0].body.nextCursor);
  assert.deepEqual([...(await Agent.prototype.takenSlots.call(agent, patterns))[0]], [10, 973603, 5]);
  assert.equal(calls[2].since, recorded.records[1].body.revision);
});

test('resuming v2 claims normalizes selections without rewriting the saved packet', () => {
  const payload = { window: '973604', plots: [{ block: '1', patterns: ['0', '12'] }], header: { height: '973604', raw: '00' } };
  assert.deepEqual(claimSelection(payload), { window: 973604, plots: [{ block: 1, patterns: [0, 12] }], header: { height: 973604, raw: '00' } });
  assert.equal(payload.window, '973604'); assert.equal(payload.plots[0].patterns[0], '0');
});

test('once claims the recorded v2 summary window with activated settings and saved string selections', async () => {
  const latest = recorded('/latest.json'), summary = recorded(latest.summary.path);
  const head = { tip: { height: readInteger(summary.tip), hash: summary.tipHash }, counted: readInteger(summary.height) };
  const payload = { window: summary.tip, plots: [{ block: '0', patterns: ['0'] }], header: { height: summary.tip, raw: '00' } };
  let claim;
  const agent = { trac: { head: async () => head, hashAt: async () => summary.tipHash, settings: async () => ({ values: { claimsPerWindow: 7 } }) },
    catalog: async () => [{ number: 0, key: 'ab'.repeat(32) }], journal: { get: () => ({ body: { p: payload } }) },
    service: { latest: async () => latest, publication: async () => summary },
    claim: async args => { claim = args; return { state: 'dry-run', action: 'claim-v2' }; } };
  const result = await Agent.prototype.runOnce.call(agent, { history: { length: head.tip.height + 1, get: () => ({ hash: summary.tipHash }), raw: () => '00' } });
  assert.equal(result.action, 'claim-v2'); assert.equal(claim.event.window, 973604);
  assert.equal(claim.header.height, 973604); assert.deepEqual(claim.plots, [{ block: 0, patterns: [0] }]);
  assert.equal(typeof summary.tip, 'string');
});
