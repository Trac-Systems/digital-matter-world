import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BatchReplay } from '../signer/replay-worker.mjs';
import { createSigner } from '../signer/service.mjs';
import { Journal } from '../signer/journal.mjs';
import { buildRoot } from '../tss.mjs';
import { fixture, batchFixture, network } from './fixture.mjs';
import { sha256 } from '../signer/crypto.mjs';

test('signer batch replay retains one rules runtime across batches and a refused proposal', async () => {
  const replay = new BatchReplay(), { context, proposal, built } = batchFixture();
  context.authority = { epoch: 0 };
  try {
    await replay.ready; const thread = replay.worker.threadId;
    assert.equal((await replay.run(network, proposal, context)).digest, Buffer.from(built.signingDigest).toString('hex'));
    await assert.rejects(replay.run(network, { ...proposal, files: [] }, context), /file_mismatch/);
    assert.equal((await replay.run(network, proposal, context)).digest, Buffer.from(built.signingDigest).toString('hex'));
    assert.equal(replay.worker.threadId, thread);
  } finally { await replay.close(); }
});

test('unprepared retirement survives signer restart, fences late prepare and refuses every reserved digest', async () => {
  await mkdir(buildRoot, { recursive: true }); const directory = await mkdtemp(join(buildRoot, 'unprepared-')), f = fixture();
  const server = createServer(async (req, res) => { for await (const _ of req) {} res.end(JSON.stringify({ public: f.publicKey, epoch: 1 })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const members = ['s0', 's1', 's2'].map(id => ({ id })), config = { directory, network, id: 's0', epoch: 1, members, sidecar: 'http://127.0.0.1:' + server.address().port };
  const secrets = { journalKey: 'local-test', sidecarToken: 'local-test' }, id = sha256('unprepared'), reserved = sha256('reserved');
  let signer;
  try {
    signer = await createSigner(config, secrets, f.reads);
    const retired = await signer.handle('/retire-unprepared', { network, id });
    assert.equal(retired.status, 'retired-unprepared');
    await signer.close(); signer = null;
    const journal = await new Journal(join(directory, 'signed.log'), secrets.journalKey, network, config.id).load();
    await journal.reserve(['mint/request/test'], sha256('digest'), reserved); await journal.close();
    signer = await createSigner(config, secrets, f.reads);
    assert.deepEqual(await signer.handle('/retire-unprepared', { network, id }), retired);
    await assert.rejects(signer.handle('/prepare', { ceremony: { id, epoch: 1, peers: members }, proposal: f.proposal }), /ceremony_retired/);
    await assert.rejects(signer.handle('/retire-unprepared', { network, id: reserved }), /ceremony_reserved/);
  } finally { await signer?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
