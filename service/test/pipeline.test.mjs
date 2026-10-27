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
