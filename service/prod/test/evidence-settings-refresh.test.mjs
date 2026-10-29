import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { edPublic } from '../../src/util.mjs';
import { rules } from '../../src/rules.mjs';
import { closureTimeouts } from '../../../rules/src/closure-timeouts.js';
import { EvidenceStore, evidencePublisher } from '../evidence.mjs';

test('evidence publisher and independent reader refresh closure leases and pin each opened snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aud1-evidence-settings-')), store = await Store.open(join(root, 'gateway'));
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const network = 'evidence-settings', secret = Buffer.alloc(32, 31), identity = Buffer.alloc(32, 32);
  const original = rules.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...rules.SETTINGS_PROFILE } });
  const successor = rules.settingsRevision({ network, previous: original, effectiveBatch: '2', effectiveBitcoinWindow: '1',
    values: { ...original.values, closureWorkBudget: original.values.closureWorkBudget * 10 } });
  const resources = rules.resourceRevision({ operator: 'fixture', values: { ...rules.RESOURCE_PROFILE } });
  const originalMs = closureTimeouts(original, resources).evidenceMs, successorMs = closureTimeouts(successor, resources).evidenceMs;
  let document = original, now = 10000;
  const snapshotLifetimeMs = () => closureTimeouts(document, resources).evidenceMs;
  const settings = { maxAgeMs: originalMs }, stamp = { tip: '1', tipHash: rules.hash('tip') };
  const config = { network, epoch: 1, data: store.directory,
    committee: [{ id: 'one', peer: { identity: edPublic(identity) } }], prod: { evidenceSettings: settings } };
  await store.put('types', 'original', { before: true });
  const publisher = evidencePublisher({ config, store, reads: { trac: async () => stamp }, secret, now: () => now, snapshotLifetimeMs });
  t.after(() => publisher.close());
  const reader = await EvidenceStore.open({ config: { directory: join(root, 'reader'), network, epoch: 1, member: 'one', settings },
    identity, gateway: edPublic(secret), clock: async () => stamp, stamp: async () => stamp, now: () => now, snapshotLifetimeMs,
    source: { request: (_path, { body }) => publisher(body) } });
  t.after(() => reader.close());
  await reader.refresh();
  assert.equal(reader.payload.expiresAt - reader.payload.observedAt, originalMs);
  document = successor; await reader.refresh();
  assert.equal(reader.payload.expiresAt - reader.payload.observedAt, successorMs);
  // A later policy change cannot shorten an already opened lease or alter its root.
  document = original;
  await store.put('types', 'later', { after: true });
  now += originalMs + 1;
  assert.deepEqual(await reader.get('types', 'original'), { before: true });
  assert.equal(await reader.get('types', 'later'), null);
  await reader.refresh();
  assert.equal(reader.payload.expiresAt - reader.payload.observedAt, originalMs);
  assert.deepEqual(await reader.get('types', 'later'), { after: true });
  now += originalMs;
  await assert.rejects(reader.get('types', 'original'), /evidence_missing_or_stale/);
});
