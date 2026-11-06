import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SegmentedIntake } from '../src/segmented-intake.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Files } from '../src/files.mjs';
import { Store } from '../src/store.mjs';
import { Outbox } from '../src/transport.mjs';
import { rules } from '../src/rules.mjs';
import { rebuildBatch } from '../../committee/signer/adapter.mjs';
import { temp, network, secret, fixtureHistory, agent, patterns, attestRoot, receiptSigners } from './helpers.mjs';

test('segmented intake, independent signer replay and restart drain same-height settlement pages', async () => {
  const path = await temp(), history = fixtureHistory(30), files = new Files(join(path, 'static')), who = agent();
  const previousRoot = rules.hash('legacy'), activation = { sequence: 1, previousRoot, height: 10, hash: history.hashAt(10), ruleset: 'sc1', settingsRevision: rules.hash('settings') };
  const settings = { batchVersion: 2, ...activation, activation, puzzleBits: 0, receiptSigners, settlementPageRows: 2 };
  let store = await Store.open(path), last = { n: 0, to: 9 }, tip = 10, pipeline, intake, signed = 0; const roots = new Map();
  const create = () => {
    intake = new SegmentedIntake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0, settings });
    const reads = { batchLast: async () => last, committeeEpoch: async () => 0, counted: async () => tip, batchRoot: async n => roots.get(n) ?? null };
    const committee = { attestRoot, signature: async (_, proposal) => {
      const draft = await pipeline.loadDraft();
      const rebuilt = rebuildBatch(network, proposal, { authority: { epoch: 0 }, counted: tip, gateway: intake.gateway, state: draft.startState, patterns: draft.startPatterns,
        inputs: draft.items.map(i => i.input), history, hashAt: history.hashAt, settings: draft.settings, limits: draft.limits, last, activation, previousRoot: draft.previousRoot });
      assert.equal(rebuilt.batch.root, proposal.batch.root); signed++; return { signature: { compact: '00'.repeat(64) } };
    } };
    const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => { last = { n: m.value.n, to: m.value.to }; roots.set(last.n, m.value.root); }, status: async job => ({ state: roots.get(job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
    pipeline = new Pipeline({ store, files, history, intake, reads, committee, outbox: new Outbox({ store, transport, fallbackMs: 100000, retryMs: 0 }), patterns, settings });
  };
  create();
  try {
    await intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip });
    for (let block = 1; block <= 5; block++) {
      const move = rules.solveMove({ v: 1, network, a: who.address, t: 'claim', b: tip, h: history.hashAt(tip), p: { window: 10, plots: [{ block, patterns: [0] }] } }, who.secret, 0);
      await intake.accept(rules.stableJSON(move)); await pipeline.tick(); await pipeline.tick();
    }
    assert.equal(last.n, 5); assert.equal(last.to, 10); assert.equal(store.count('finds'), 0);
    await pipeline.close(); await store.close(); store = await Store.open(path); create();
    for (tip = 11; tip <= 13; tip++) { await intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip }); await pipeline.tick(); }
    tip = 13;
    for (let i = 0; i < 20 && store.count('finds') < 5; i++) await pipeline.tick();
    assert.equal(store.count('finds'), 5); assert.ok(signed > 5); assert.equal(store.count('dedupe'), 0);
  } finally { await pipeline.close(); await store.close(); }
});

test('moves waiting at the old block ride the first batch that reaches the newest block', async () => {
  const path = await temp(), history = fixtureHistory(30), files = new Files(join(path, 'static')), who = agent();
  const previousRoot = rules.hash('legacy'), activation = { sequence: 1, previousRoot, height: 10, hash: history.hashAt(10), ruleset: 'sc1', settingsRevision: rules.hash('settings') };
  const settings = { batchVersion: 2, ...activation, activation, puzzleBits: 0, receiptSigners, settlementPageRows: 2 };
  const store = await Store.open(path); let last = { n: 0, to: 9 }, tip = 10, pipeline, signed = 0; const roots = new Map(), sent = [];
  const intake = new SegmentedIntake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0, settings });
  const reads = { batchLast: async () => last, committeeEpoch: async () => 0, counted: async () => tip, batchRoot: async n => roots.get(n) ?? null };
  const committee = { attestRoot, signature: async (_, proposal) => {
    const draft = await pipeline.loadDraft();
    const rebuilt = rebuildBatch(network, proposal, { authority: { epoch: 0 }, counted: tip, gateway: intake.gateway, state: draft.startState, patterns: draft.startPatterns,
      inputs: draft.items.map(i => i.input), history, hashAt: history.hashAt, settings: draft.settings, limits: draft.limits, last, activation, previousRoot: draft.previousRoot });
    assert.equal(rebuilt.batch.root, proposal.batch.root); signed++; return { signature: { compact: '00'.repeat(64) } };
  } };
  const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => { last = { n: m.value.n, to: m.value.to }; roots.set(last.n, m.value.root); sent.push(last); }, status: async job => ({ state: roots.get(job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
  pipeline = new Pipeline({ store, files, history, intake, reads, committee, outbox: new Outbox({ store, transport, fallbackMs: 100000, retryMs: 0 }), patterns, settings });
  const claim = block => intake.accept(rules.stableJSON(rules.solveMove({ v: 1, network, a: who.address, t: 'claim', b: 10, h: history.hashAt(10), p: { window: 10, plots: [{ block, patterns: [0] }] } }, who.secret, 0)));
  try {
    await intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip });
    await claim(1); await pipeline.tick(); await pipeline.tick();
    assert.deepEqual(last, { n: 1, to: 10 });
    // A claim arrives at block 10, then block 11 is counted before the next batch is built.
    await claim(2);
    tip = 11; const sealed = await intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip });
    assert.equal(sealed.tip, 10); assert.equal(sealed.counted, 11); assert.equal(sealed.count, 1);
    await pipeline.tick(); await pipeline.tick();
    assert.deepEqual(last, { n: 2, to: 11 }, 'the batch carrying the block-10 claim already reaches block 11');
    assert.equal(signed, 2); assert.equal(store.count('dedupe'), 0);
  } finally { await pipeline.close(); await store.close(); }
});
