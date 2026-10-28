import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPeerKey, msbTransportWallet } from '../runtime.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../contract/package.json', import.meta.url));
const { default: Wallet } = await import(require.resolve('trac-wallet'));
const { ed25519 } = await import(require.resolve('@noble/curves/ed25519'));

test('MSB transport identity survives restart and is separate from every retained role authority', async () => {
  const seed = Buffer.alloc(32, 37), publicKey = Buffer.from(ed25519.getPublicKey(seed));
  const retained = await Wallet.fromKeyPair({ publicKey, secretKey: Buffer.concat([seed, publicKey]) });
  const original = Buffer.from(retained.secretKey), one = await msbTransportWallet(retained, '/role/host');
  const two = await msbTransportWallet(retained, '/role/host'), writer = await msbTransportWallet(retained, '/role/writer');
  assert(one.publicKey.equals(two.publicKey)); assert(!one.publicKey.equals(writer.publicKey));
  assert(!one.publicKey.equals(retained.publicKey)); assert(retained.secretKey.equals(original));
  const message = Buffer.from('reconnect'); assert(Wallet.verify(one.sign(message), message, one.publicKey));
});

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
