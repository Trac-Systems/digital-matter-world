import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { buildRoot, createGroup, startSidecar, stopChild, ceremony, rpc, randomHex } from '../tss.mjs';

// Disposable manual integration test; no deployed key, vault or process is used.
const directory = resolve(buildRoot, `decimal-epoch-${Date.now()}`), epoch = '9'.repeat(80), network = 'dmw-decimal-fixture';
const port = Number(process.env.DMW_DECIMAL_TSS_PORT ?? 62320);
const children = [], pids = [];
await mkdir(directory, { recursive: true, mode: 0o700 });
const remember = async (pid, config) => {
  pids.push({ pid, config });
  await writeFile(resolve(directory, 'pids.json'), JSON.stringify(pids), { mode: 0o600 });
};
try {
  const group = await createGroup(directory, { network, epoch, port });
  for (const member of group) children.push(await startSidecar(member, remember));
  const { publicKey } = await ceremony(group, 'keygen', { network, epoch });
  for (let pass = 0; pass < 2; pass++) {
    if (pass) {
      for (const child of children.splice(0)) await stopChild(child);
      for (const member of group) children.push(await startSidecar(member, remember));
    }
    for (const member of group) assert.equal((await rpc(member.url, member.token, '/status')).epoch, epoch);
    const digest = randomHex(), signature = await ceremony(group.slice(pass, pass + 3), 'sign', { network, epoch, digest });
    assert.equal(secp256k1.verify(signature.compact, digest, publicKey, { lowS: true, prehash: false }), true);
    console.log('PASS exact 80-digit epoch threshold signature' + (pass ? ' after vault reopen' : ''));
  }
  const successor = String(BigInt(epoch) + 1n), replacement = await createGroup(resolve(directory, 'replacement'), { prefix: 'replacement', network, epoch: successor, port: port + 10 });
  for (const member of replacement) children.push(await startSidecar(member, remember));
  const reshared = await ceremony(group, 'reshare', { network, epoch: successor, newGroup: replacement });
  assert.equal(reshared.publicKey, publicKey);
  for (const member of group) assert.equal((await rpc(member.url, member.token, '/status')).retired, true);
  for (const member of replacement) assert.equal((await rpc(member.url, member.token, '/status')).epoch, successor);
  const digest = randomHex(), signature = await ceremony(replacement.slice(0, 3), 'sign', { network, epoch: successor, digest });
  assert.equal(secp256k1.verify(signature.compact, digest, publicKey, { lowS: true, prehash: false }), true);
  console.log('PASS exact successor epoch resharing and threshold signature with the retained key');
} finally {
  for (const child of children) await stopChild(child);
  await writeFile(resolve(directory, 'stopped.json'), JSON.stringify({ stopped: true, pids: pids.map(p => p.pid) }), { mode: 0o600 });
  console.log(`Stopped ${pids.length} owned processes. Evidence: ${directory}`);
}
