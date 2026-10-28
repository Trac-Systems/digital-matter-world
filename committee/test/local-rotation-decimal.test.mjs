import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { attestRotation } from '../rosters.mjs';

// Exercise the rotation coordinator and persisted configuration using an
// explicit ceremony double. Real threshold signing/reopen is tested separately.
const secret = Buffer.alloc(32, 42), publicKey = Buffer.from(secp256k1.getPublicKey(secret)).toString('hex');
const identities = Array.from({ length: 6 }, (_, i) => Buffer.alloc(32, i + 100));
const clients = identities.map((key, i) => ({ id: `member-${i}`, peer: { id: `member-${i}`, identity: Buffer.from(ed25519.getPublicKey(key)).toString('hex') } }));
const group = prefix => Array.from({ length: 5 }, (_, i) => ({ id: `${prefix}-${i}`, token: 'disposable', url: `http://127.0.0.1:${63000 + i}` }));
const old = group('old'), next = group('new'); let epoch, expected;
mock.module('../tss.mjs', { namedExports: {
  loadGroup: async path => ({ group: path === 'old' ? old : next }),
  descriptor: ({ id, url }) => ({ id, url }),
  rpc: async () => ({ epoch, public: publicKey, retired: false }),
  ceremony: async (members, kind, options) => {
    assert.equal(options.epoch, expected);
    if (kind === 'reshare') { assert.deepEqual(members, old); assert.deepEqual(options.newGroup, next); return { publicKey, certificate: [] }; }
    assert.equal(kind, 'sign'); assert.equal(members.length, 3);
    return { compact: secp256k1.sign(options.digest, secret, { prehash: false }).toCompactHex() };
  }
} });
mock.module('../../service/src/committee.mjs', { namedExports: { post: async (member, path, body) => {
  assert.equal(path, '/attest-roster'); return attestRotation(body, member.id, identities[clients.findIndex(c => c.id === member.id)].toString('hex'));
} } });
const { rotateLocalSigner } = await import('../local-rotation.mjs');

for (const start of [1, '9007199254740991', '9223372036854775807', '9'.repeat(80)]) test(`local roster rotation persists exact successor of ${start}`, async () => {
  epoch = start; expected = typeof start === 'string' ? String(BigInt(start) + 1n) : start + 1;
  const directory = await mkdtemp(join(tmpdir(), 'g4b2-rotation-')), filename = join(directory, 'gateway.json'), signerConfigs = {};
  for (const member of [clients[5], ...clients.slice(1, 5)]) {
    const path = join(directory, member.id + '.json'), secrets = path + '.credentials';
    await writeFile(secrets, '{}', { mode: 0o600 });
    await writeFile(path, JSON.stringify({ id: member.id, network: 'fixture', secrets })); signerConfigs[member.id] = path;
  }
  await writeFile(filename, JSON.stringify({ mode: 'regtest', network: 'fixture', epoch: start, committee: clients.slice(0, 5) }));
  const options = { replace: clients[0].id, replacement: { ...clients[5], sharePlan: { oldGroup: 'old', newGroup: 'new', signerConfigs } } };
  assert.equal((await rotateLocalSigner(filename, options)).shareEpoch, expected);
  assert.equal((await rotateLocalSigner(filename, { ...options, dryRun: false })).shareEpoch, expected);
  const saved = JSON.parse(await readFile(filename + '.rotation.json', 'utf8'));
  assert.equal(saved.state, 'configured'); assert.equal(saved.shareEpoch, expected);
  for (const path of Object.values(signerConfigs)) assert.equal(JSON.parse(await readFile(path, 'utf8')).tssEpoch, expected);
});
