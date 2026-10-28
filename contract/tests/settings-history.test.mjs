import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deployment, bob, signedBatch } from './helpers/harness.mjs';
import * as r from '../../rules/src/index.js';
import { prepareTerminalImport } from '../../service/src/terminal-import.mjs';
import { accountOperationsRoot } from '../../rules/src/account-batch.js';

test('administrator amendments retain history, both activation clocks and original delay', async () => {
  const old = harness(); await old.mint(['p0']);
  const head = await old.state().head(), imported = prepareTerminalImport({ records: old.db, height: head.counted, pageBytes: 2000 });
  const document = r.settingsRevision({ network: deployment.network, effectiveBatch: '2', effectiveBitcoinWindow: String(head.counted),
    values: { ...r.SETTINGS_PROFILE, adminDelayTips: 2 } });
  const manifest = { version: 1, network: deployment.network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2',
    previousBatchRoot: old.db.get('bt/1'), bitcoinAnchor: { height: String(head.counted), hash: head.countedHash }, settingsHash: r.hashObject(document),
    catalogRoot: r.namedStateRoot(r.emptyNamedDiscovery()), accountsRoot: imported.financialRoot, receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const h = harness({ ...deployment, v2: { manifest, manifestHash: r.hashObject(manifest), document, importRoot: imported.importRoot, importRows: imported.importRows } });
  for (const page of imported.pages) assert.equal(await h.run('ad_import', page), null);
  const successor = r.settingsRevision({ network: deployment.network, previous: document, effectiveBatch: '3', effectiveBitcoinWindow: String(head.counted + 3),
    values: { ...document.values, claimsPerWindow: 120, adminDelayTips: 1 } });
  assert.equal(await h.run('ad_settings', { document: { ...successor, values: { ...successor.values, batchBytes: 50000 } } }), 'settings_capacity_drain_required');
  assert.equal(await h.run('ad_settings', { document: successor }, bob.address), 'admin');
  assert.equal(await h.run('ad_settings', { document: successor }), null);
  assert.equal(await h.run('ad_apply', { id: 'settings' }), 'admin_delay');
  await h.advance(1); assert.equal(await h.run('ad_apply', { id: 'settings' }), 'admin_delay');
  await h.advance(1); assert.equal(await h.run('ad_apply', { id: 'settings' }, bob.address), null);
  const apply = async (policy, execution) => {
    execution = r.decimalV2(execution ?? (await h.state().head()).counted);
    const last = await h.state().batchLast(), ops = [{ op: 'kv', key: 'fixture/settings', value: r.hashObject(policy) }];
    return h.run('bt', signedBatch({ v: 2, epoch: await h.state().committeeEpoch(), n: r.nextUint(last.n), from: last.to, to: execution, deadline: r.addUint(execution, '6'),
      previous: h.db.get('bt/' + last.n), ruleset: 'dmw-v2', settingsRevision: policy.revision, settingsHash: r.hashObject(policy),
      previousClaims: h.db.get('v2/claims'), claims: r.hash('settings-claims/' + (last.n + 1)),
      execution: { height: execution, hash: await h.state().beacon().hashAt(execution) }, observation: last.n,
      receipts: r.hash('receipts'), finds: r.hash('finds'), catalog: manifest.catalogRoot, accounts: accountOperationsRoot(ops), ops }, h.options));
  };
  // Activation's exact anchor remains pinned even after the head advances.
  assert.equal(await apply(document, head.counted), null);
  assert.equal(await apply(successor), 'batch_settings');
  assert.equal(await apply(document), null, 'batch boundary alone does not block progress');
  await h.advance(1);
  assert.equal(await apply(document), 'batch_settings');
  assert.equal(await apply(successor), null);
  assert.equal((await h.state().settings()).claimsPerWindow, 120);
  assert.equal(h.db.get('v2/settings-next'), undefined);
  assert.deepEqual(h.db.get('v2/settings/' + r.hashObject(document)), document);
  assert.deepEqual(h.db.get('v2/settings/' + r.hashObject(successor)), successor);
  assert.equal(await h.run('ad_settings', { document: successor }), 'settings_history');
  assert.equal(await h.run('ad_set', { key: 'batch_bytes', value: 100000 }), 'admin_proposal');
});
