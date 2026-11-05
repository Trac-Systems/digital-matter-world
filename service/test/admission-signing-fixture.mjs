import assert from 'node:assert/strict';
import { v2StackFixture } from './v2-stack-fixture.mjs';
import { signBytes } from '../../kit/lib/signing.mjs';
import { heightKey } from '../src/util.mjs';
import * as r from '../../rules/src/index.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

export async function admissionWhileSigning(t, options = {}) {
  return v2StackFixture(t, { ...options, scenario: async s => {
    s.pipeline.pipelineDepth = options.pipelineDepth ?? 2;
    const received = [], signature = s.committee.signature;
    const submit = async (i, tag) => {
      const agent = s.players[i % s.players.length].agent;
      const move = { v: 2, ruleset: 'dmw-v2', settingsRevision: s.document.revision, settingsHash: r.hashObject(s.document),
        network: s.network, a: agent.owner, t: 'discovery-commit-v2', b: String(s.tip), h: s.history.hashAt(s.tip),
        p: { commitment: r.hash(tag) }, w: '0' };
      move.sig = signBytes(agent.wallet, r.moveDigestV2(move));
      const receipt = await agent.service.submit(move, { hashAt: s.history.hashAt });
      received.push({ move, receipt, agent }); return receipt;
    };
    await submit(0, 'initial');
    for (let cycle = 0; cycle < 6; cycle++) {
      const entered = deferred(), release = deferred();
      s.committee.signature = async (key, proposal, ...args) => {
        const signed = await signature(key, proposal, ...args);
        for (const fences of s.receiptFences) await fences.journal.reserve([key], r.bytesToHex(r.batchDigest(s.network, proposal.batch)),
          r.hash('session/' + proposal.batch.n), proposal.batch);
        entered.resolve(proposal.batch);
        await release.promise; return signed;
      };
      let batch;
      const running = s.pipeline.tick();
      try {
        batch = await Promise.race([entered.promise, running.then(() => { throw Error('signing_not_started/' + cycle); })]);
        const last = await s.reads.batchLast();
        const receipts = await Promise.all(Array.from({ length: 4 }, (_, i) => submit(cycle * 4 + i, `during/${cycle}/${i}`)));
        for (const receipt of receipts) assert.equal(receipt.batch, r.nextUint(String(batch.n)));
        assert.deepEqual(await s.reads.batchLast(), last, 'receipts return while predecessor signing is still blocked');
        assert.equal(s.store.get('meta', 'namedReservedBatch'), receipts[0].batch);
      } finally { release.resolve(); await running; }
      for (let attempt = 0; attempt < 20 && String(s.store.get('meta', 'draft')?.proposal.batch.n) === String(batch.n); attempt++) await s.pipeline.tick();
      await s.runtime.refresh();
      assert.ok(s.store.get('meta', 'namedReservedBatch'), 'acceptance preserves the successor reservation');
    }
    s.committee.signature = signature;
    await s.drain();
    for (const { move, receipt, agent } of received) {
      const accepted = s.store.get('namedAccepted', r.moveIdV2(move));
      assert.equal(String(accepted.batch), receipt.batch);
      assert.equal(accepted.receipt, r.hashObject(receipt));
      const publication = s.store.get('batches', heightKey(receipt.batch)).publications[0];
      const inclusion = await agent.service.inclusion(move, { publication, receipt, hashAt: s.history.hashAt });
      assert.equal(inclusion.verified, true); assert.equal(inclusion.reportedOutcome, 'accepted');
      assert.deepEqual(inclusion.receipt, receipt);
      assert.deepEqual(await agent.service.submit(move, { hashAt: s.history.hashAt }), receipt);
    }
    t.diagnostic(JSON.stringify({ signingBatches: 6, admittedDuringSigning: 24, receiptsIncluded: received.length,
      reservedBatchRefusals: 0, unchangedKitVerification: true, overlap: s.pipeline.overlap }));
  } });
}
