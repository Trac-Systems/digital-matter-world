import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { replayFixture, history, hashAt, patterns, agent } from './claims-never-close-fixture.mjs';

test('current paging allowance drains an old closed round while its finder policy stays pinned', () => {
  const original = r.settingsRevision({ network: 'permanent-claims', effectiveBatch: '1', effectiveBitcoinWindow: '0',
    values: { ...r.SETTINGS_PROFILE, puzzleBits: 0, settlementPageRows: 2, settlementPagesPerObservation: 1 } });
  const { input } = replayFixture(original), nodes = new Map(input.claimEvidence.nodes);
  const storage = new r.ClaimStorage({ get: id => nodes.get(id), cacheSize: 64 }), state = storage.load(input.state);
  const event = r.claimRound('1198', hashAt('1198'), '1198', { root: state.catalogRoot, nextNumber: '8', revision: '0' });
  event.policy = { settingsHash: r.hashObject(original), claimsPerWindow: 100, claimWindowBlocks: 2, finderWindow: original.values.finderWindow };
  state.rounds = [event];
  r.enterClaims({ state, event, agent, plots: Array.from({ length: 12 }, (_, i) => ({ block: String(i + 10), patterns: ['7'] })),
    patterns, history, settings: input.settings, height: '1198' });
  const closure = r.freezeClaimWindow({ state, event, decidingHash: hashAt('1200'), counted: '1200', settings: input.settings });
  const saved = storage.save(state);
  for (const row of saved.writes) nodes.set(row.id, row.value);
  const before = { ...input, state: saved.state, claimEvidence: { nodes: [...nodes] } };
  const slow = r.processBlockV2(before);
  assert.equal(slow.file.settlements.length, 1);
  assert.ok(slow.state.rounds.some(round => round.window === event.window));

  const successor = r.settingsRevision({ network: original.network, previous: original, effectiveBatch: '2', effectiveBitcoinWindow: '1200',
    values: { ...original.values, settlementPagesPerObservation: 64, finderWindow: 10 } });
  r.settingsSuccessor(original, successor);
  const fast = r.processBlockV2({ ...before, settings: { document: successor, receiptSigners: input.settings.receiptSigners }, settingsDocuments: [original] });
  assert.equal(fast.file.settlements.length, Number(closure.pages));
  assert.ok(fast.file.settlements.every(page => page.root === closure.root));
  assert.ok(!fast.state.rounds.some(round => round.window === event.window));
  assert.equal(fast.file.settlements.flatMap(page => page.winners).length, 12);
  for (const find of Object.values(r.recordChanges(fast.state.finds))) {
    assert.equal(find.settingsHash, r.hashObject(original));
    assert.equal(find.finderUntil, String(BigInt(find.findHeight) + BigInt(original.values.finderWindow)));
  }
  assert.equal(before.state.rounds[0].cursor, '0', 'both replays leave the predecessor unchanged');
});
