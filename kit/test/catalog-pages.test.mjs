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
