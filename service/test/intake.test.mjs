import test from 'node:test';
import assert from 'node:assert/strict';
import { Intake } from '../src/intake.mjs';
import { Store } from '../src/store.mjs';
import { rules } from '../src/rules.mjs';
import { temp, network, secret, fixtureHistory, makeMove, agent, signEd } from './helpers.mjs';
test('signed receipts survive restart, deduplicate concurrent sends, and seal exact inclusion', async () => {
  const path = await temp(), history = fixtureHistory(); let s = await Store.open(path);
  let intake = new Intake({ store: s, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  try {
    await intake.observe({ tip: 100, hash: history.hashAt(100), counted: 95, confirmed: 95 });
    const move = makeMove(history, 100), text = rules.stableJSON(move);
    const receipts = await Promise.all(Array.from({ length: 10 }, () => intake.accept(text)));
    assert.equal(new Set(receipts.map(r => r.sequence)).size, 1); assert.equal(s.count('dedupe'), 1);
    await s.close(); s = await Store.open(path); intake = new Intake({ store: s, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
    assert.deepEqual(await intake.accept(text), receipts[0]);
    const sealed = await intake.observe({ tip: 101, hash: history.hashAt(101), counted: 96, confirmed: 96 });
    assert.equal(sealed.count, 1); assert.equal(rules.verifyReceiptRoot(sealed.receiptRoot, [receipts[0]], { gateway: intake.gateway, network, tip: 100, hash: history.hashAt(100) }), true);
    const r = await intake.accept(rules.stableJSON(makeMove(history, 101))); assert.equal(r.sequence, 2);
  } finally { await s.close(); }
});
test('a reorg cannot reopen the receipt cutoff; tampered signatures and puzzles fail', async () => {
  const history = fixtureHistory(), s = await Store.open(await temp());
  const intake = new Intake({ store: s, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  try {
    for (const tip of [100, 101, 102, 101]) await intake.observe({ tip, hash: history.hashAt(tip), counted: 97, confirmed: 96 });
    await assert.rejects(intake.accept(rules.stableJSON(makeMove(history, 100))), /claim_window/);
    const tampered = makeMove(history, 101); tampered.sig = '00'.repeat(64); await assert.rejects(intake.accept(rules.stableJSON(tampered)), /invalid_move/);
    const protectedIntake = new Intake({ store: s, network, secret, hashAt: history.hashAt, puzzleBits: 12 });
    await assert.rejects(protectedIntake.accept(rules.stableJSON(makeMove(history, 101, agent(2)))), /invalid_move/);
    const valid = makeMove(history, 101, agent(3), 'header', 12); assert.equal((await protectedIntake.accept(rules.stableJSON(valid))).sequence, 1);
  } finally { await s.close(); }
});
test('500 bundled agent headers and claims fit admission and enforce a hard cap', async () => {
  const history = fixtureHistory(), s = await Store.open(await temp()), intake = new Intake({ store: s, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  try {
    await intake.observe({ tip: 100, hash: history.hashAt(100), counted: 95, confirmed: 95 });
    const promises = [];
    for (let i = 0; i < 500; i++) promises.push(intake.accept(rules.stableJSON(makeMove(history, 100, agent(i)))));
    await Promise.all(promises); assert.equal(s.count('dedupe'), 500); assert.ok(intake.reserved <= 200000);
    intake.auditLimit = intake.reserved; await assert.rejects(intake.accept(rules.stableJSON(makeMove(history, 100, agent(1001)))), /audit_capacity/);
  } finally { await s.close(); }
});

test('intake refuses plain discovery proposal moves before issuing receipts', async () => {
  const history = fixtureHistory(), store = await Store.open(await temp()), who = agent();
  const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  try {
    await intake.observe({ tip: 100, hash: history.hashAt(100), counted: 95, confirmed: 95 });
    const move = { v: 1, network, a: who.address, t: 'proposal', b: 100, h: history.hashAt(100),
      p: { name: 'dmwplain', pat: '[12]', fld: 4, dt: 'n' }, w: '0' };
    // Sign invalid wire bytes without passing through move-type validation.
    move.sig = signEd(Buffer.from(rules.hash(`dmw-move-v1|${network}|${rules.stableJSON(move)}`), 'hex'), who.secret);
    await assert.rejects(intake.accept(rules.stableJSON(move)), /move_type/);
    assert.equal(store.count('dedupe'), 0); assert.equal(store.get('meta', 'receiptSequence'), null);
  } finally { await store.close(); }
});


test('the default historical claim bundle is admitted above the former 4 KB body limit', async () => {
  const history = fixtureHistory(), store = await Store.open(await temp()), who = agent();
  const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  try {
    await intake.observe({ tip: 150, hash: history.hashAt(150), counted: 150, confirmed: 150 });
    const payload = { window: 150, header: { height: 150, raw: history.raw(150) }, plots: Array.from({ length: rules.CLAIM_DEFAULTS.claimsPerWindow }, (_, i) => ({ block: i, patterns: [0xffffffff] })) };
    const signed = rules.solveMove({ v: 1, network, a: who.address, t: 'claim', b: 150, h: history.hashAt(150), p: payload }, who.secret, 0);
    const text = rules.stableJSON(signed);
    assert.ok(Buffer.byteLength(text) > 4096); assert.ok(Buffer.byteLength(text) <= rules.MOVE_DEFAULTS.maxBytes);
    assert.equal((await intake.accept(text)).sequence, 1);
    // Admission cannot choose a winning subset by first arrival. Replay decides
    // conflicts and the aggregate per-window budget after receiving every move.
    const conflict = rules.solveMove({ ...signed, p: { window: 150, plots: [{ block: 0, patterns: [1] }] } }, who.secret, 0);
    assert.equal((await intake.accept(rules.stableJSON(conflict))).sequence, 2);
  } finally { await store.close(); }
});
