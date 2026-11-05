import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { advanceClaimWindow, ClosureBudget } from '../src/claim-closure.js';
import { emptyFrontier, appendFrontier, frontierRoot } from '../src/merkle-frontier.js';
import { orderedIndex } from '../src/closure-index.js';

const owner = i => r.hash(`closure-owner/${i}`);
const settings = work => r.batchSettings({ document: r.settingsRevision({ network: 'local', effectiveBatch: '1', effectiveBitcoinWindow: '1000',
  values: { ...r.SETTINGS_PROFILE, closureWorkBudget: work, settlementPageRows: 7 } }) });
const history = { get: height => ({ height, hash: r.hash(String(height)) }) };
const patterns = Object.fromEntries(Array.from({ length: 4 }, (_, n) => [String(n), { number: String(n), pat: '[0-9]', fld: 4, dt: 'n' }]));
function fixture(s, count = 12, cacheSize = 2) {
  const nodes = new Map(), loader = () => new r.ClaimStorage({ get: id => nodes.get(id), cacheSize });
  const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: '1000' } }, '999');
  const persist = (storage, state) => { const saved = storage.save(state); for (const row of saved.writes) nodes.set(row.id, row.value); return saved.state; };
  const storage = loader(), state = storage.load({ ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot) });
  const event = r.claimRound('1000', r.hash('1000'), '1000', { root: r.hash('catalog'), nextNumber: '4', revision: '1' }); state.rounds = [event];
  const enter = (i, plots) => r.enterClaims({ state, event, agent: owner(i), plots, patterns, history, settings: s });
  for (let i = 0; i < count; i++) enter(i, [{ block: '10', patterns: ['0', '1', '2'] }, { block: String(20 + i), patterns: ['0', '3'] }]);
  enter(0, [{ block: '10', patterns: ['0', '1', '2'] }]); // exact duplicate
  enter(1, [{ block: '10', patterns: ['1'] }]); // conflicting plot
  event.headerSenders = [owner(4), owner(2), owner(4)];
  return { state: persist(storage, state), nodes, loader, persist };
}
function finish(f, s, seed = r.hash('1002')) {
  let state = f.state, chunks = 0, max = { work: 0, reads: 0, bytes: 0 }, closure; const progress = [];
  while (!state.rounds[0].closed) {
    const storage = f.loader(), loaded = storage.load(state), event = loaded.rounds[0], budget = new ClosureBudget(s, storage.storage);
    const out = advanceClaimWindow({ state: loaded, event, decidingHash: seed, counted: '1002', settings: s, budget });
    assert.ok(out.progress.steps > 0); assert.ok(out.progress.work <= s.closureWorkBudget);
    assert.ok(out.progress.reads <= s.closureReadBudget); assert.ok(out.progress.bytes <= s.closureByteBudget);
    progress.push(out.progress);
    for (const k of Object.keys(max)) max[k] = Math.max(max[k], out.progress[k]);
    closure = out.completed ?? closure; state = f.persist(storage, loaded); chunks++; assert.ok(chunks < 10000);
  }
  const loaded = f.loader().load(state), event = loaded.rounds[0], winners = [], claims = [];
  while (r.compareOrdinal(event.cursor, event.pages) < 0) {
    const page = r.takeSettlementPage({ state: loaded, event, height: '1002', budget: new r.CreditBudget(s) });
    assert.ok(page); winners.push(...page.winners); claims.push(...page.claims);
  }
  return { state, closure, chunks, max, winners, claims, progress };
}

test('incremental Merkle frontier matches odd and even existing trees', () => {
  let frontier = emptyFrontier(); const files = [];
  for (let i = 0; i < 257; i++) { assert.equal(frontierRoot(frontier), r.merkleRoot(files)); files.push(`leaf/${i}`); frontier = appendFrontier(frontier, files.at(-1)); }
});

test('ordered ticket index selects the same sorted ranks after adversarial insertion orders', () => {
  for (const order of [Array.from({ length: 300 }, (_, i) => owner(i)).sort(), Array.from({ length: 300 }, (_, i) => owner(i)).sort().reverse()]) {
    const rows = new Map(), tree = orderedIndex({ get: key => rows.get(key), set: (key, value) => rows.set(key, value) }, 'test'); let root = null;
    for (const value of order) root = tree.insert(root, value);
    root = tree.insert(root, order[0]); assert.equal(tree.count(root), 300n);
    assert.deepEqual(order.map((_, i) => tree.at(root, i)), [...order].sort());
    assert.ok(rows.get(`test/${root}`).height < 15);
  }
});

