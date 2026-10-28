import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { ed25519 } from '@noble/curves/ed25519';
import { attest, receiptSigners } from './witness-fixture.mjs';

const secret = new Uint8Array(32).fill(9), gateway = r.bytesToHex(ed25519.getPublicKey(secret)), network = 'local';
const patterns = [{ number: 0, pat: '[0-9]', fld: 4, dt: 'n' }];
const history = { get: height => ({ height, hash: r.hash(String(height)) }) };
const settings = { batchVersion: 2, ruleset: 'sc1', settingsRevision: r.hash('settings'), receiptSigners, puzzleBits: 0 };
const catalog = { root: r.hash('catalog'), nextNumber: 1, revision: 1 };
const owner = i => r.hash('test-agent/' + i);

function prepare(order, pageRows = 128) {
  const state = {}, event = r.claimRound(60000, r.hash('60000'), 60000, catalog), s = { ...settings, settlementPageRows: pageRows };
  for (const i of order) r.enterClaims({ state, event, agent: owner(i), plots: Array.from({ length: 100 }, (_, j) => ({ block: 10 + i * 100 + j, patterns: [0] })), patterns, history, settings: s });
  const closure = r.freezeClaimWindow({ state, event, decidingHash: r.hash('60002'), counted: 60002, settings: s });
  return { state, event, closure, settings: s };
}
test('500 agents × 100 claims settle through bounded pages, including a small credit budget', { timeout: 120000 }, () => {
  const f = prepare(Array.from({ length: 500 }, (_, i) => i)), winners = [], seen = new Set(); let pages = 0, maxBytes = 0;
  assert.equal(f.closure.winners, 50000);
  while (f.event.cursor < f.event.pages) {
    const budget = new r.CreditBudget({ ...settings, maxOps: 12, maxAssets: 10 });
    const page = r.takeSettlementPage({ ...f, height: 60002, budget }); assert.ok(page);
    maxBytes = Math.max(maxBytes, r.encodeBinary(page).length); pages++;
    for (const w of page.winners) { assert.equal(seen.has(w.id), false); seen.add(w.id); winners.push(w); }
  }
  assert.equal(winners.length, 50000); assert.ok(pages > 390); assert.ok(maxBytes <= r.BATCH_V2_DEFAULTS.auditPageBytes);
  assert.equal(r.recordSize(f.state.finds), 50000);
  // Packet permutation and different evidence page sizes cannot choose winners.
  const reversed = prepare(Array.from({ length: 500 }, (_, i) => 499 - i), 73);
  assert.equal(reversed.closure.inputRoot, f.closure.inputRoot);
  for (const w of winners) assert.equal(r.recordGet(reversed.state.claimReservations, w.id).winner, w.winner);
});
test('conflicts, duplicate packets, overflow and deferred header awards preserve fairness', () => {
  const state = {}, event = r.claimRound(100, r.hash('100'), 100, { ...catalog, nextNumber: 2 });
  const p = [...patterns, { ...patterns[0], number: 1 }], enter = (agent, plots) => r.enterClaims({ state, event, agent, plots, patterns: p, history, settings: { claimsPerWindow: 2 } });
  enter(owner(0), [{ block: 10, patterns: [0] }]); enter(owner(0), [{ block: 10, patterns: [0] }]);
  enter(owner(1), [{ block: 10, patterns: [0] }]); enter(owner(1), [{ block: 10, patterns: [1] }]);
  enter(owner(2), [{ block: 11, patterns: [0, 1] }]); enter(owner(2), [{ block: 12, patterns: [0] }]);
  event.headerSenders = [owner(2), owner(0)];
  assert.throws(() => r.freezeClaimWindow({ state, event, decidingHash: r.hash('102'), counted: 101 }), /draw_not_ready/);
  const closure = r.freezeClaimWindow({ state, event, decidingHash: r.hash('102'), counted: 102 }); assert.equal(closure.winners, 1);
  assert.equal(r.recordGet(state.claimReservations, r.findId(10, 0)).winner, owner(0));
  const slot = r.slotsFor(history.get(100), [p[1]])[0];
  const implicit = r.implicitHeaderFind({ state, slot, pattern: p[1], materializedAt: 5000 });
  assert.equal(implicit.findHeight, 102); assert.equal(implicit.materializedAt, 5000);
  assert.equal(r.implicitHeaderFind({ state, slot: { ...slot, pattern: 2 }, pattern: { number: 2 }, materializedAt: 5000 }), null);
  const eager = r.settleClaims({ window: 100, counted: 102, decidingHash: r.hash('102'), slots: [slot], claims: [], headerSenders: event.headerSenders.map(agent => ({ block: 100, agent })) });
  assert.equal(implicit.winner, eager.winners[0].winner);
});
test('hundreds of same-height segments bind predecessors and never close the Bitcoin window early', () => {
  let state = { counted: 100, lastTip: 99 }, previousRoot = r.hash('legacy'), seq = 0;
  const who = new Uint8Array(32).fill(8), address = r.bytesToHex(ed25519.getPublicKey(who));
  const activation = { sequence: 1, previousRoot, height: 100, hash: history.get(100).hash, ruleset: settings.ruleset, settingsRevision: settings.settingsRevision };
  for (let i = 0; i < 200; i++) {
    const move = r.solveMove({ v: 1, network, a: address, t: 'claim', b: 100, h: history.get(100).hash, p: { window: 100, plots: [{ block: 10, patterns: [0] }] } }, who, 0);
    const receipt = r.signReceipt(move, { tip: 100, hash: history.get(100).hash, sequence: ++seq }, secret);
    const prior = r.recordGet(state.receiptSegments, `100/${history.get(100).hash}`);
    const seal = r.sealReceiptSegment([receipt], { network, tip: 100, hash: history.get(100).hash, segment: i, previous: prior?.hash ?? null, ...settings }, secret);
    const input = { height: 100, blockHash: history.get(100).hash, tip: 100, tipHash: history.get(100).hash, network, gateway, history,
      hashAt: h => history.get(h).hash, patterns, entries: [{ move, receipt }], receiptRoot: seal, rootAttestations: attest(seal), settings, state };
    const out = r.processBlock(input); assert.equal(out.file.settlements.length, 0); assert.equal(out.file.moves[0].reason, 'accepted');
    const built = r.buildBatch({ network, epoch: 0, sequence: i + 1, lastTo: 100, previousRoot, files: [out.file], executionHeight: 100, executionHash: history.get(100).hash, activation, settings });
    assert.equal(built.batch.v, 2); assert.equal(built.batch.from, 100); assert.equal(built.batch.to, 100);
    assert.throws(() => r.processBlock({ ...input, state: out.state }), /receipt_segment_predecessor/);
    state = out.state; previousRoot = built.batch.root;
  }
});

