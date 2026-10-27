import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Intake } from '../src/intake.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Outbox } from '../src/transport.mjs';
import { serve } from '../src/http.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { PublicViews } from '../src/public-views.mjs';
import { Feeds } from '../src/feeds.mjs';
import { StateTransition } from '../../contract/state.js';
import { deployment, signedBatch } from '../../contract/tests/helpers/harness.mjs';
import { fixtureHistory, network, secret, patterns, attestRoot, receiptSigners } from '../test/helpers.mjs';
import { serial } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';
import { getHeapStatistics } from 'node:v8';
const [directory, blockText] = process.argv.slice(2), history = fixtureHistory(Number(blockText) + 30), store = await Store.open(directory);
const files = new Files(join(directory, 'static')), intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
const state = () => new StateTransition(async key => store.get('contract', key), { ...deployment, network });
const reads = { head: () => state().head(), batchLast: () => state().batchLast(), committeeEpoch: () => state().committeeEpoch(), balance: async (owner, asset) => { const s = state(); return s.balance(await s.agent(owner), asset); }, nonceUsed: async () => false };
const transport = {
  prepareMessage: async (op, value) => ({ op, value }),
  sendMessage: async ({ op, value }) => {
    const s = state(), error = await s.transaction(op, value, deployment.admin); if (error) throw Error(error);
    let bytes = 0; const operations = [];
    for (const [id, value] of s.writes) { bytes += Buffer.byteLength(id) + (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))); operations.push({ space: 'contract', id, value }); }
    const m = store.get('meta', 'contractMetrics') ?? { bytes: 0, dispatches: 0, maxBytes: 0 };
    operations.push({ space: 'meta', id: 'contractMetrics', value: { bytes: m.bytes + bytes, dispatches: m.dispatches + 1, maxBytes: Math.max(m.maxBytes, bytes) } });
    await store.transact(operations);
  },
  status: async job => ({ state: store.get('contract', 'bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' })
};
const outbox = new Outbox({ store, transport, fallbackMs: 1000000, retryMs: 0 });
const committee = { attestRoot, signature: async (_key, proposal) => ({ signature: { compact: signedBatch(proposal.batch, { ...deployment, network }).sig } }) };
const pipeline = new Pipeline({ store, files, history, intake, committee, outbox, reads, patterns, settings: { puzzleBits: 0, receiptSigners } });
const feeds = new Feeds({ store, files, history, reads });
const publicAPI = createPublicAPI({ files, views: new PublicViews({ store, files, history, reads, network }) });
const http = await serve({ intake, files, publicAPI });
const gate = serial();
process.on('message', message => { void gate(async () => {
  try {
    let result;
    if (message.op === 'observe') {
      const tip = message.tip;
      const sealed = await intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip,
        headers: tip === 6 ? Array.from({ length: 6 }, (_, i) => history.raw(i + 1)) : [history.raw(tip)] });
      if (sealed) await files.json(`receipts/${sealed.id}.json`, sealed.receiptRoot, { immutable: true });
      result = true;
    } else if (message.op === 'drain') {
      await pipeline.tick(); await pipeline.tick(); await feeds.tick();
      result = { latest: store.get('meta', 'latest'), error: store.get('meta', 'draft')?.proposal.batch.n ?? null };
    } else if (message.op === 'stats') {
      global.gc?.(); result = { memory: process.memoryUsage(), v8: getHeapStatistics(), worker: { threadId: pipeline.replay.worker.threadId }, resources: process.getActiveResourcesInfo(),
        sqlite: { cacheSize: store.db.prepare('PRAGMA cache_size').get().cache_size, mmapSize: store.db.prepare('PRAGMA mmap_size').get().mmap_size },
        pending: store.count('dedupe'), sequence: store.get('meta', 'receiptSequence'), observations: store.count('observations'),
        latest: store.get('meta', 'latest'), metrics: store.get('meta', 'contractMetrics') };
    } else if (message.op === 'close') {
      await http.close(); await pipeline.close(); await store.close(); process.send({ id: message.id, result: true }); process.exit(0);
    } else throw Error('command');
    process.send({ id: message.id, result });
  } catch (e) { console.error(e.stack); process.send({ id: message.id, error: e.message }); }
}); });
process.send({ ready: http.url, pid: process.pid });