test('cold authenticated closure chunks preserve legacy winners, duplicate/conflict outcomes and header draws', () => {
  const results = [17, 137, 2048].map(work => {
    const s = settings(work), f = fixture(s), old = f.loader().load(f.state), event = old.rounds[0];
    const legacy = r.freezeClaimWindow({ state: old, event, decidingHash: r.hash('1002'), counted: '1002', settings: s });
    const result = finish(f, s); assert.equal(result.closure.winners, legacy.winners);
    for (const w of result.winners) assert.equal(w.winner, r.recordGet(old.claimReservations, w.id).winner);
    const slot = { id: r.findIdV2('1000', '0'), block: '1000', pattern: '0', asset: 'p2:0', count: 4 };
    const loaded = f.loader().load(result.state);
    assert.equal(r.implicitHeaderFind({ state: loaded, slot, pattern: patterns['0'], materializedAt: '1003' }).winner,
      r.implicitHeaderFind({ state: old, slot, pattern: patterns['0'], materializedAt: '1003' }).winner);
    assert.ok(result.claims.some(c => c.reason === 'conflicting_claims')); return result;
  });
  assert.ok(results[0].chunks > 10);
  for (const result of results.slice(1)) { assert.deepEqual(result.winners, results[0].winners); assert.equal(result.closure.root, results[0].closure.root); assert.equal(result.closure.inputRoot, results[0].closure.inputRoot); }
});

test('one-step closure resumes after every durable checkpoint and rejects forged cursor, missing and stale rows', () => {
  const s = settings(1), f = fixture(s, 2), result = finish(f, s); assert.ok(result.chunks > 40);
  const storage = f.loader(), loaded = storage.load(f.state), event = loaded.rounds[0];
  advanceClaimWindow({ state: loaded, event, decidingHash: r.hash('1002'), counted: '1002', settings: s, budget: new ClosureBudget(s, storage.storage) });
  const first = f.persist(storage, loaded), forged = structuredClone(first); forged.rounds[0].closing.scanRow++;
  assert.throws(() => f.loader().load(forged), /claim_state_(hot|predecessor)/);
  const root = first.claimSnapshot.maps.claimInputs.storage, missing = new r.ClaimStorage({ get: id => id === root ? undefined : f.nodes.get(id), cacheSize: 2 });
  const bad = missing.load(first);
  assert.throws(() => advanceClaimWindow({ state: bad, event: bad.rounds[0], decidingHash: r.hash('1002'), counted: '1002', settings: s, budget: new ClosureBudget(s, missing.storage) }), /claim_state_proof/);
  const oldRoot = f.state.claimSnapshot.maps.claimInputs.storage, stale = new r.ClaimStorage({ get: id => f.nodes.get(id === root ? oldRoot : id), cacheSize: 2 });
  const rolled = stale.load(first);
  assert.throws(() => advanceClaimWindow({ state: rolled, event: rolled.rounds[0], decidingHash: r.hash('1002'), counted: '1002', settings: s, budget: new ClosureBudget(s, stale.storage) }), /claim_state_proof/);
});

test('independent cache sizes produce identical metering and authenticated chunk boundaries', () => {
  const s = settings(17), results = [1, 16, 4096].map(cache => finish(fixture(s, 12, cache), s));
  for (const result of results.slice(1)) {
    assert.deepEqual(result.progress, results[0].progress);
    assert.equal(result.state.claimRoot, results[0].state.claimRoot);
  }
});

test('read and byte exhaustion checkpoints completed units without losing the next unit', () => {
  const base = settings(100000), s = r.batchSettings({ document: { ...base.document,
    values: { ...base.document.values, closureReadBudget: 32768, closureByteBudget: 33554432 } } });
  const f = fixture(s, 400), result = finish(f, s);
  assert.ok(result.chunks > 1); assert.ok(result.max.work < s.closureWorkBudget);
  assert.equal(result.winners.length, 803);
});

