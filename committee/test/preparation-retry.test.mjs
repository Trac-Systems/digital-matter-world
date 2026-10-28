import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSigner } from '../signer/service.mjs';
import { signerError } from '../signer/errors.mjs';
import { Journal } from '../signer/journal.mjs';
import { fixture, batchFixture, network } from './fixture.mjs';
import { sha256 } from '../signer/crypto.mjs';

async function setup(t, { sidecarFailure = false } = {}) {
  const f = fixture(), b = batchFixture(); f.data.counted = b.context.counted;
  f.reads.batchContext = async () => ({ ...structuredClone({ ...b.context, history: undefined, hashAt: undefined }), history: b.context.history, hashAt: b.context.hashAt });
  f.reads.tip = async () => ({ tip: 100 });
  let prepares = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    if (req.url === '/prepare') { prepares++; if (sidecarFailure) { res.writeHead(409).end('{"error":"sidecar_failed"}'); return; } }
    res.end(JSON.stringify({ public: f.publicKey, epoch: 1 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'st1-signer-')), peers = ['s0','s1','s2'].map(id => ({ id }));
  const signer = await createSigner({ directory, network, id: 's0', epoch: 1, members: peers, sidecar: 'http://127.0.0.1:' + server.address().port }, { journalKey: 'local-test', sidecarToken: 'local-test' }, f.reads);
  t.after(async () => { await signer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const body = { proposal: b.proposal, ceremony: { id: sha256('st1-session'), epoch: 1, peers } };
  return { ...f, b, signer, body, directory, prepares: () => prepares };
}

test('lagging signer refuses without reservation, then replays original bytes at a newer counted snapshot', async t => {
  const f = await setup(t); f.data.counted = 94;
  await assert.rejects(f.signer.handle('/prepare', f.body), error => {
    assert.equal(error.message, 'signer_not_caught_up');
    assert.deepEqual(signerError(error), { error: 'signer_not_caught_up', unreserved: { id: f.body.ceremony.id, proposalHash: sha256(JSON.stringify(f.body.proposal)) } }); return true;
  });
  assert.equal(f.prepares(), 0);
  assert.deepEqual(await f.signer.handle('/preparation-state', { id: f.body.ceremony.id }), { id: f.body.ceremony.id, reserved: false, retired: false });
  f.data.counted = 96;
  const result = await f.signer.handle('/prepare', f.body);
  assert.equal(result.id, f.body.ceremony.id); assert.equal(result.digest, Buffer.from(f.b.built.signingDigest).toString('hex'));
  assert.equal(f.prepares(), 1);
  await assert.rejects(f.signer.handle('/prepare', f.body), error => { assert.equal(error.unreserved, undefined); return true; });
  const rows = (await readFile(join(f.directory, 'signed.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(r => r.type === 'reserve').length, 1);
});

test('refresh failure carries a bound no-reservation proof; sidecar failure after reserve does not', async t => {
  const f = await setup(t, { sidecarFailure: true });
  f.reads.refreshEvidence = async () => { throw Error('evidence_reorg'); };
  await assert.rejects(f.signer.handle('/prepare', f.body), e => e.unreserved?.id === f.body.ceremony.id);
  delete f.reads.refreshEvidence;
  await assert.rejects(f.signer.handle('/prepare', f.body), e => e.message === 'sidecar_failed' && !e.unreserved);
  assert.equal((await f.signer.handle('/preparation-state', { id: f.body.ceremony.id })).reserved, true);
  await assert.rejects(f.signer.handle('/prepare', f.body), /ceremony_reused/);
  assert.equal(f.prepares(), 1);
});

test('ambiguous reservation write is never advertised as unreserved', async t => {
  const f = await setup(t), original = Journal.prototype.reserve;
  Journal.prototype.reserve = async () => { throw Error('disk_failure'); };
  try {
    await assert.rejects(f.signer.handle('/prepare', f.body), e => !e.unreserved);
    assert.equal((await f.signer.handle('/preparation-state', { id: f.body.ceremony.id })).reserved, true);
    await assert.rejects(f.signer.handle('/retire-unprepared', { id: f.body.ceremony.id, network }), /ceremony_reserved/);
    await assert.rejects(f.signer.handle('/prepare', f.body), /ceremony_reused/);
  } finally { Journal.prototype.reserve = original; }
});

test('host-safe errors expose protocol codes but suppress arbitrary dependency details', () => {
  for (const message of ['evidence_reorg', 'ceremony_id', 'replay_timeout', 'file_mismatch', 'session_busy']) assert.deepEqual(signerError(Error(message)), { error: message });
  for (const message of ['https://private.invalid/credential', '/private/credential', 'arbitrary_secret_text']) assert.deepEqual(signerError(Error(message)), { error: 'signer_error' });
});
