import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { buildCreditAccounts } from '../src/account-batch.mjs';
import { replayFixture, history, hashAt, patterns } from '../../rules/test/claims-never-close-fixture.mjs';

test('audit-limited payout planning supplies its selected allowance to account replay', async () => {
  const document = r.settingsRevision({ network: 'permanent-claims', effectiveBatch: '1', effectiveBitcoinWindow: '0',
    values: { ...r.SETTINGS_PROFILE, puzzleBits: 0, auditChunkBytes: 8192, auditTotalBytes: 16384, settlementPagesPerObservation: 64 } });
  const { input } = replayFixture(document), nodes = new Map(input.claimEvidence.nodes);
  const storage = new r.ClaimStorage({ get: id => nodes.get(id), cacheSize: 64 }), state = storage.load(input.state);
  const event = r.claimRound('1198', hashAt('1198'), '1198', { root: state.catalogRoot, nextNumber: '8', revision: '0' });
  state.rounds = [event];
  for (let owner = 0; owner < 6; owner++) r.enterClaims({ state, event, agent: r.hash('payout-owner/' + owner),
    plots: Array.from({ length: 100 }, (_, i) => ({ block: String(owner * 100 + i + 10), patterns: ['7'] })),
    patterns, history, settings: input.settings, height: '1198' });
  r.freezeClaimWindow({ state, event, decidingHash: hashAt('1200'), counted: '1200', settings: input.settings });
  while (!r.recordGet(state.settlementPages, event.window + '/' + event.cursor).winners) event.cursor = String(BigInt(event.cursor) + 1n);
  const saved = storage.save(state); for (const row of saved.writes) nodes.set(row.id, row.value);
  const planning = { ...input, state: saved.state, claimEvidence: { nodes: [] } }, readers = { claimNodeGet: id => nodes.get(id) };
  const output = r.processBlockV2(planning, readers);
  assert.ok(output.deliveryRows > 0 && output.deliveryRows < document.values.settlementPageRows * document.values.settlementPagesPerObservation);
  const accounts = await buildCreditAccounts({ store: { get: () => null }, credits: output.file.ops, document, height: input.height });
  const attached = { ...planning, financialPlanning: false, accountOperations: accounts.operations };
  assert.throws(() => r.processBlockV2(attached, readers), /account_credit_derivation/,
    'replaying the original allowance would derive too many credits before the audit cap');
  const expected = r.finalizeBlockV2Accounts(output, attached);
  const replayed = r.processBlockV2({ ...attached, deliveryRows: output.deliveryRows }, readers);
  assert.deepEqual(replayed.auditBytes, expected.auditBytes);
  assert.deepEqual(replayed.viewerBytes, expected.viewerBytes);
  assert.equal(replayed.state.claimRoot, expected.state.claimRoot);
  assert.ok(replayed.auditBytes.length <= document.values.auditTotalBytes);
});
