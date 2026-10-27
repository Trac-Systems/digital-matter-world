import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { headerFixture, headerAgent, network } from './header-fixture.mjs';
const a = headerAgent(1).agent, b = headerAgent(2).agent;
const slot = (block, pattern) => ({ id: r.findId(block, pattern), block, pattern, asset: r.patternAsset(pattern), count: 3 });

test('header draws cover every unclaimed pattern in that block, deduplicate keys and leave claimed slots unchanged', () => {
  const slots = Array.from({ length: 24 }, (_, p) => slot(20, p)); slots.push(slot(10, 0), slot(11, 0));
  const base = { window: 20, counted: 23, decidingHash: r.hash('header draw'), slots,
    claims: [{ agent: a, window: 20, block: 20, patterns: [0, 1] }] };
  const claimed = r.settleClaims(base), senders = [{ block: 20, agent: a }, { block: 20, agent: b }];
  const result = r.settleClaims({ ...base, headerSenders: senders });
  assert.deepEqual(result.draws.filter(w => w.source === 'claim'), claimed.draws);
  assert.equal(result.winners.filter(w => w.source === 'header').length, 22);
  assert.ok(!result.winners.some(w => w.block === 11));
  assert.ok(!result.winners.some(w => w.pattern < 2 && w.block === 20 && w.source === 'header'));
  assert.equal(new Set(result.winners.map(w => w.id)).size, result.winners.length);
  assert.ok(result.winners.every(w => w.count === 3));
  assert.deepEqual(result, r.settleClaims({ ...base, slots: [...slots].reverse(), headerSenders: [...senders].reverse().concat(senders) }));
});

test('each correct sender has one ticket per unclaimed pattern; deterministic ties have no arrival preference', () => {
  const wins = { [a]: 0, [b]: 0 };
  for (let i = 0; i < 500; i++) {
    const result = r.settleClaims({ window: 20, counted: 23, decidingHash: r.hash(String(i)), slots: [slot(20, 0)], claims: [],
      headerSenders: [{ block: 20, agent: a }, { block: 20, agent: b }, { block: 20, agent: a }] });
    const winner = result.winners[0]; assert.equal(winner.claimers.length, 2); wins[winner.winner]++;
  }
  assert.ok(wins[a] > 180 && wins[a] < 320); assert.equal(wins[a] + wins[b], 500);
});

test('correct witnessed headers at H and H+1 earn whole units, ordinary finder mint rights and the full window', () => {
  const f = headerFixture();
  f.add(20, [{ type: 'claim', payload: { window: 20, plots: [{ block: 20, patterns: [0] }], header: f.header(20) } }]);
  const received = f.add(21, [{ who: 2 }, { who: 1 }]);
  assert.equal(received.state.rounds[0].headerSenders.length, 2);
  const closed = f.add(22, [{ who: 3 }]); assert.equal(closed.file.moves[0].reason, 'header_window');
  for (let tip = 23; tip <= 28; tip++) f.add(tip);
  const credited = f.files.find(file => file.settlements.some(s => s.window === 20 && s.winners.length));
  const winners = credited.settlements.find(s => s.window === 20).winners;
  assert.equal(winners.length, 3); assert.equal(winners[0].source, 'claim'); assert.equal(winners[0].winner, a);
  assert.ok(winners.filter(w => w.source === 'header').every(w => w.tickets === 2));
  const balances = r.recordObject(f.state.balances);
  for (let p = 0; p < 3; p++) assert.equal(Object.values(balances).reduce((n, v) => n + BigInt(v[r.patternAsset(p)] ?? 0), 0n), 2n);
  const w = winners.find(w => w.source === 'header'), find = r.mintCandidate({ pattern: f.patterns[w.pattern], block: 20, history: f.history, state: f.state });
  assert.equal(find.source, 'header'); assert.equal(find.findHeight, 22);
  assert.deepEqual(r.mintRight({ find, owner: w.winner, counted: 22 }), { allowed: true, role: 'finder', until: 1030 });
  assert.equal(r.mintRight({ find, owner: headerAgent(8).agent, counted: 1029 }).allowed, false);
  assert.equal(r.mintRight({ find, owner: headerAgent(8).agent, counted: 1030 }).allowed, true);
  const who = [headerAgent(1), headerAgent(2)].find(k => k.agent === w.winner);
  const request = { owner: who.agent, asset: w.asset, block: 20, amount: String(w.count), receive: r.hash('receiver'), nonce: r.hash('header-mint'), until: 30, expires: 100 };
  assert.equal(r.acceptMintRequest({ request, sig: r.signRequest('rq', network, request, who.secret), network, counted: 23, find, balance: String(w.count) }).op.op, 'rq');
  assert.deepEqual(r.decodeBinary(r.encodeBinary(f.files.at(-1))), f.files.at(-1));
  assert.ok(JSON.parse(Buffer.from(r.summaryBytes(credited))).settlements[0].winners.every(w => w.winner.startsWith('trac1')));
});

