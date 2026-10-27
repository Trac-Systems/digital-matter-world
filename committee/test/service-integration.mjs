import assert from 'node:assert/strict';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { buildRoot, root, createGroup, startSidecar, stopChild, ceremony, descriptor, privateJSON, randomHex, rpc, delay } from '../tss.mjs';
import { signProposal } from '../client.mjs';
import { fixture, batchFixture, network } from './fixture.mjs';

const port = Number(process.env.DMW_SERVICE_TEST_PORT ?? 59720);
const directory = resolve(buildRoot, `services-${Date.now()}`), children = [], pids = [], checks = [];
await mkdir(directory, { recursive: true, mode: 0o700 });
const remember = async (pid, config) => { pids.push({ pid, config }); await writeFile(resolve(directory, 'pids.json'), JSON.stringify(pids), { mode: 0o600 }); };
const test = async (name, fn) => { await fn(); checks.push(name); console.log('PASS', name); };
try {
  const group = await createGroup(directory, { prefix: 'service', port });
  for (const p of group) children.push(await startSidecar(p, remember));
  const { publicKey } = await ceremony(group, 'keygen');
  const f = fixture('compound', publicKey), clients = [], files = [];
  for (let i = 0; i < 5; i++) {
    const member = group[i], base = JSON.parse(await readFile(resolve(member.directory, 'credentials.json'), 'utf8'));
    const credentials = resolve(member.directory, 'service-credentials.json'), config = resolve(member.directory, 'service.json'), file = resolve(member.directory, 'reads.json'); files.push(file);
    const secrets = { identity: base.identity, encryption: base.encryption, apiToken: randomHex(), sidecarToken: member.token, passphrase: randomHex(), journalKey: randomHex() };
    await privateJSON(credentials, secrets); await privateJSON(file, { kind: 'compound', publicKey });
    await privateJSON(config, { id: member.id, network, epoch: 1, listen: `127.0.0.1:${port + 5 + i}`, directory: member.directory, secrets: credentials, sidecar: member.url, members: group.map(descriptor), readModule: resolve(root, 'test/mock-reads.mjs'), readOptions: { file } });
    const log = await open(resolve(member.directory, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [resolve(root, 'signer/service.mjs'), config], { stdio: ['ignore', log.fd, log.fd] }); child.on('error', () => {}); await log.close(); children.push(child); await remember(child.pid, config);
    const client = { id: member.id, url: `http://127.0.0.1:${port + 5 + i}`, token: secrets.apiToken, peer: descriptor(member) }; clients.push(client);
    let healthy = false;
    for (let n = 0; n < 100; n++) { if (child.exitCode !== null) throw Error('service_failed'); try { await rpc(client.url, client.token, '/health', {}, 500); healthy = true; break; } catch { await delay(100); } }
    assert.equal(healthy, true);
  }
  await test('each signer rebuilds and signs a real rules-library binary batch', async () => {
    const { proposal } = batchFixture(), signed = await signProposal(clients.slice(0, 3), proposal);
    assert.equal(secp256k1.verify(signed.signature.compact, signed.digest, publicKey, { prehash: false }), true);
  });
  await test('live batch conflicts refuse; three independent signers retire expired reservations before replacement', async () => {
    const { proposal } = batchFixture();
    const replacement = { ...proposal, batch: { ...proposal.batch, deadline: 108 } };
    await assert.rejects(signProposal(clients.slice(0, 3), replacement), /batch_retirement_unproven/);
    for (const file of files) await writeFile(file, JSON.stringify({ kind: 'compound', publicKey, batchCounted: 102 }));
    const signed = await signProposal(clients.slice(0, 3), replacement);
    assert.equal(secp256k1.verify(signed.signature.compact, signed.digest, publicKey, { prehash: false }), true);
    for (const member of group.slice(0, 3)) {
      const records = (await readFile(resolve(member.directory, 'signed.log'), 'utf8')).trim().split('\n').map(JSON.parse);
      const retired = records.find(r => r.type === 'retired-batch');
      assert.equal(retired.proof.counted, 102); assert.equal(retired.slot, 'batch/0/1');
      assert.equal(records.findLast(r => r.type === 'reserve').details.deadline, 108);
      assert.ok(retired.index < records.findLast(r => r.type === 'reserve').index);
    }
    for (const file of files) await writeFile(file, JSON.stringify({ kind: 'compound', publicKey }));
  });
  let signed;
  await test('independent policy services obtain a threshold compound TAP permit', async () => {
    signed = await signProposal(clients.slice(0, 3), f.proposal);
    assert.equal(secp256k1.verify(signed.signature.compact, signed.digest, publicKey, { prehash: false }), true);
    assert.equal(signed.payload.amt, '3'); assert.equal(signed.payload.prv.address, f.proposal.receiver);
  });
  await test('identical permanent permits recover the same threshold signature', async () => {
    const recovered = await signProposal(clients.slice(0, 3), f.proposal); assert.deepEqual(recovered.signature, signed.signature);
    const cached = await rpc(clients[0].url, clients[0].token, '/status', { id: signed.session }); assert.deepEqual(cached.signature, signed.signature);
  });
  await test('independent policy services also produce a block-bound threshold DMT permit', async () => {
    const dmt = fixture('dmt', publicKey);
    for (const file of files) await writeFile(file, JSON.stringify({ kind: 'dmt', publicKey }));
    const result = await signProposal(clients.slice(0, 3), dmt.proposal);
    assert.equal(secp256k1.verify(result.signature.compact, result.digest, publicKey, { prehash: false }), true);
    assert.equal(result.payload.op, 'dmt-mint'); assert.equal(result.payload.blk, '10'); assert.equal(result.payload.dep, dmt.data.context.deployment.id);
  });
  console.log(`${checks.length} signer integration checks passed.`);
} finally {
  // Stop policy services first; their shutdown can still contact the sidecars.
  for (const child of children.slice().reverse()) await stopChild(child);
  await writeFile(resolve(directory, 'results.json'), JSON.stringify({ checks, processesStopped: true }, null, 2), { mode: 0o600 });
  console.log(`Stopped all ${children.length} recorded processes. Evidence: ${directory}`);
}
