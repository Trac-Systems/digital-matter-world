import test from 'node:test';
import assert from 'node:assert/strict';
import { successorStore, successorMatches } from '../src/pipeline-overlap.mjs';
import { Pipeline } from '../src/pipeline.mjs';

const fixture = () => {
  const state = { claimRoot: 'claims', catalogRoot: 'catalog', accountRoot: 'accounts' };
  const predecessor = { proposal: { batch: { n: '7', to: '100', epoch: '2', root: 'parent' } } };
  const draft = { proposal: { batch: { n: '8', previous: 'parent' } }, execution: '100', previousRoot: 'parent', settings: { settingsHash: 'settings' }, startState: state,
    items: [{ input: { tip: '100', tipHash: 'hash', height: '100', blockHash: 'hash' } }] };
  return { predecessor, draft, last: { n: '7', to: '100' }, epoch: 2, counted: 100, settings: draft.settings, state, hashAt: () => 'hash' };
};
test('receipt cutoff and renewal keep their ordered lane at pipeline depth two', async () => {
  let overlayReads = 0;
  const p = Object.assign(Object.create(Pipeline.prototype), { pipelineDepth: 2,
    store: { get: space => { assert.equal(space, 'namedFences'); return { phase: 'certified' }; },
      list: () => { overlayReads++; throw Error('unexpected speculative read'); } } });
  const predecessor = { settings: { document: {}, settingsHash: 'settings' }, proposal: { batch: {} } };
  assert.equal(await p.prepareSuccessor(predecessor), null);
  p.store.get = () => null;
  for (const kind of ['reserve', 'execute']) {
    predecessor.proposal.batch.renewal = { kind };
    assert.equal(await p.prepareSuccessor(predecessor), null);
  }
  assert.equal(overlayReads, 0);
});
test('speculative construction does not refresh or fence live admission', async () => {
  let preparations = 0;
  const p = Object.assign(Object.create(Pipeline.prototype), { speculative: true,
    settings: { batchVersion: 2 }, intake: { prepareBatch: async () => preparations++ },
    reads: { batchLast: async () => ({ n: 1, to: 1 }), committeeEpoch: async () => 0 },
    store: { get: () => null, countUint: () => '0', hasRows: () => false, list: () => [] } });
  assert.equal(await p.build(), null); assert.equal(preparations, 0);
  p.speculative = false;
  assert.equal(await p.build(), null); assert.equal(preparations, 1);
});
test('successor promotion fences changed predecessor, roots, epoch, execution, policy and branch', () => {
  const f = fixture(); assert(successorMatches(f));
  for (const changed of [
    { last: { n: '6', to: '100' } }, { last: { n: '7', to: '99' } }, { epoch: 3 }, { counted: 101 },
    { settings: { settingsHash: 'changed' } }, { hashAt: () => 'reorg' },
    ...['claimRoot', 'catalogRoot', 'accountRoot'].map(k => ({ state: { ...f.state, [k]: 'changed' } })),
    { draft: { ...f.draft, previousRoot: 'conflict' } }
  ]) assert.equal(successorMatches({ ...f, ...changed }), false, JSON.stringify(changed));
});
test('a speculative overlay exposes proposed immutable nodes and tombstones without mutating accepted storage', () => {
  const data = new Map([['observations/a', { id: 'a' }], ['observations/b', { id: 'b' }], ['meta/namedReservedBatch', '7']]);
  const store = { get: (s, id) => data.get(s + '/' + id) ?? null, countUint: s => String([...data.keys()].filter(k => k.startsWith(s + '/')).length),
    list: (s, { limit }) => [...data].filter(([k]) => k.startsWith(s + '/')).slice(0, limit).map(([k, value]) => ({ id: k.slice(s.length + 1), value })) };
  const state = { finds: { one: { owner: 'owner' } }, types: {}, rounds: [] };
  const draft = { items: [{ observation: { id: 'a' }, output: { state, patterns: [], claimWrites: [{ space: 'claimNodes', id: 'node', value: { valid: true } }],
    accountWrites: [{ space: 'accountRecords', id: 'account', value: { revision: '1' } }] } }] };
  const result = successorStore(store, draft);
  assert.deepEqual(result.store.get('claimNodes', 'node'), { valid: true });
  assert.equal(result.store.get('meta', 'namedReservedBatch'), undefined);
  assert.equal(result.store.countUint('observations'), '1'); assert.deepEqual(result.store.list('observations', { limit: 1 }).map(r => r.id), ['b']);
  assert.equal(store.get('claimNodes', 'node'), null); assert.equal(store.get('meta', 'namedReservedBatch'), '7');
  assert.throws(() => result.store.transact([]), /speculative_store_write/);
});
test('accepted-root lookup and effective-policy checks run before publishing a speculative draft', async () => {
  const f = fixture(); let published = 0;
  const p = Object.assign(Object.create(Pipeline.prototype), { settings: f.settings, history: { hashAt: f.hashAt }, store: { get: () => f.state },
    overlap: { discarded: 0, promoted: 0 }, publishDraft: async () => published++, saveDraft: async () => {},
    reads: { batchLast: async () => f.last, committeeEpoch: async () => f.epoch, counted: async () => f.counted, batchRoot: async () => 'conflict' } });
  await p.promoteSuccessor(f.predecessor, f.draft); assert.equal(published, 0); assert.equal(p.overlap.discarded, 1);
  p.reads.batchRoot = async () => 'parent'; await p.promoteSuccessor(f.predecessor, f.draft); assert.equal(published, 1); assert.equal(p.overlap.promoted, 1);
});

function ticking(signature) {
  const f = fixture(), p = Object.assign(Object.create(Pipeline.prototype), {
    reconciled: true, overlap: { discarded: 0, failed: 0, overlapMs: 0 }, committee: { signature }, reads: {},
    loadDraft: async () => f.predecessor, reconcileDraft: async draft => ({ draft, accepted: false }),
    prepareSuccessor: async () => async () => f.draft, saveDraft: async () => {}, build: async () => null,
    store: { get: () => null }, outbox: { enqueue: async () => {}, tick: async () => {} }
  });
  return { p, f };
}
test('failed or refused predecessor signing discards speculation without reserving a successor', async () => {
  for (const reject of [false, true]) {
    let signatures = 0;
    const { p } = ticking(async () => { signatures++; if (reject) throw Error('signing_failed'); return null; });
    if (reject) await assert.rejects(p.tick(), /signing_failed/); else await p.tick();
    assert.equal(signatures, 1); assert.equal(p.overlap.discarded, 1); assert.equal(p.speculation ?? null, null); assert.equal(p.running, false);
  }
});
test('pending transport retains only one in-memory successor, then discards it if its parent is retired', async () => {
  const { p, f } = ticking(async () => ({ signature: { compact: 'signature' } }));
  const saved = []; p.saveDraft = async d => saved.push(JSON.parse(JSON.stringify(d)));
  await p.tick(); assert(p.speculation); assert.equal(p.overlap.discarded, 0);
  assert.equal(saved.length, 1); assert.equal(saved[0].proposal.batch.n, f.predecessor.proposal.batch.n);
  assert.equal(Object.hasOwn(saved[0], 'speculation'), false, 'restart only recovers the signing draft');
  p.reconcileDraft = async () => ({ draft: null, accepted: false });
  await p.tick(); assert.equal(p.speculation, null); assert.equal(p.overlap.discarded, 1);
});
