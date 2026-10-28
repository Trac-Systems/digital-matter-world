import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { relayFixture } from './header-relay-fixture.mjs';
import { History } from '../../src/history.mjs';
import { Intake } from '../../src/intake.mjs';
import { Pipeline } from '../../src/pipeline.mjs';
import { Files } from '../../src/files.mjs';
import { secret, gateway } from '../../test/helpers.mjs';
import { createFeePolicy } from '../../src/fees.mjs';
import { edPublic } from '../../src/util.mjs';
import { deployment, signedBatch } from '../../../contract/tests/helpers/harness.mjs';
import { EvidenceStore, evidencePublisher } from '../evidence.mjs';

let activeReads;
mock.module('../reads.mjs', { exports: { productionReads: async () => activeReads } });
const { createAdapters } = await import('../adapter.mjs');

test('production adapter advances the checkpoint, clears its queued observation and restores exact signer evidence', async t => {
  const f = await relayFixture(t, 45), history = new History(f.store), identity = Buffer.alloc(32, 12);
  activeReads = { ...f.reads, manifest: { bitcoin: f.reads.client }, close: async () => {},
    registry: async () => ({ assets: {}, feePolicy: createFeePolicy('100') }), ethRPC: async () => assert.fail('no Ethereum calls') };
  const config = { network: deployment.network, epoch: 0, data: f.store.directory, gatewayKey: join(f.root, 'gateway.hex'),
    committee: [{ id: 'reader', peer: { identity: edPublic(identity) } }],
    prod: { contexts: join(f.root, 'contexts'), startTip: 1, maxHeadersPerView: 10000,
      ethereum: { chainId: '1', address: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20) } } };
  await writeFile(config.gatewayKey, secret.toString('hex'), { mode: 0o600 });
  const adapter = await createAdapters({ config, store: f.store, history }); t.after(() => adapter.close());
  const intake = new Intake({ store: f.store, network: config.network, secret, hashAt: history.hashAt });
  const files = new Files(join(config.data, 'static')), proposals = [];
  const committee = { signature: async (_key, proposal) => { proposals.push(proposal); return { signature: { compact: signedBatch(proposal.batch, deployment).sig } }; } };
  const pipeline = new Pipeline({ store: f.store, files, history, intake, committee, outbox: f.outbox, reads: activeReads });
  t.after(() => pipeline.close());
  const observe = async () => {
    for (const observation of await adapter.observations(intake.head)) { await intake.observe(observation); await adapter.observed(observation); }
    await adapter.afterObserve(intake);
  };
  const publisher = evidencePublisher({ config, store: f.store, reads: activeReads, secret });
  const directory = join(f.root, 'signer'); await mkdir(directory, { mode: 0o700 });
  const evidence = await EvidenceStore.open({ config: { directory, network: config.network, epoch: 0, member: 'reader' }, identity, gateway,
    source: { request: (_path, { body }) => publisher(body) },
    clock: async () => { const tip = await activeReads.client.tip(); return { tip: tip.height, tipHash: tip.hash }; }, stamp: () => activeReads.trac('stamp') });
  t.after(() => evidence.close());

  await observe(); assert.equal(f.store.count('observations'), 1);
  await pipeline.tick(); assert.equal(f.store.count('observations'), 1); assert.equal(proposals.length, 0);
  await assert.rejects(evidence.refresh(), /evidence_reorg/);
  await adapter.relayHeaders(f.outbox);
  const now = Date.now(); for (let i = 0; i < 4; i++) await f.outbox.tick(now + i * 1000);
  await evidence.refresh(); assert.equal(evidence.payload.stamp.tip, 45);
  await observe(); await pipeline.tick(); await pipeline.tick();
  assert.equal(f.store.count('observations'), 0, 'the checkpoint seal is consumed by the first advancing batch');
  assert.equal(proposals.length, 1); assert.equal((await activeReads.batchLast()).to, 45);
  await observe(); assert.equal(f.store.count('observations'), 0, 'idle polls do not recreate the launch backlog');

  await f.fork(45, 1);
  await assert.rejects(evidence.refresh(), /evidence_reorg/, 'a new Bitcoin block invalidates the old Trac stamp');
  await adapter.relayHeaders(f.outbox); await f.outbox.tick(now + 5000); await f.outbox.tick(now + 6000);
  await evidence.refresh(); assert.equal(evidence.payload.stamp.tip, 46);
  await observe(); await pipeline.tick(); await pipeline.tick();
  assert.equal(f.store.count('observations'), 0); assert.equal((await activeReads.batchLast()).to, 46);
});