test('historic headers and wrong tip headers award nothing; an unfound slot cannot mint', () => {
  const f = headerFixture(); f.add(20);
  const received = f.add(21, [{ payload: f.header(10) }, { who: 2, payload: { height: 20, raw: f.header(10).raw } }]);
  assert.deepEqual(received.file.moves.map(m => m.reason), ['header_window', 'header_mismatch']);
  for (let tip = 22; tip <= 28; tip++) f.add(tip);
  assert.equal(f.files.at(-1).settlements[0].winners.length, 0);
  assert.throws(() => r.mintCandidate({ pattern: f.patterns[0], block: 20, history: f.history, state: f.state }), /mint_no_find/);
});

for (const changed of [20, 22]) test(`header finds are void with zero supply after pre-settlement reorg at ${changed}`, () => {
  const f = headerFixture(); f.add(20, [{}]); for (let tip = 21; tip <= 26; tip++) f.add(tip);
  const hashAt = h => h === changed ? r.hash('reorg') : f.hashAt(h);
  const result = f.add(27, [], { hashAt });
  assert.equal(result.file.settlements[0].void, true); assert.equal(r.recordSize(result.state.finds), 0); assert.equal(r.recordSize(result.state.balances), 0);
});

test('large header awards continue within existing batch limits, survive serialization and never duplicate supply', () => {
  const f = headerFixture({ count: 30, settings: { maxAssets: 10 } }); f.add(20, [{}]);
  for (let tip = 21; tip <= 26; tip++) f.add(tip);
  let result = f.add(27); assert.equal(result.file.settlements[0].complete, false); assert.equal(r.recordSize(result.state.finds), 10);
  assert.ok(result.file.ops.length <= 12);
  // Accepted credits fix the draw: a later deep reorg must not redraw it.
  const hashAt = h => h === 20 ? r.hash('late reorg') : f.hashAt(h);
  for (let tip = 28; tip <= 31; tip++) result = f.add(tip, [], { state: JSON.parse(JSON.stringify(f.state)), hashAt });
  const finds = Object.values(r.recordObject(result.state.finds));
  assert.equal(finds.length, 30); assert.ok(finds.every(w => w.findHeight >= 22 && w.findHeight <= 24 && w.source === 'header'));
  assert.equal(Object.values(r.recordGet(result.state.balances, a)).reduce((n, x) => n + BigInt(x), 0n), 60n);
  assert.equal(f.files.flatMap(f => f.ops).filter(o => o.op === 'ac').reduce((n, op) => n + op.assets.length, 0), 30);
  assert.ok(f.files.every(f => f.ops.length <= 12));
});

test('header participation remains signed and puzzle guarded', () => {
  const f = headerFixture({ settings: { puzzleBits: 32 } });
  const result = f.add(20, [{}]); assert.equal(result.file.moves[0].reason, 'puzzle');
  assert.deepEqual(result.state.rounds[0].headerSenders, []);
  for (let tip = 21; tip <= 28; tip++) f.add(tip);
  assert.equal(r.recordSize(f.state.finds), 0); assert.equal(r.recordSize(f.state.balances), 0);
});

test('hundreds of unclaimed patterns publish bounded winner segments without losing any find or mint window', () => {
  const f = headerFixture({ count: 500, settings: { maxAssets: 100 } }); f.add(20, [{}]);
  for (let tip = 21; tip <= 40; tip++) f.add(tip);
  assert.equal(r.recordSize(f.state.finds), 500);
  const settlements = f.files.flatMap(f => f.settlements).filter(s => s.window === 20);
  assert.ok(settlements.length > 1); assert.equal(settlements.at(-1).complete, true);
  const winners = settlements.flatMap(s => s.winners);
  assert.equal(winners.length, 500); assert.equal(new Set(winners.map(w => w.id)).size, 500);
  assert.ok(f.files.every(file => r.summaryBytes(file).length <= 1000000 && r.encodeBinary(file).length <= 1500000));
  assert.equal(new Set(Object.values(r.recordObject(f.state.finds)).map(f => f.findHeight)).size, 5);
  assert.equal(Object.values(r.recordGet(f.state.balances, a)).reduce((n, x) => n + BigInt(x), 0n), 1000n);
});
