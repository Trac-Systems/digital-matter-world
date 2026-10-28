import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Intake } from '../src/intake.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Files } from '../src/files.mjs';
import { Store } from '../src/store.mjs';
import { Outbox } from '../src/transport.mjs';
import { rules } from '../src/rules.mjs';
import { harness, deployment, signedBatch } from '../../contract/tests/helpers/harness.mjs';
import { temp, network, secret, fixtureHistory, makeMove, agent, patterns, attestRoot, receiptSigners } from './helpers.mjs';
test('durable intake -> audit file -> committee proposal -> contract credits, with a draft restart', async () => {
  const path = await temp(), history = fixtureHistory(), options = { ...deployment, network }, contract = harness(options);
  contract.db.set('s/epoch', 7);
  let store = await Store.open(path), pipeline, intake;
  const files = new Files(join(path, 'static')), who = agent(); let held = true;
  const reads = { batchLast: async () => contract.state().batchLast(), committeeEpoch: () => contract.state().committeeEpoch(), balance: async () => '0', nonceUsed: async () => false };
  const committee = { attestRoot, signature: async (_, proposal) => held ? null : { signature: { compact: signedBatch(proposal.batch, options).sig } } };
  const create = () => {
    intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
    const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => assert.equal(await contract.run(m.op, m.value), null), status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
    const outbox = new Outbox({ store, transport, fallbackMs: 100000, retryMs: 0 });
    pipeline = new Pipeline({ store, files, history, intake, committee, outbox, reads, patterns, settings: { puzzleBits: 0, receiptSigners } });
  };
  create();
  try {
    for (let tip = 6; tip <= 15; tip++) {
      await intake.observe({ tip, hash: history.hashAt(tip), counted: tip - 5, confirmed: tip - 5,
        headers: tip === 6 ? Array.from({ length: 6 }, (_, i) => history.raw(i + 1)) : [history.raw(tip)] });
      if (tip === 6) await intake.accept(rules.stableJSON(makeMove(history, tip, who)));
      if (tip === 7) {
        await pipeline.tick(); assert.equal(store.get('meta', 'draft').proposal.batch.epoch, 7);
        await pipeline.close(); await store.close(); store = await Store.open(path); create(); held = false;
      }
      if (tip > 6) { await pipeline.tick(); await pipeline.tick(); }
    }
    const n = contract.db.get('a/' + who.address); assert.equal(contract.db.get(`v/${n}/p0`), '1');
    assert.equal(store.count('dedupe'), 0); assert.equal(store.count('finds'), 1);
    const latest = JSON.parse(await readFile(files.path('latest.json'), 'utf8')); assert.equal(latest.height, 9);
    assert.deepEqual(store.get('meta', 'ruleState').finds, {});
  } finally { await pipeline.close(); await store.close(); }
});

test('backlog with empty tip openings and later certified receipts remains signable after draft reload', async () => {
  const { fixture } = await import('../../committee/test/fixture.mjs');
  const path = await temp('receipt-backlog-'), history = fixtureHistory(30), store = await Store.open(path);
  const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  const committee = { async attestRoot(seal) {
    const attestations = await attestRoot(seal);
    await store.put('receiptCertificates', `${seal.tip}/${seal.hash}`, { seal, attestations }); return attestations;
  } };
  const pipeline = new Pipeline({ store, files: new Files(join(path, 'static')), history, intake, committee,
    reads: { batchLast: async () => ({ n: 0, to: 0 }), committeeEpoch: async () => 0, counted: async () => 8 },
    settings: { puzzleBits: 0, receiptSigners } });
  try {
    // Production afterObserve seals an empty opening immediately. Intake then
    // collects receipts until the next tip. A stall puts both in one batch.
    for (let tip = 6; tip <= 14; tip++) {
      await intake.observe({ tip, hash: history.hashAt(tip), counted: tip - 5, confirmed: tip - 5 });
      if (tip === 14) break;
      await intake.seal();
      if (![7, 13].includes(tip)) await intake.accept(rules.stableJSON(makeMove(history, tip, agent(), 'header')));
    }
    const draft = await pipeline.build(), proposal = structuredClone(draft.proposal);
    assert.deepEqual(draft.items.map(i => i.output.file.receipts.length), [0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0]);
    const certificates = store.list('receiptCertificates'); assert.equal(certificates.length, 6);
    const saved = await pipeline.loadDraft(); assert.deepEqual(saved.proposal, proposal);
    const f = fixture(); f.data.counted = saved.execution;
    f.reads.batchContext = async () => ({ last: saved.last, counted: saved.execution, state: saved.startState, patterns: saved.startPatterns,
      gateway: intake.gateway, settings: saved.settings, limits: saved.limits, headers: saved.headers,
      inputs: saved.items.map(i => i.input), history, hashAt: history.hashAt });
    f.reads.receiptCertificate = async (tip, hash) => store.get('receiptCertificates', `${tip}/${hash}`);
    assert.equal((await f.policy.approve(saved.proposal)).digest, Buffer.from(rules.batchDigest(network, proposal.batch)).toString('hex'));
    assert.deepEqual(store.list('receiptCertificates'), certificates);
    assert.deepEqual((await pipeline.loadDraft()).proposal, proposal);
  } finally { await pipeline.close(); await store.close(); }
});
