import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';

const initial = () => {
  const claimSnapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: '10' } }, 9);
  return { ...claimSnapshot.hot, claimSnapshot, claimRoot: r.claimStateRoot(claimSnapshot) };
};
test('claim state authenticates membership, absence and small updates after 10,000 retained rows', () => {
  const rows = new Map(), persist = saved => { for (const row of saved.writes) rows.set(row.id, row.value); return saved.state; };
  let storage = new r.ClaimStorage({ get: id => rows.get(id), cacheSize: 2 }), state = storage.load(initial());
  for (let i = 0; i < 10000; i++) state.claimReservations = r.recordSet(state.claimReservations, `f2:${i}:0`, { window: 10, winner: r.hash('owner/' + i) });
  state = persist(storage.save(state));
  let reads = 0;
  storage = new r.ClaimStorage({ get: id => { reads++; return rows.get(id); }, cacheSize: 2 });
  const cold = storage.load(state); assert.equal(reads, 0, 'cold start reads only the pinned checkpoint');
  assert.equal(r.recordGet(cold.claimReservations, 'f2:4321:0').winner, r.hash('owner/4321'));
  assert.equal(r.recordGet(cold.claimReservations, 'f2:10001:0'), undefined);
  assert.ok(reads <= 128, String(reads));
  cold.claimReservations = r.recordSet(cold.claimReservations, 'f2:10001:0', { window: 11, winner: r.hash('next') });
  const saved = storage.save(cold); assert.ok(saved.writes.length <= 65, String(saved.writes.length));
  assert.equal(Object.keys(r.recordChanges(saved.state.claimReservations)).length, 1);
  assert.notEqual(saved.state.claimRoot, state.claimRoot);
  const root = state.claimSnapshot.maps.claimReservations.storage;
  assert.throws(() => r.recordGet(new r.ClaimStorage({ get: id => id === root ? undefined : rows.get(id), cacheSize: 2 }).load(state).claimReservations, 'absent'), /claim_state_proof/);
  const forged = structuredClone(state); forged.claimSnapshot.maps.claimReservations = { storage: null, root: r.EMPTY_NAMED_ROOT };
  assert.throws(() => storage.load(forged), /claim_state_predecessor/);
  const hot = structuredClone(state); hot.settlementRoundCursor++;
  assert.throws(() => storage.load(hot), /claim_state_hot/);
});

test('a stale but internally valid node cannot occupy a newer map position', () => {
  const rows = new Map(), storage = new r.ClaimStorage({ get: id => rows.get(id), cacheSize: 1 });
  const old = storage.load(initial()); old.settlementPages = r.recordSet(old.settlementPages, '10/0', { winners: [{ winner: r.hash('first') }] });
  const saved = storage.save(old); for (const w of saved.writes) rows.set(w.id, w.value);
  const next = storage.load(saved.state); next.settlementPages = r.recordSet(next.settlementPages, '10/0', { winners: [{ winner: r.hash('second') }] });
  const newer = storage.save(next); for (const w of newer.writes) rows.set(w.id, w.value);
  const oldRoot = saved.state.claimSnapshot.maps.settlementPages.storage, newRoot = newer.state.claimSnapshot.maps.settlementPages.storage;
  const reader = new r.ClaimStorage({ get: id => rows.get(id === newRoot ? oldRoot : id), cacheSize: 1 });
  assert.throws(() => r.recordGet(reader.load(newer.state).settlementPages, '10/0'), /claim_state_proof/);
});


test('retained numeric checkpoints authenticate before decimal conversion and keep their identity until saved', () => {
  const old = initial();
  for (const key of ['counted', 'lastTip', 'highestTip', 'observation', 'lastSequence', 'namedSequence', 'settlementRoundCursor']) {
    old[key] = old.claimSnapshot.hot[key] = Number(old[key]);
  }
  old.claimRoot = r.claimStateRoot(old.claimSnapshot);
  const bytes = r.stableJSON(old), storage = new r.ClaimStorage({ get: () => undefined, cacheSize: 2 });
  const loaded = storage.load(old, { decimal: true });
  assert.equal(loaded.counted, '9'); assert.equal(loaded.lastSequence, '-1');
  assert.equal(loaded.claimRoot, old.claimRoot); assert.equal(r.stableJSON(old), bytes);
  const saved = storage.save(loaded).state;
  assert.notEqual(saved.claimRoot, old.claimRoot); assert.equal(saved.claimSnapshot.hot.counted, '9');
  assert.equal(storage.load(saved, { decimal: true }).counted, '9');
  const forged = structuredClone(old); forged.counted = '9';
  assert.throws(() => storage.load(forged, { decimal: true }), /claim_state_hot/);
  forged.counted = 10; assert.throws(() => storage.load(forged, { decimal: true }), /claim_state_hot/);
});