test('void windows finish in bounded pages and a committed draw keeps its seed across later chain changes', () => {
  const s = settings(1), f = fixture(s, 2); let state = f.state, chunks = 0, completed;
  while (!state.rounds[0].closed) {
    const storage = f.loader(), loaded = storage.load(state), event = loaded.rounds[0];
    const result = advanceClaimWindow({ state: loaded, event, decidingHash: null, counted: '1002', settings: s,
      budget: new ClosureBudget(s, storage.storage), voided: true });
    completed = result.completed; state = f.persist(storage, loaded); chunks++;
  }
  assert.ok(chunks > 1); assert.equal(completed.void, true); assert.equal(completed.winners, '0');
  const original = fixture(settings(17)), resumed = fixture(settings(17));
  const storage = resumed.loader(), loaded = storage.load(resumed.state);
  advanceClaimWindow({ state: loaded, event: loaded.rounds[0], decidingHash: r.hash('1002'), counted: '1002', settings: settings(17), budget: new ClosureBudget(settings(17), storage.storage) });
  resumed.state = resumed.persist(storage, loaded);
  assert.deepEqual(finish(resumed, settings(17), r.hash('reorganized seed')).winners, finish(original, settings(17)).winners);
});

test('the meter permits a verified metadata row larger than a settlement page and rejects nonprogressing settings', () => {
  const s = settings(1), row = { value: 'a'.repeat(600000) }, storage = { row: () => row }, budget = new ClosureBudget(s, storage);
  assert.ok(r.utf8(r.stableJSON(row)).length > s.auditPageBytes * 2 + s.document.values.moveBytes * 2);
  assert.equal(budget.run(() => storage.row()), row); assert.equal(budget.reads, 1);
  assert.equal(budget.bytes, r.utf8(r.stableJSON(row)).length);
  assert.throws(() => r.validateSettings({ ...s.document.values, closureByteBudget: 16777216 }), /settings_closure_progress/);
});

test('a settings successor resumes a closing checkpoint with new budgets and its original layout and finder policy', () => {
  const original = settings(17), f = fixture(original, 12), initial = f.loader(), loaded = initial.load(f.state);
  loaded.rounds[0].policy = { settingsHash: r.hashObject(original.document), claimsPerWindow: 100, claimWindowBlocks: 2, finderWindow: 1008 };
  f.state = f.persist(initial, loaded);
  const reference = finish(f, original), storage = f.loader(), partial = storage.load(f.state);
  advanceClaimWindow({ state: partial, event: partial.rounds[0], decidingHash: r.hash('1002'), counted: '1002', settings: original,
    budget: new ClosureBudget(original, storage.storage) });
  f.state = f.persist(storage, partial);
  assert.equal(f.state.rounds[0].closing.layout.rows, 7);
  const document = r.settingsRevision({ network: 'local', previous: original.document, effectiveBatch: '2', effectiveBitcoinWindow: '1001',
    values: { ...original.document.values, closureWorkBudget: 2048, closureReadBudget: 262144, closureByteBudget: 134217728,
      settlementPageRows: 3, settlementPagesPerObservation: 64, finderWindow: 10 } });
  r.settingsSuccessor(original.document, document);
  const successor = r.batchSettings({ document }), resumed = finish(f, successor);
  assert.ok(resumed.chunks < reference.chunks);
  assert.ok(resumed.progress[0].work > original.closureWorkBudget);
  assert.deepEqual(resumed.closure, reference.closure);
  assert.deepEqual(resumed.winners, reference.winners);
  assert.deepEqual(resumed.claims, reference.claims);
  const payout = f.loader().load(resumed.state), event = payout.rounds[0];
  let page;
  do { page = r.takeSettlementPage({ state: payout, event, height: '2000', budget: new r.CreditBudget(successor) }); }
  while (page && !page.winners.length);
  assert.ok(page.winners.length <= 3, 'current delivery rows may split the original seven-row page');
  const find = r.recordGet(payout.finds, page.winners[0].id);
  assert.equal(find.settingsHash, r.hashObject(original.document));
  assert.equal(find.finderUntil, String(BigInt(find.findHeight) + 1008n));
});