test('an audit byte cap trims delivery without changing the frozen page or losing a winner', () => {
  const state = { counted: 102, lastTip: 102 }, event = r.claimRound(100, r.hash('100'), 100, catalog);
  r.enterClaims({ state, event, agent: owner(0), plots: Array.from({ length: 100 }, (_, block) => ({ block, patterns: [0] })), patterns, history });
  r.freezeClaimWindow({ state, event, decidingHash: r.hash('102'), counted: 102 });
  while (!r.recordGet(state.settlementPages, `100/${event.cursor}`).winners) event.cursor++;
  state.rounds = [event];
  const seal = r.sealReceiptSegment([], { network, tip: 102, hash: r.hash('102'), segment: 0, previous: null, ...settings }, secret);
  const output = r.processBlock({ height: 102, blockHash: r.hash('102'), tip: 102, tipHash: r.hash('102'), network, gateway,
    history, hashAt: h => history.get(h).hash, patterns, entries: [], receiptRoot: seal, rootAttestations: attest(seal), state,
    settings: { ...settings, auditPageBytes: 1000, auditMaxBytes: 2000 } });
  assert.ok(output.auditBytes.length <= 2000); assert.ok(output.file.settlements[0].winners.length > 0 && output.file.settlements[0].winners.length < 100);
  assert.equal(output.state.rounds[0].root, event.root); assert.equal(event.offset, 0); assert.equal(r.recordSize(state.finds), 0);
});

test('late naming materializes the original header winner and its original finder interval', () => {
  const state = { counted: 4999, lastTip: 4999, rounds: [] }, event = r.claimRound(100, r.hash('100'), 100, catalog);
  event.headerSenders = [owner(1), owner(2)]; r.freezeClaimWindow({ state, event, decidingHash: r.hash('102'), counted: 102 });
  const who = new Uint8Array(32).fill(7), address = r.bytesToHex(ed25519.getPublicKey(who));
  const move = r.solveMove({ v: 1, network, a: address, t: 'claim', b: 5000, h: r.hash('5000'), p: { window: 5000, plots: [{ block: 100, patterns: [0] }] } }, who, 0);
  const receipt = r.signReceipt(move, { tip: 5000, hash: r.hash('5000'), sequence: 1 }, secret);
  const seal = r.sealReceiptSegment([receipt], { network, tip: 5000, hash: r.hash('5000'), segment: 0, previous: null, ...settings }, secret);
  const output = r.processBlock({ height: 5000, blockHash: r.hash('5000'), tip: 5000, tipHash: r.hash('5000'), network, gateway,
    history, hashAt: h => history.get(h).hash, patterns, entries: [{ move, receipt }], receiptRoot: seal, rootAttestations: attest(seal), state, settings });
  const find = r.recordGet(output.state.finds, r.findId(100, 0));
  assert.equal(find.findHeight, 102); assert.equal(find.materializedAt, 5000); assert.equal(find.window, 100);
  assert.ok([owner(1), owner(2)].includes(find.finder)); assert.notEqual(find.finder, address);
});

