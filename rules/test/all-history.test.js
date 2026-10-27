import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { headerFixture, headerAgent } from './header-fixture.mjs';
const a = headerAgent(1).agent, b = headerAgent(2).agent;
const slot = (block, pattern = 0) => ({ id: r.findId(block, pattern), block, pattern, asset: r.patternAsset(pattern), count: 3 });
const claim = (agent, block, window = 1000000, patterns = [0]) => ({ agent, block, window, patterns });
const args = { window: 1000000, counted: 1000003, decidingHash: r.hash('future block'), slots: [slot(400000)], claims: [claim(a, 400000)] };

test('a block older than ten Bitcoin years is claimable without an opening record', () => {
  assert.ok(args.window - 400000 > 10 * 365 * 144);
  const result = r.settleClaims(args);
  assert.equal(result.winners[0].winner, a); assert.equal(result.winners[0].block, 400000);
  assert.equal(result.claims[0].reason, 'entered');
});
test('contested historical slots draw fairly, once per key, without arrival preference', () => {
  const claims = [claim(a, 400000), claim(b, 400000)], wins = { [a]: 0, [b]: 0 };
  for (let i = 0; i < 500; i++) {
    const input = { ...args, decidingHash: r.hash(String(i)), claims };
    const first = r.settleClaims(input), reversed = r.settleClaims({ ...input, claims: [claims[1], claims[0], claims[1]] });
    assert.deepEqual(first, reversed); assert.equal(first.winners.length, 1); assert.equal(first.winners[0].claimers.length, 2);
    wins[first.winners[0].winner]++;
  }
  assert.ok(wins[a] > 180 && wins[a] < 320); assert.equal(wins[a] + wins[b], 500);
});
test('already-found slots are rejected in claims and excluded from tip header fallback', () => {
  assert.equal(r.settleClaims({ ...args, finds: { [slot(400000).id]: { finder: b } } }).claims[0].reason, 'already_found');
  const tip = slot(args.window), input = { ...args, slots: [tip], claims: [claim(a, args.window)], finds: { [tip.id]: { finder: b } }, headerSenders: [{ block: args.window, agent: a }] };
  assert.equal(r.settleClaims(input).winners.length, 0);
});
test('the per-agent budget covers all plots and receipts; duplicates cost one ticket', () => {
  const slots = [1, 2, 3, 4, 5].map(h => slot(h)), claims = slots.map(s => claim(a, s.block));
  const input = { ...args, slots, claims, settings: { claimsPerWindow: 4 } };
  assert.equal(r.CLAIM_DEFAULTS.claimsPerWindow, 100);
  assert.ok(r.settleClaims(input).claims.every(c => c.reason === 'claim_budget'));
  assert.equal(r.settleClaims(input).winners.length, 0);
  const four = claims.slice(0, 4);
  assert.equal(r.settleClaims({ ...input, claims: [...four, ...four] }).winners.length, 4);
  assert.equal(r.settleClaims({ ...input, settings: { claimsPerWindow: 5 } }).winners.length, 5);
  assert.throws(() => r.settleClaims({ ...input, settings: { claimsPerWindow: r.MAX_CLAIMS_PER_WINDOW + 1 } }), /claim_settings/);
  assert.throws(() => r.settleClaims({ ...input, settings: { claimsPerWindow: 0 } }), /claim_settings/);
});
test('many agents have no global finds-per-window cap', () => {
  const slots = Array.from({ length: 100 }, (_, i) => slot(i));
  const claims = slots.map((s, i) => claim(r.hash('agent-' + i), s.block));
  assert.equal(r.settleClaims({ ...args, slots, claims }).winners.length, 100);
});
test('historical claims settle end to end and a later window cannot award the same slot', () => {
  const f = headerFixture();
  const payload = window => ({ window, plots: [{ block: 10, patterns: [0] }] });
  f.add(20, [{ type: 'claim', payload: payload(20) }]);
  f.add(21, [{ who: 2, type: 'claim', payload: payload(21) }]);
  for (let tip = 22; tip <= 29; tip++) f.add(tip);
  assert.equal(r.recordGet(f.state.finds, r.findId(10, 0)).finder, a);
  assert.equal(r.recordGet(f.state.balances, a).p0, '2');
  assert.equal(r.recordGet(f.state.balances, b), undefined);
  assert.equal(f.files.flatMap(f => f.settlements).find(s => s.window === 21).claims[0].reason, 'already_found');
  const late = f.add(30, [{ who: 2, type: 'claim', payload: payload(30) }]);
  assert.equal(late.file.moves[0].reason, 'already_found');
});
test('claim replay leaves earlier snapshots immutable and refuses future historical blocks', () => {
  const f = headerFixture(); f.add(20); const previous = f.state, before = JSON.stringify(previous);
  f.add(21, [{ type: 'claim', payload: { window: 20, plots: [{ block: 10, patterns: [0] }] } }]);
  assert.equal(JSON.stringify(previous), before);
  assert.equal(previous.rounds[0].slots.length, 3);
  const out = f.add(22, [{ type: 'claim', payload: { window: 22, plots: [{ block: 21, patterns: [0] }] } }]);
  assert.equal(out.file.moves[0].reason, 'not_counted');
});
test('grouped credits commit all finds and never move credit across a debit barrier', () => {
  const one = r.creditOp(a, 'p0', '2'), two = r.creditOp(a, 'p0', '3'), barrier = r.notaryOp('link/1', '{}');
  assert.deepEqual(r.aggregateCredits([one, two]), [{ op: 'ac', to: a, assets: [['p0', '5']] }]);
  assert.deepEqual(r.aggregateCredits([one, barrier, two]).map(o => o.op), ['ac', 'kv', 'ac']);
  const f = headerFixture(); f.add(20, [{}]); for (let tip = 21; tip <= 28; tip++) f.add(tip);
  const built = f.build(), commitment = built.batch.ops.find(o => o.key === 'finds/batch/1');
  assert.equal(commitment.value, r.findsCommitment(f.files));
  const changed = structuredClone(f.files); changed.flatMap(f => f.settlements).find(s => s.winners.length).winners[0].winner = b;
  assert.notEqual(r.findsCommitment(changed), commitment.value);
  assert.equal(built.batch.ops.filter(o => o.op === 'ac').length, 1);
});
test('obsolete opening and charter APIs are absent; fees keep the removed share in treasury', () => {
  for (const key of ['initialSchedule', 'advanceSchedule', 'charter', 'charterId', 'signCharter', 'charterRecord', 'scheduleRecords', 'verifyCharterInput']) assert.equal(key in r, false);
  assert.throws(() => r.feeFor('charter', '1'), /fee_kind/);
  assert.throws(() => r.splitFee('100', { kind: 'charter' }), /fee_kind/);
  const split = r.splitFee('100', { linked: true, discovered: true });
  assert.equal(split.treasury, '30'); assert.equal('charterer' in split, false);
});
