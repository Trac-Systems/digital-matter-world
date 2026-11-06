import test from 'node:test';
import assert from 'node:assert/strict';
import { financialEvidencePrefetch, financialRecordProjection } from '../src/financial-evidence-prefetch.mjs';

test('prefetched evidence is rebuilt when a preceding step changes a shared record or reservation', async () => {
  const transitions = [0, 1, 2].map(id => ({ type: 'fund', id })), records = new Map([['shared', { value: 0 }]]), reservations = new Map();
  const calls = [], reads = { financialScope: ({ record, reservations }) => ({ financialEvidence: async t => {
    calls.push(t.id); return { state: await record('shared'), reserved: reservations.get('r') ?? null };
  } }) }, record = async key => records.get(key), sources = reads.financialScope({ record, reservations });
  const evidence = financialEvidencePrefetch({ transitions, reads, sources, record, reservations, concurrency: 3 });
  assert.deepEqual(await evidence(transitions[0]), { state: { value: 0 }, reserved: null });
  records.set('shared', { value: 1 });
  assert.deepEqual(await evidence(transitions[1]), { state: { value: 1 }, reserved: null });
  reservations.set('r', 'new');
  assert.deepEqual(await evidence(transitions[2]), { state: { value: 1 }, reserved: 'new' });
  assert.deepEqual(calls, [0, 1, 2, 1, 2]);
});

test('failed speculation is retried in order and an expired deadline starts no extra steps', async () => {
  const transitions = [0, 1, 2].map(id => ({ type: 'fund', id })), calls = [];
  const reads = { financialScope: () => ({ financialEvidence: async t => { calls.push(t.id); if (t.id === 1) throw Error('unavailable'); return t.id; } }) };
  const sources = reads.financialScope(), base = { transitions, reads, sources, record: async () => null, reservations: new Map() };
  const evidence = financialEvidencePrefetch(base);
  assert.equal(await evidence(transitions[0]), 0);
  await assert.rejects(evidence(transitions[1]), /unavailable/);
  assert.deepEqual(calls, [0, 1, 2, 1]);
  calls.length = 0;
  assert.equal(await financialEvidencePrefetch({ ...base, canStart: () => false })(transitions[0]), 0);
  assert.deepEqual(calls, [0]);
});

test('projected dependencies ignore unused counters but still invalidate a changed deployment binding', async () => {
  const transitions = [0, 1, 2].map(id => ({ type: 'public-scan', id })), reservations = new Map();
  let row = { deployment: 'original', minted: '0' }, calls = 0;
  const record = async () => row, reads = { financialScope: ({ record }) => ({ financialEvidence: async () => {
    calls++; return financialRecordProjection(await record('fd/id', null, ['deployment']), ['deployment']);
  } }) }, sources = reads.financialScope({ record });
  const evidence = financialEvidencePrefetch({ transitions, reads, sources, record, reservations });
  assert.deepEqual(await evidence(transitions[0]), { deployment: 'original' });
  row = { ...row, minted: '1' };
  assert.deepEqual(await evidence(transitions[1]), { deployment: 'original' }); assert.equal(calls, 3);
  row = { ...row, deployment: 'changed' };
  assert.deepEqual(await evidence(transitions[2]), { deployment: 'changed' }); assert.equal(calls, 4);
});