test('500 agents sharing 100 slots reuse checked slots and produce exactly 100 fair draws', () => {
  let reads = 0;
  const countedHistory = { get: h => { reads++; return history.get(h); } }, state = {}, event = r.claimRound(1000, r.hash('1000'), 1000, catalog);
  for (let i = 0; i < 500; i++) r.enterClaims({ state, event, agent: owner(i), plots: Array.from({ length: 100 }, (_, block) => ({ block, patterns: [0] })), patterns, history: countedHistory });
  assert.equal(reads, 100);
  const closure = r.freezeClaimWindow({ state, event, decidingHash: r.hash('1002'), counted: 1002 }); assert.equal(closure.winners, 100);
  const winners = [];
  while (event.cursor < event.pages) winners.push(...r.takeSettlementPage({ state, event, height: 1002, budget: new r.CreditBudget() }).winners);
  assert.equal(winners.length, 100); assert.ok(winners.every(w => w.tickets === 500));
});

test('500 agents × 100 different assets fit successive operation and asset budgets', () => {
  const definitions = Array.from({ length: 100 }, (_, number) => ({ ...patterns[0], number })), state = {}, event = r.claimRound(60000, r.hash('60000'), 60000, { ...catalog, nextNumber: 100 });
  for (let i = 0; i < 500; i++) r.enterClaims({ state, event, agent: owner(i), plots: Array.from({ length: 100 }, (_, pattern) => ({ block: 10 + i * 100 + pattern, patterns: [pattern] })), patterns: definitions, history });
  r.freezeClaimWindow({ state, event, decidingHash: r.hash('60002'), counted: 60002 });
  let count = 0;
  while (event.cursor < event.pages) {
    const budget = new r.CreditBudget({ maxAssets: 29, maxOps: 5 }), page = r.takeSettlementPage({ state, event, height: 60002, budget });
    assert.ok(page); count += page.winners.length;
    assert.ok(budget.operations().length <= 3); assert.ok(budget.operations().flatMap(o => o.assets).length <= 29);
  }
  assert.equal(count, 50000); assert.equal(Object.keys(r.recordGet(state.balances, owner(499))).length, 100);
});

test('whole-batch closure limits sum every chunk while allowing idle receipt segments', () => {
  let state = { counted: 100, lastTip: 99 };
  const who = new Uint8Array(32).fill(8), address = r.bytesToHex(ed25519.getPublicKey(who));
  const files = [], previousRoot = r.hash('closure-budget-predecessor');
  const activation = { sequence: 1, previousRoot, height: 100, hash: history.get(100).hash, ruleset: settings.ruleset, settingsRevision: settings.settingsRevision };
  for (let segment = 0; segment < 2; segment++) {
    const prior = r.recordGet(state.receiptSegments, `100/${history.get(100).hash}`);
    const move = r.solveMove({ v: 1, network, a: address, t: 'claim', b: 100, h: history.get(100).hash,
      p: { window: 100, plots: [{ block: 10, patterns: [0] }] } }, who, 0);
    const receipt = r.signReceipt(move, { tip: 100, hash: history.get(100).hash, sequence: segment + 1 }, secret);
    const seal = r.sealReceiptSegment([receipt], { network, tip: 100, hash: history.get(100).hash,
      segment, previous: prior?.hash ?? null, ...settings }, secret);
    const output = r.processBlock({ height: 100, blockHash: history.get(100).hash, tip: 100, tipHash: history.get(100).hash,
      network, gateway, history, hashAt: h => history.get(h).hash, patterns, entries: [{ move, receipt }], receiptRoot: seal,
      rootAttestations: attest(seal), settings, state });
    files.push(output.file); state = output.state;
  }
  const bounded = { ...settings, observationsPerBatch: 1, closureWorkBudget: 10, closureReadBudget: 20, closureByteBudget: 30 };
  const build = files => r.buildBatch({ network, epoch: 0, sequence: 1, lastTo: 100, previousRoot, files,
    executionHeight: 100, executionHash: history.get(100).hash, activation, settings: bounded });
  assert.doesNotThrow(() => build(files));
  const measured = files.map(file => ({ ...file, closureProgress: [{ window: 98, work: 5, reads: 10, bytes: 15 }] }));
  assert.doesNotThrow(() => build(measured));
  for (const metric of ['work', 'reads', 'bytes']) {
    const exceeded = structuredClone(measured); exceeded[1].closureProgress[0][metric]++;
    assert.throws(() => build(exceeded), /batch_closure_budget/, metric);
    const secondWindow = structuredClone(measured);
    secondWindow[0].closureProgress.push({ window: 99, work: 0, reads: 0, bytes: 0, [metric]: 1 });
    assert.throws(() => build(secondWindow), /batch_closure_budget/, metric + ' across windows');
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const bad = structuredClone(measured); bad[0].closureProgress[0][metric] = invalid;
      assert.throws(() => build(bad), /batch_closure_budget/);
    }
  }
});
