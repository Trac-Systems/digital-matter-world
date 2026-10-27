import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Intake } from '../src/intake.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Files } from '../src/files.mjs';
import { Store } from '../src/store.mjs';
import { Outbox } from '../src/transport.mjs';
import { PublicIndex } from '../src/public-index.mjs';
import { eventSpec } from '../src/read-specs.mjs';
import { rules } from '../src/rules.mjs';
import { harness, deployment, signedBatch } from '../../contract/tests/helpers/harness.mjs';
import { temp, network, secret, fixtureHistory, makeMove, agent, patterns, attestRoot, receiptSigners } from './helpers.mjs';

test('free header intake replays into contract units, durable finds and attributed header_find feed events', async () => {
  const path = await temp('header-'), history = fixtureHistory(), contract = harness({ ...deployment, network });
  const store = await Store.open(path), files = new Files(join(path, 'static')), who = agent();
  const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  const reads = { batchLast: async () => contract.state().batchLast(), committeeEpoch: () => contract.state().committeeEpoch(), balance: async () => '0', nonceUsed: async () => false };
  const committee = { attestRoot, signature: async (_, proposal) => ({ signature: { compact: signedBatch(proposal.batch, { ...deployment, network }).sig } }) };
  const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => assert.equal(await contract.run(m.op, m.value), null),
    status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
  const table = Array.from({ length: 30 }, (_, number) => ({ ...patterns[0], number, name: `dmwheader${number}` }));
  const pipeline = new Pipeline({ store, files, history, intake, committee, outbox: new Outbox({ store, transport, fallbackMs: 100000, retryMs: 0 }), reads, patterns: table,
    limits: { maxOps: 12, maxAssets: 16 }, settings: { puzzleBits: 0, receiptSigners } });
  try {
    for (let tip = 6; tip <= 19; tip++) {
      await intake.observe({ tip, hash: history.hashAt(tip), counted: tip - 5, confirmed: tip - 5,
        headers: tip === 6 ? Array.from({ length: 6 }, (_, i) => history.raw(i + 1)) : [history.raw(tip)] });
      if (tip === 6) {
        const header = makeMove(history, tip, who, 'header'); await intake.accept(rules.stableJSON(header));
        assert.deepEqual(await intake.accept(rules.stableJSON(header)), store.get('dedupe', rules.moveId(header)).receipt);
      }
      if (tip > 6) { await pipeline.tick(); await pipeline.tick(); }
    }
    const account = contract.db.get('a/' + who.address);
    for (const asset of table.map(rules.patternAsset)) assert.equal(contract.db.get(`v/${account}/${asset}`), '1');
    assert.equal(store.count('finds'), 30); assert.ok(store.list('finds').every(r => r.value.source === 'header'));
    // Recreate the index between segments; progress belongs to durable storage.
    await new PublicIndex({ store, files, history, reads }).tick();
    await new PublicIndex({ store, files, history, reads }).tick();
    const events = store.list('publicEvents').map(r => r.value).filter(e => e.type === 'header_find');
    assert.equal(events.length, 30); assert.equal(store.list('publicEvents').filter(r => r.value.type === 'find').length, 0);
    for (const e of events) {
      assert.equal(e.data.finder, who.address); assert.equal(e.data.tickets, 1); assert.equal(e.data.block, 6); assert.ok(e.provenance.audit.hash);
      assert.equal(eventSpec.match(e, { category: 'chain', actor: who.address }), true);
      assert.ok(rules.publicIdentities(e).data.finder.startsWith('trac1'));
    }
    assert.equal(store.list('publicDraws').filter(r => r.value.block === 6).reduce((n,r) => n+r.value.winners.length,0), 30);
  } finally { await pipeline.close(); await store.close(); }
});
