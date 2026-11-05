import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { edPublic } from '../../src/util.mjs';
import { rules } from '../../src/rules.mjs';
import { EvidenceStore, evidencePublisher } from '../evidence.mjs';

test('a large database log pauses new evidence snapshots until open ones end, then is folded back', async t => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-log-')), store = await Store.open(join(root, 'gateway'));
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const network = 'evidence-log', secret = Buffer.alloc(32, 41), ids = { one: Buffer.alloc(32, 42), two: Buffer.alloc(32, 43) };
  const settings = { walCheckpointBytes: 4096 }, stamp = { tip: '1', tipHash: rules.hash('tip') }, now = () => 10000;
  const config = { network, epoch: 1, data: store.directory, prod: { evidenceSettings: settings },
    committee: Object.entries(ids).map(([id, identity]) => ({ id, peer: { identity: edPublic(identity) } })) };
  const publisher = evidencePublisher({ config, store, reads: { trac: async () => stamp }, secret, now });
  t.after(() => publisher.close());
  const reader = async member => {
    const r = await EvidenceStore.open({ config: { directory: join(root, member), network, epoch: 1, member, settings },
      identity: ids[member], gateway: edPublic(secret), clock: async () => stamp, stamp: async () => stamp, now,
      source: { request: (_path, { body }) => publisher(body) } });
    t.after(() => r.close()); return r;
  };
  const log = async () => (await stat(join(store.directory, 'index.sqlite-wal')).catch(() => ({ size: 0 }))).size;
  const write = async n => { for (let i = 0; i < n; i++) await store.put('types', 'row' + i, { filler: 'x'.repeat(2000), i }); };
  const one = await reader('one'), two = await reader('two');
  await write(20); assert.ok(await log() > 4096);
  await one.refresh();
  assert.equal(await log(), 0, 'with no snapshot open the log is folded back before the new one opens');
  assert.equal((await one.get('types', 'row3')).i, 3);
  await write(20); assert.ok(await log() > 4096);
  // Another signer still holds a snapshot: nothing new opens until it ends.
  await assert.rejects(two.refresh(), /evidence_checkpoint_pending/);
  await assert.rejects(two.refresh(), /evidence_checkpoint_pending/);
  // Its next refresh ends that snapshot itself; the log is folded back and both read again.
  await one.refresh();
  assert.equal(await log(), 0);
  await two.refresh();
  assert.equal((await two.get('types', 'row19')).i, 19);
  assert.equal((await one.get('types', 'row19')).i, 19);
});
