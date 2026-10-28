import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deployment, alice, bob } from './helpers/harness.mjs';
import * as r from '../../rules/src/index.js';
import { prepareTerminalImport } from '../../service/src/terminal-import.mjs';
import { AccountAvailability } from '../../service/src/account-availability.mjs';
import { accountKey, readAccountLeaf } from '../account-tree.js';

test('pinned paged terminal import preserves accepted state and activates accounts and settings together', async () => {
  const old = harness(); await old.mint(['p0', 'p1']);
  const head = await old.state().head(), last = await old.state().batchLast(), previousBatchRoot = old.db.get('bt/' + last.n);
  const prepared = prepareTerminalImport({ records: old.db, height: head.counted, pageBytes: 1200 });
  const document = r.settingsRevision({ network: deployment.network, effectiveBatch: String(last.n + 1), effectiveBitcoinWindow: String(head.counted), values: { ...r.SETTINGS_PROFILE } });
  const manifest = { version: 1, network: deployment.network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: document.effectiveBatch,
    previousBatchRoot, bitcoinAnchor: { height: String(head.counted), hash: head.countedHash }, settingsHash: r.hashObject(document),
    catalogRoot: r.namedStateRoot(r.emptyNamedDiscovery()), accountsRoot: prepared.financialRoot, receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const h = harness({ ...deployment, v2: { manifest, manifestHash: r.hashObject(manifest), document, importRoot: prepared.importRoot, importRows: prepared.importRows } });
  assert.equal(await h.run('tf', { to: bob.address, assets: [['p0', '1']] }), 'activation_import_required');
  assert.equal(await h.run('ad_import', prepared.pages[0], bob.address), 'activation_import_authority');
  assert.ok(prepared.pages.length > 1);
  for (const page of prepared.pages) {
    assert.equal(await h.run('ad_import', page), null);
    if (!page.final) assert.equal(await h.run('ad_import', page), null);
  }
  assert.equal(h.db.get('v2/ready'), r.hashObject(manifest));
  for (const [key, value] of old.db) assert.deepEqual(h.db.get(key), value, key);
  assert.equal(h.db.get('s/assets').version, 2); assert.equal(h.db.get('s/assetExits').version, 2);
  const nodeStore = new Map(prepared.availability.map(row => [row.id, row.value]));
  const availability = new AccountAvailability({ get: (_, key) => nodeStore.get(key) });
  const account = h.db.get('ar/' + alice.address), key = accountKey('balance', 'p0');
  assert.equal(readAccountLeaf(account.root, availability.prove(account.root, [key]), key).available, '100');
  assert.equal(await h.run('tf', { to: bob.address, assets: [['p0', '1']] }), 'account_v2_required');
  assert.equal(await h.run('ad_import', prepared.pages.at(-1)), 'activation_already_complete');
});
