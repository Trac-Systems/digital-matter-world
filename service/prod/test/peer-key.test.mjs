import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPeerKey } from '../runtime.mjs';

test('the peer key is placed where trac-peer loads it, never replaced by a different key', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dmw-peer-key-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'trac-host.json'), target = join(root, 'trac-host/peer/db/keypair.json');
  await writeFile(source, '{"fixture":"host"}', { mode: 0o600 });
  await installPeerKey(source, target);
  assert.equal(await readFile(target, 'utf8'), '{"fixture":"host"}');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await installPeerKey(source, target);
  await writeFile(source, '{"fixture":"other"}', { mode: 0o600 });
  await assert.rejects(installPeerKey(source, target), /trac_peer_key_mismatch/);
  assert.equal(await readFile(target, 'utf8'), '{"fixture":"host"}');
});
