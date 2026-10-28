import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Committee } from '../src/committee.mjs';
import { Store } from '../src/store.mjs';
import { fixture, network } from '../../committee/test/fixture.mjs';
import { Journal } from '../../committee/signer/journal.mjs';
import { createSigner } from '../../committee/signer/service.mjs';
import { verifyMintCertificate } from '../../committee/signer/certificate.mjs';
import { witnesses } from '../../rules/test/witness-fixture.mjs';
const { secp256k1 } = createRequire(new URL('../../committee/package.json', import.meta.url))('@noble/curves/secp256k1');
const members = witnesses.map(({ id, identity }) => ({ id, identity }));

for (const outcome of ['aborted', 'partial-result', 'late-result', 'unavailable']) test(`v2 mint recovery preserves reservations through ${outcome} and gateway restart`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r4-recovery-')), f = fixture('compound');
  f.data.context.payouts = {};
  const mintFeeTerms = f.reads.mintFeeTerms;
  f.reads.mintFeeTerms = async id => ({ ...await mintFeeTerms(id), payoutSnapshot: { payouts: {}, issuedAt: Date.now() } });
  const approval = await f.policy.approve(f.proposal);
  const id = 'ac'.repeat(32), key = 'mint/' + f.id, servers = [], instances = [], signers = [];
  let store = await Store.open(join(root, 'gateway')), prepares = 0, recovers = 0;
  t.after(async () => { for (const instance of instances) await instance.close(); for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await store.close(); });
  const raw = secp256k1.sign(approval.digest, new Uint8Array(32).fill(2), { prehash: false, lowS: true });
  const signature = { compact: raw.toCompactHex(), r: String(raw.r), s: String(raw.s), v: raw.recovery };
  async function serve(handler) {
    const server = createServer(async (req, res) => {
      let input = ''; for await (const chunk of req) input += chunk;
      try { res.end(JSON.stringify(await handler(req.url, JSON.parse(input || '{}')))); }
      catch (error) { res.writeHead(409).end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    return 'http://127.0.0.1:' + server.address().port;
  }
  for (let i = 0; i < 5; i++) {
    let current = { id, status: outcome === 'partial-result' && i === 0 ? 'complete' : 'aborted' };
    const sidecar = await serve(async (path, body) => {
      if (path === '/prepare') { prepares++; current = { ...body, status: 'prepared' }; return {}; }
      if (path === '/go') { current.status = 'complete'; return {}; }
      if (path === '/abort') { current.status = 'aborted'; return {}; }
      if (path === '/result') { assert.equal(current.status, 'complete'); return { start: { network, digest: approval.digest }, signature }; }
      return { public: f.publicKey, epoch: 1, retired: false, session: { ...current, ...(current.status === 'complete' ? { signature } : {}) } };
    });
    const member = witnesses[i], directory = join(root, member.id), secrets = { journalKey: 'disposable-journal', sidecarToken: 'disposable-sidecar', identity: Buffer.from(member.secret).toString('hex') };
    const config = { directory, network, id: member.id, epoch: 1, members, sidecar, assetRecoveryVersion: 2 };
    // Start and stop once to create the directory without an active sidecar.
    let instance = await createSigner(config, secrets, f.reads); await instance.close();
    const journal = await new Journal(join(directory, 'signed.log'), secrets.journalKey, network, member.id).load();
    if (i < 3) await journal.reserve(approval.slots, approval.digest, id, approval.details);
    await journal.close();
    instance = await createSigner(config, secrets, f.reads); instances.push(instance);
    const url = await serve(async (path, body) => {
      if (outcome === 'unavailable' && i === 2 && path === '/status') throw Error('reader_unavailable');
      if (outcome === 'late-result' && i === 0 && path === '/prepare') await instance.handle('/recover-result', { network, id: f.id, signature });
      if (path === '/recover-result') recovers++;
      return instance.handle(path, body);
    });
    signers.push({ id: member.id, url, token: 'disposable-gateway', peer: members[i] });
  }
  const original = { id, proposal: f.proposal, digest: approval.digest, stage: 'blocked', reason: 'ceremony_incomplete', peers: signers.slice(0, 3).map(s => s.id), started: 0 };
  await store.put('ceremonies', key, original);
  let committee = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
  if (outcome === 'unavailable') {
    await assert.rejects(committee.signature(key, f.proposal), /ceremony_requires_recovery/);
    assert.deepEqual(store.get('ceremonies', key), original); assert.equal(prepares, 0); return;
  }
  let result;
  await assert.doesNotReject(async () => { result = await committee.signature(key, f.proposal); }, 'initial recovery');
  if (outcome === 'aborted' || outcome === 'late-result') {
    assert.equal(result, null); assert.equal(prepares, 0);
    const renewed = store.get('ceremonies', key); assert.notEqual(renewed.id, id); assert.equal(renewed.digest, original.digest);
    assert.deepEqual(store.get('mintCeremonyAttempts', key + '/' + id), original);
    await store.close(); store = await Store.open(join(root, 'gateway'));
    committee = new Committee({ store, network, signers, assetRecoveryVersion: 2 });
    await assert.doesNotReject(async () => {
      try { result = await committee.signature(key, f.proposal); }
      catch (error) { throw Error(error.message + ': ' + JSON.stringify(store.get('ceremonies', key).failures)); }
    }, 'renewed preparation');
    if (outcome === 'aborted') {
      assert.equal(result, null);
      await assert.doesNotReject(async () => { result = await committee.signature(key, f.proposal); }, 'renewed completion'); assert.equal(prepares, 3);
    } else { assert.ok(result); assert.equal(prepares, 2); }
  } else { assert.equal(prepares, 0); assert.equal(recovers, 2); }
  verifyMintCertificate(result.certificate, { network, members, publicKey: f.publicKey, id: f.id });
  assert.equal(result.payload.prv.hash, approval.digest);
  await assert.rejects(committee.signature(key, { ...f.proposal, receiver: 'changed' }), /ceremony_proposal_changed/);
});
