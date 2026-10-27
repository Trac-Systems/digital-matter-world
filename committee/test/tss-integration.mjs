import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import { createCipheriv } from 'node:crypto';
import { buildRoot, createGroup, startSidecar, stopChild, ceremony, rpc, randomHex, descriptor, delay } from '../tss.mjs';
import { hex, sha256 } from '../signer/crypto.mjs';

const directory = resolve(buildRoot, `integration-${Date.now()}`), processes = [], records = [], results = [];
await mkdir(directory, { recursive: true, mode: 0o700 });
const remember = async (pid, config) => { records.push({ pid, config }); await writeFile(resolve(directory, 'pids.json'), JSON.stringify(records), { mode: 0o600 }); };
const start = async p => { const child = await startSidecar(p, remember); processes.push(child); return child; };
async function test(name, fn) { const then = Date.now(); await fn(); results.push({ name, milliseconds: Date.now() - then }); console.log(`PASS ${name}`); }
const group = await createGroup(resolve(directory, 'old'), { prefix: 'old', port: 57800 });
let oldChildren = [], publicKey, savedResult;
const verify = (signature, digest, key) => {
  assert.equal(secp256k1.verify(signature.compact, digest, key, { prehash: false, lowS: true }), true);
  assert.ok(BigInt(signature.s) <= secp256k1.CURVE.n / 2n);
  const recovered = secp256k1.Signature.fromCompact(signature.compact).addRecoveryBit(signature.v).recoverPublicKey(digest).toRawBytes(false);
  const expected = secp256k1.ProjectivePoint.fromHex(key).toRawBytes(false);
  assert.equal(hex(keccak_256(recovered.subarray(1)).subarray(12)), hex(keccak_256(expected.subarray(1)).subarray(12)));
};
try {
  for (const p of group) oldChildren.push(await start(p));
  await test('fresh dealerless 3-of-5 DKG commits one key and private encrypted shares', async () => {
    ({ publicKey } = await ceremony(group, 'keygen'));
    for (const p of group) {
      const file = resolve(p.directory, 'share.enc'); assert.equal((await stat(file)).mode & 0o777, 0o600);
      const text = await readFile(file, 'utf8'); assert.ok(!text.includes('"Xi":')); assert.ok(!text.includes('"PaillierSK":'));
      assert.equal((await rpc(p.url, p.token, '/status')).public, publicKey);
    }
  });
  await test('3-party signature verifies with Noble and Ethereum address recovery', async () => {
    const digest = sha256('dmw-test-v1|dmw-regtest|noble-and-ecrecover');
    const id = randomHex(), signature = await ceremony(group.slice(0, 3), 'sign', { digest, id });
    savedResult = { id, digest, signature }; verify(signature, digest, publicKey);
  });
  await test('two sidecars offline still signs', async () => {
    await Promise.all(oldChildren.slice(3).map(stopChild));
    const digest = sha256('dmw-test-v1|dmw-regtest|two-offline');
    verify(await ceremony(group.slice(0, 3), 'sign', { digest }), digest, publicKey);
  });
  await test('three sidecars offline cannot produce a signature', async () => {
    await stopChild(oldChildren[2]);
    await assert.rejects(ceremony(group.slice(0, 3), 'sign', { digest: randomHex(), timeout: 2 }));
    await assert.rejects(ceremony(group.slice(0, 2), 'sign', { digest: randomHex(), timeout: 2 }), /sign_state/);
    for (let i = 2; i < 5; i++) oldChildren[i] = await start(group[i]);
  });
  await test('authenticated malformed wire aborts; replay and forged transport are refused', async () => {
    const members = group.slice(0, 3), id = randomHex();
    const st = { id, kind: 'sign', network: 'dmw-regtest', epoch: 1, digest: randomHex(), peers: members.map(descriptor), newPeers: [], timeout: 4 };
    await Promise.all(members.map(p => rpc(p.url, p.token, '/prepare', st)));
    const source = members[0], target = members[1], secret = JSON.parse(await readFile(resolve(source.directory, 'credentials.json'), 'utf8'));
    const nonce = randomBytes(12), env = { session: id, from: source.id, to: target.id, nonce: nonce.toString('base64'), data: null };
    const shared = x25519.getSharedSecret(Buffer.from(secret.encryption, 'hex'), Buffer.from(target.encryption, 'hex'));
    const key = Buffer.from(sha256(Buffer.concat([shared, Buffer.from(`dmw-tss-channel-v1|dmw-regtest|${id}|${source.id}|${target.id}`)])), 'hex');
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(JSON.stringify(env)));
    const wire = { kind: 'wire', from: source.id, to: [target.id], type: 'malformed', broadcast: false, data: '/w==', key: '', hash: '' };
    env.data = Buffer.concat([cipher.update(JSON.stringify(wire)), cipher.final(), cipher.getAuthTag()]).toString('base64');
    env.sig = Buffer.from(ed25519.sign(Buffer.from(JSON.stringify(env)), Buffer.from(secret.identity, 'hex'))).toString('base64');
    await rpc(target.url, '', '/peer', env);
    const forged = { ...env, sig: randomBytes(64).toString('base64') }; await assert.rejects(rpc(target.url, '', '/peer', forged), /peer_auth/);
    await rpc(target.url, target.token, '/go');
    for (let i = 0; i < 50 && (await rpc(target.url, target.token, '/status')).session.status !== 'aborted'; i++) await delay(100);
    assert.equal((await rpc(target.url, target.token, '/status')).session.status, 'aborted');
    await Promise.all(members.map(p => rpc(p.url, p.token, '/abort')));
    await assert.rejects(rpc(target.url, target.token, '/prepare', st), /session_reused/);
    const digest = randomHex(); verify(await ceremony(members, 'sign', { digest }), digest, publicKey);
  });
  await test('session deadline leaves no committed partial key or running session', async () => {
    const p = group[0], st = { id: randomHex(), kind: 'sign', network: 'dmw-regtest', epoch: 1, digest: randomHex(), peers: group.slice(0, 3).map(descriptor), newPeers: [], timeout: 1 };
    await rpc(p.url, p.token, '/prepare', st); await delay(1200);
    const status = await rpc(p.url, p.token, '/status'); assert.equal(status.session.status, 'aborted'); assert.equal(status.public, publicKey);
  });
  const next = await createGroup(resolve(directory, 'new'), { prefix: 'new', port: 57900 });
  for (const p of next) await start(p);
  await test('reshare to five new identities preserves public key and retires old services', async () => {
    const reshared = await ceremony(group, 'reshare', { epoch: 2, newGroup: next }); assert.equal(reshared.publicKey, publicKey);
    for (const p of group) assert.equal((await rpc(p.url, p.token, '/status')).retired, true);
    await assert.rejects(ceremony(group.slice(0, 3), 'sign', { digest: randomHex(), epoch: 1 }), /sign_state/);
    const digest = randomHex(); verify(await ceremony(next.slice(1, 4), 'sign', { digest, epoch: 2 }), digest, publicKey);
  });
  await test('old share retirement survives process restart', async () => {
    await stopChild(oldChildren[0]); await start(group[0]);
    assert.equal((await rpc(group[0].url, group[0].token, '/status')).retired, true);
    const recovered = await rpc(group[0].url, group[0].token, '/result', { id: savedResult.id });
    assert.equal(recovered.start.digest, savedResult.digest); assert.deepEqual(recovered.signature, savedResult.signature);
  });
  console.log(`${results.length} threshold integration checks passed.`);
} finally {
  await Promise.all(processes.map(stopChild));
  await writeFile(resolve(directory, 'results.json'), JSON.stringify({ checks: results, processesStopped: true }, null, 2), { mode: 0o600 });
  console.log(`Stopped all ${processes.length} recorded sidecar processes. Evidence: ${directory}`);
}
