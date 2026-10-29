import test from 'node:test';
import assert from 'node:assert/strict';
import { FinancialMints } from '../src/financial-mints.mjs';

const mints = (delayMs, calls) => Object.assign(Object.create(FinancialMints.prototype), {
  document: { revision: '0' },
  quoteOnce: async input => { calls.push(input); await new Promise(resolve => setTimeout(resolve, delayMs)); return { quoted: calls.length }; } });

test('identical retries share a slow quote and receive its result after it finishes', async () => {
  const calls = [], m = mints(1600, calls), input = { asset: 'p2:1', block: '550000', kind: 'tap' };
  const first = m.quote(input), second = m.quote({ ...input });
  assert.equal(first, second);
  assert.deepEqual(await first, { quoted: 1 });
  assert.deepEqual(await m.quote({ ...input }), { quoted: 1 });
  assert.equal(calls.length, 1);
});

test('fast quotes are computed fresh every time', async () => {
  const calls = [], m = mints(1, calls), input = { asset: 'p2:1', block: '1', kind: 'tap' };
  await m.quote(input); await m.quote(input);
  assert.equal(calls.length, 2);
});
