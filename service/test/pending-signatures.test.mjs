import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLegacySignatures } from '../src/pending-signatures.mjs';
import { rules as r } from '../src/rules.mjs';
import { network } from './helpers.mjs';

function fixture() {
  const batch = { v: 1, epoch: 0, n: 2, from: 10, to: 10, deadline: 16, root: r.hash('draft-root'), ops: [] };
  const id = 'batch/0/2', draft = { version: 3, external: r.hash('external-draft'), proposal: { batch } };
  const rows = [['meta', 'draft', draft], ['meta', 'ruleState', { counted: 9 }], ['outbox', id, { id, op: 'bt', value: { ...batch, sig: 'original' } }]];
  const records = new Map([['bt/last', { n: 1, to: 9 }], ['b/cnt', 17]]);
  const reservations = [{ slots: [id], digest: r.bytesToHex(r.batchDigest(network, batch)), details: { n: 2, epoch: 0, deadline: 16 } }];
  return { network, rows, records, reservations, batch };
}
test('expired signed draft and outbox are archived with a terminal notary proof; original inputs stay unchanged', () => {
  const f = fixture(), before = r.hashObject(f.rows), result = reconcileLegacySignatures(f);
  assert.equal(result.commitment.dispositions[0].state, 'retired');
  assert.deepEqual(result.commitment.dispositions[0].proof, { counted: 17, epoch: 0, last: { n: 1, to: 9 } });
  assert.equal(result.writes.filter(w => !Object.hasOwn(w, 'value')).length, 2);
  assert.equal(r.hashObject(f.rows), before);
  f.records.set('b/cnt', 16); assert.throws(() => reconcileLegacySignatures(f), /pending_signed_draft_live/);
  f.records.set('s/epoch', 1); assert.equal(reconcileLegacySignatures(f).commitment.dispositions[0].state, 'retired');
});
test('acceptance takes precedence; a missing gateway checkpoint requires accepted replay, never retirement', () => {
  const f = fixture(); f.records.set('bt/2', f.batch.root); f.records.set('bt/last', { n: 2, to: 10 });
  assert.throws(() => reconcileLegacySignatures(f), /pending_accepted_draft_replay_required/);
  f.rows[1][2].counted = 10; f.rows.push(['batches', '2', { batch: f.batch }]);
  assert.equal(reconcileLegacySignatures(f).commitment.dispositions[0].state, 'accepted');
  f.records.set('bt/2', r.hash('other')); assert.throws(() => reconcileLegacySignatures(f), /pending_signed_draft_live/);
});
test('signer reservation, outbox packet and unknown transport cannot be replaced by gateway claims', () => {
  const f = fixture(); f.reservations[0].digest = r.hash('other');
  assert.throws(() => reconcileLegacySignatures(f), /pending_signer_draft_conflict/);
  f.reservations = []; f.rows[2][2].value.root = r.hash('other');
  assert.throws(() => reconcileLegacySignatures(f), /pending_transport_binding/);
  f.rows[2][2].op = 'unknown'; assert.throws(() => reconcileLegacySignatures(f), /pending_transport_evidence_required/);
});

test('a signer reservation omitted by the gateway must have independent acceptance or retirement evidence', () => {
  const f = fixture(); f.rows = f.rows.filter(([space, id]) => space !== 'outbox' && id !== 'draft');
  f.reservations[0].details.root = f.batch.root;
  assert.doesNotThrow(() => reconcileLegacySignatures(f));
  f.records.set('b/cnt', 16); assert.throws(() => reconcileLegacySignatures(f), /pending_signer_unrepresented_batch/);
  f.records.set('bt/2', f.batch.root); assert.doesNotThrow(() => reconcileLegacySignatures(f));
  f.reservations.push({ slots: ['mint/request/' + r.hash('request')], digest: r.hash('permit') });
  assert.throws(() => reconcileLegacySignatures(f), /pending_signer_mint_binding/);
  f.records.set('m/' + r.hash('request'), { s: 1, permitHash: r.hash('permit') });
  assert.doesNotThrow(() => reconcileLegacySignatures(f));
});
