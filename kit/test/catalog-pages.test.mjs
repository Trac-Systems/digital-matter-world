import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../lib/agent.mjs';

const page = (patterns, next = null, change = {}) => ({ v: 3, revision: '7', total: null, limit: 2, patterns, next, ...change });
const catalog = pages => Agent.prototype.catalog.call({ service: { patterns: async () => {
  assert.ok(pages.length, 'catalog must terminate'); return pages.shift();
} } });

test('v3 catalog consumes bounded pages with unknown totals and exact safe pattern numbers', async () => {
  assert.deepEqual(await catalog([page([], 'a'), page([{ number: '0', name: 'zero' }], 'b'), page([{ number: '9007199254740991' }])]),
    [{ number: 0, name: 'zero' }, { number: Number.MAX_SAFE_INTEGER }]);
  assert.deepEqual(await catalog([page([])]), []);
});
test('catalog rejects revision changes, cursor loops, duplicates and imprecise ordinals', async () => {
  for (const pages of [
    [page([], 'a'), page([], null, { revision: '8' })],
    [page([], 'a'), page([], 'a')],
    [page([{ number: '0' }], 'a'), page([{ number: '0' }])],
    [page([{ number: '9007199254740992' }])],
    [page([{ number: '01' }])],
    [page([{ number: 1 }])],
    [page([], null, { revision: '01' })],
    [page([], 'a'), page([], null, { v: 2, total: 0 })]
  ]) await assert.rejects(catalog(pages));
});
test('legacy catalog retains exact total and numeric identity checks', async () => {
  const legacy = { total: 1, patterns: [{ number: 0 }], next: null, limit: 2 };
  assert.deepEqual(await catalog([legacy]), [{ number: 0 }]);
  await assert.rejects(catalog([{ ...legacy, total: 2 }]));
  await assert.rejects(catalog([{ ...legacy, total: null }]));
  await assert.rejects(catalog([{ ...legacy, patterns: [{ number: '0' }] }]));
});
test('pattern definitions are read once, then only the newest pages; any mismatch reads everything again', async () => {
  let numbers = [0, 1, 2, 3], requests = [], revision = () => String(numbers.length);
  const rows = list => list.map(n => ({ number: String(n), name: 'p' + n }));
  const service = { patterns: async params => {
    requests.push(params.order + (params.cursor ? '+' : ''));
    const sorted = params.order === 'desc' ? [...numbers].reverse() : numbers, start = params.cursor ? Number(params.cursor) : 0;
    const next = start + 2 < sorted.length ? String(start + 2) : null;
    return { v: 3, revision: revision(), total: numbers.length, limit: 2, patterns: rows(sorted.slice(start, start + 2)), next };
  } };
  const agent = { service, catalog: Agent.prototype.catalog };
  const read = () => Agent.prototype.patternDefinitions.call(agent);
  assert.deepEqual((await read()).map(p => p.number), [0, 1, 2, 3]);
  assert.deepEqual(requests, ['asc', 'asc+']);
  // Nothing new: one newest-first page.
  requests = []; assert.deepEqual((await read()).map(p => p.number), [0, 1, 2, 3]); assert.deepEqual(requests, ['desc']);
  // Three new patterns: the newest pages until a known number.
  numbers = [0, 1, 2, 3, 4, 5, 6]; requests = [];
  assert.deepEqual((await read()).map(p => p.number), [0, 1, 2, 3, 4, 5, 6]); assert.deepEqual(requests, ['desc', 'desc+']);
  // A count that does not add up (a gap or a removed row) falls back to the full read.
  numbers = [0, 1, 2, 3, 4, 5, 6, 8]; revision = () => '9'; service.total = 9;
  const patterns = service.patterns; service.patterns = async params => ({ ...await patterns(params), total: 9 });
  requests = []; await assert.rejects(read(), /Catalog changed during read/); assert.deepEqual(requests, ['desc', 'asc', 'asc+', 'asc+', 'asc+']);
  // A revision change between newest-first pages is retried as a full read.
  service.patterns = patterns; numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; let calls = 0;
  revision = () => (calls++ === 1 ? 'x' : String(numbers.length));
  requests = []; assert.deepEqual((await read()).map(p => p.number), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); assert.equal(requests[0], 'desc'); assert.equal(requests[2], 'asc');
});
