import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Store } from '../../service/src/store.mjs';
import { EvidenceStore, evidencePublisher, signEvidence } from '../../service/prod/evidence.mjs';
import { pendingInventory, requireSupportedInventory } from '../../service/src/pending-inventory.mjs';
import { reconcileLegacySignatures } from '../../service/src/pending-signatures.mjs';
import { legacyGatewayRows } from '../../service/src/pending-work.mjs';
import { temp, secret, gateway, agent, network } from '../../service/test/helpers.mjs';
import { rules as r } from '../../service/src/rules.mjs';

test('operator migration pages include unprojected rows, bind the complete snapshot, and reject omissions and private fields', async t => {
  const directory = await temp('pm3-evidence-'), store = await Store.open(join(directory, 'gateway')); t.after(() => store.close());
  await store.put('meta', 'ruleState', { counted: 75 });
  for (let i = 0; i < 10; i++) await store.put('publicDiscoveryOwners', String(i), r.hash(String(i)));
  const who = agent(9333), stamp = { tip: 75, tipHash: r.hash('tip'), counted: 75, last: { n: 75, to: 75 } };
  const settings = { pageRows: 3 }, config = { network, epoch: 0, data: store.directory, committee: [{ id: 'operator', peer: { identity: who.address } }], prod: { contexts: directory, evidenceSettings: settings } };
  const publisher = evidencePublisher({ config, store, reads: { trac: async () => stamp }, secret }); t.after(() => publisher.close());
  let omit = false;
  const reader = await EvidenceStore.open({ config: { directory: join(directory, 'operator'), network, epoch: 0, member: 'operator', settings }, identity: who.secret,
    gateway, stamp: async () => stamp, clock: async () => stamp, source: { request: async (_, { body }) => {
      const answer = await publisher(body);
      if (omit && body.query.op === 'migration-page') { answer.payload.result.rows.shift(); answer.signature = signEvidence(answer.payload, secret); }
      return answer;
    } } }); t.after(() => reader.close());
  const original = legacyGatewayRows(store), exported = await reader.migrationRows();
  assert.deepEqual([...exported.rows], original);
  omit = true; await assert.rejects(reader.migrationRows(), /evidence_migration_(page|root)/); omit = false;
  await store.put('meta', 'bad', { privateKey: 'disposable-test-only' });
  await assert.rejects(reader.migrationRows(), /export_private_field/);
});

test('capture inventory reports zero absent kinds and names each unsupported obligation in its refusal', () => {
  const empty = pendingInventory([]); assert.deepEqual(empty.unsupported, { custody: 0, ethereumLinks: 0, unacceptedMintAdmissions: 0, craftReceipts: 0 });
  assert.doesNotThrow(() => requireSupportedInventory(empty));
  const inventory = pendingInventory([['financialCustody', 'one', {}], ['linkRequests', 'one', { terms: { chainId: '1' } }],
    ['mints', 'one', { state: 'pending' }], ['intake/0001', 'one', { move: { t: 'craft' } }]]);
  assert.throws(() => requireSupportedInventory(inventory), /pending_activation_refused: custody=1, ethereumLinks=1, unacceptedMintAdmissions=1, craftReceipts=1/);
  assert.equal(pendingInventory([['mintInputs', 'orphan', {}], ['activeMints', 'orphan', true]]).unsupported.unacceptedMintAdmissions, 1);
});

test('superseded drafts require a terminal notary fence, including an accepted replacement at the same sequence', () => {
  const batch = { v: 1, epoch: 0, n: 2, from: 10, to: 10, deadline: 16, root: r.hash('old'), ops: [] };
  const rows = [['meta', 'ruleState', { counted: 9 }], ['supersededDrafts', 'old', { state: 'RETIRED', batch }]];
  const records = new Map([['bt/last', { n: 1, to: 9 }], ['b/cnt', 16]]);
  assert.throws(() => reconcileLegacySignatures({ rows, records, network }), /pending_superseded_draft_live/);
  records.set('b/cnt', 17);
  assert.equal(reconcileLegacySignatures({ rows, records, network }).commitment.dispositions[0].state, 'retired');
  records.set('bt/last', { n: 2, to: 10 }); records.set('bt/2', r.hash('replacement'));
  assert.equal(reconcileLegacySignatures({ rows, records, network }).commitment.dispositions[0].state, 'superseded_by_accepted');
  records.set('bt/2', batch.root);
  assert.throws(() => reconcileLegacySignatures({ rows, records, network }), /pending_accepted_draft_replay_required/);
});

test('retired and recovery files are bound into the pending root and a changed file prevents installation', async t => {
  const { pendingArtifactInventory, verifyPendingArtifacts } = await import('../../service/src/pending-artifacts.mjs');
  const { preparePendingWork } = await import('../../service/src/pending-work.mjs');
  const { installGatewayActivation } = await import('../../service/src/v2-runtime.mjs');
  const root = await temp('pm3-artifacts-'), store = await Store.open(join(root, 'gateway')); t.after(() => store.close());
  const id = '0000000000001508', path = '/records/deferred/' + id + '.json';
  await mkdir(join(store.directory, 'static/records/deferred'), { recursive: true });
  const filename = join(store.directory, 'static' + path), value = { reason: 'stalled_observation_capacity', entries: [] };
  await writeFile(filename, JSON.stringify(value));
  await store.put('observationRecovery', id, { path, reason: value.reason });
  await store.put('meta', 'ruleState', { counted: 75, lastTip: 75, highestTip: 75, rounds: [] });
  const rows = legacyGatewayRows(store), artifacts = await pendingArtifactInventory(store.directory, rows);
  const document = r.settingsRevision({ network, effectiveBatch: '76', effectiveBitcoinWindow: '75', values: { ...r.SETTINGS_PROFILE } });
  const anchor = { height: '75', hash: r.hash('anchor') };
  assert.throws(() => preparePendingWork({ store, network, document, anchor, lastTo: 75 }), /pending_artifact_coverage/);
  const pending = preparePendingWork({ store, network, document, anchor, lastTo: 75, artifactInventory: artifacts });
  assert.equal(pending.commitment.artifactsRoot, r.hashObject(artifacts));
  assert.throws(() => verifyPendingArtifacts(rows, [{ ...artifacts[0], path: 'gateway/other' }]), /pending_artifact_binding/);
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '76', previousBatchRoot: r.hash('batch'), bitcoinAnchor: anchor,
    settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(pending.named), accountsRoot: r.hash('accounts'), receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  await assert.rejects(installGatewayActivation({ store, document, imported: {}, manifest, manifestHash: r.hashObject(manifest), named: pending.named }), /pending_artifact_reconciliation_required/);
  await writeFile(filename, JSON.stringify({ ...value, entries: [{ changed: true }] }));
  await assert.rejects(installGatewayActivation({ store, document, imported: { pendingWork: pending }, manifest, manifestHash: r.hashObject(manifest), named: pending.named }), /pending_artifact_changed/);
  assert.equal(store.get('meta', 'v2Activation'), null);
});
