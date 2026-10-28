import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { BatchReplay } from '../signer/replay-worker.mjs';
import { ReplayHistories } from '../signer/replay-history.mjs';
import { rules, rebuildBatch } from '../signer/adapter.mjs';
import { batchFixture, network } from './fixture.mjs';
import { headerAgent } from '../../rules/test/header-fixture.mjs';
import { BitcoinViews } from '../../service/prod/bitcoin.mjs';
import { mine } from '../../contract/tests/helpers/chain.mjs';

async function headers(t, count) {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-replay-')), filename = join(directory, 'bitcoin.sqlite');
  t.after(() => rm(directory, { recursive: true }));
  const db = new DatabaseSync(filename);
  t.after(() => db.close());
  db.exec('CREATE TABLE headers(hash TEXT PRIMARY KEY,height INTEGER,parent TEXT,raw TEXT,periodTime INTEGER,times TEXT)');
  const put = db.prepare('INSERT INTO headers(hash,height,parent,raw) VALUES(?,?,?,?)'), bytes = new Uint8Array(count * 80);
  let prev = '00'.repeat(32);
  db.exec('BEGIN');
  for (let height = 0; height < count; height++) {
    const raw = mine(prev, 1000 + height), h = rules.parseHeader(raw, height);
    put.run(h.hash, height, h.prev, raw); bytes.set(Buffer.from(raw, 'hex'), height * 80); prev = h.hash;
  }
  db.exec('COMMIT');
  const full = new rules.HeaderHistory(bytes), source = tip => ({ filename, tip, tipHash: full.get(tip).hash });
  return { db, full, source, filename };
}

test('heavy discovery replay uses the local verified branch without any history RPC and preserves the digest', async t => {
  const f = await headers(t, 66000), hashAt = h => f.full.get(h).hash, gateway = headerAgent(9);
  const state = { lastTip: 65982, counted: 65977, highestTip: 65982,
    discoveryQueue: [{ agent: headerAgent(1).agent, commitment: rules.hash('queued'), tip: 65980, height: 65977,
      snapshotHash: hashAt(65977), proposal: { name: 'dmwtest', pat: '123', fld: 10, dt: 'n' } }] };
  const context = { state, patterns: [], last: { n: 0, to: 65977 }, counted: 65993, authority: { epoch: 0 },
    gateway: gateway.agent, settings: { puzzleBits: 0 }, inputs: [], views: [] };
  let current = state, patterns = [], files = [];
  for (let tip = 65983; tip <= 65998; tip++) {
    const input = { height: tip - 5, tip, blockHash: hashAt(tip - 5), tipHash: hashAt(tip), entries: [],
      receiptRoot: rules.sealReceipts([], { network, tip, hash: hashAt(tip) }, gateway.secret) };
    const history = { length: tip + 1, get: h => f.full.get(h), field: (...a) => f.full.field(...a) };
    context.inputs.push(input); context.views.push({ hashAt, history });
    const output = rules.processBlock({ ...context, ...input, network, state: current, patterns, history, hashAt, priorOperations: rules.budgetOperations(files), executionHeight: context.counted });
    current = output.state; patterns = output.patterns; files.push(output.file);
  }
  assert.equal(files.reduce((n, f) => n + f.discovery.work, 0), 65536);
  const built = rules.buildBatch({ network, epoch: 0, sequence: 1, lastTo: context.last.to, executionHeight: context.counted, files });
  const proposal = { network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(rules.bytesToHex) };
  const expected = rebuildBatch(network, proposal, context);
  const forbidden = () => { throw Error('unexpected_history_rpc'); };
  context.views = context.inputs.map(i => ({ hashAt: forbidden, history: { replaySource: f.source(i.tip), get: forbidden, field: forbidden, get length() { return forbidden(); } } }));
  const replay = new BatchReplay(); t.after(() => replay.close());
  for (let i = 0; i < 2; i++) {
    const actual = await replay.run(network, proposal, context);
    assert.equal(actual.digest, expected.digest); assert.deepEqual(actual.files, expected.files);
  }
});

test('local replay snapshots bind every observation tip, retain forks and reject missing ancestors', async t => {
  const f = await headers(t, 12), cache = new ReplayHistories(), old = f.source(11);
  const raw = mine(f.full.get(9).hash, 9000), branch = rules.parseHeader(raw, 10);
  f.db.prepare('INSERT INTO headers(hash,height,parent,raw) VALUES(?,?,?,?)').run(branch.hash, 10, branch.prev, raw);
  const sources = [f.source(5), old, { filename: f.filename, tip: 10, tipHash: branch.hash }];
  const views = cache.views(sources);
  assert.equal(views[0].history.length, 6); assert.equal(views[0].hashAt(6), null);
  assert.throws(() => views[0].history.field(6, 10), /bitcoin_history_missing/);
  assert.equal(views[1].hashAt(10), f.full.get(10).hash); assert.equal(views[2].hashAt(10), branch.hash);
  for (let h = 0; h < 10; h++) for (const [field, dt] of [[4, 'n'], [10, 'n'], [11, 'n'], [11, 'h']])
    assert.equal(views[2].history.field(h, field, dt), f.full.field(h, field, dt));
  const extending = new ReplayHistories(), prefix = extending.load(f.source(5));
  assert.deepEqual(extending.load(old).bytes, f.full.bytes);
  assert.equal(prefix.length, 6, 'extending a snapshot cannot change an earlier observation');
  let parent = branch;
  for (let h = 11; h <= 12; h++) {
    const raw = mine(parent.hash, 9000 + h); parent = rules.parseHeader(raw, h);
    f.db.prepare('INSERT INTO headers(hash,height,parent,raw) VALUES(?,?,?,?)').run(parent.hash, h, parent.prev, raw);
  }
  const fork = extending.load({ filename: f.filename, tip: 12, tipHash: parent.hash });
  assert.equal(fork.get(10).hash, branch.hash, 'a longer fork must not reuse another branch prefix');
  f.db.prepare('DELETE FROM headers WHERE height=4').run();
  assert.throws(() => new ReplayHistories().views([old]), /bitcoin_history_missing/);
  assert.throws(() => new ReplayHistories().views([{ ...old, tip: 10 }]), /bitcoin_history_missing/);
});

test('production BitcoinViews supplies a trusted local replay descriptor', async t => {
  const f = await headers(t, 2), views = new BitcoinViews({}, f.filename); t.after(() => views.close());
  const view = await views.view(1, f.full.get(1).hash);
  assert.deepEqual(view.replaySource, f.source(1));
});

test('timeout terminates the worker, fences concurrent replay and replaces it for the next request', async t => {
  const replay = new BatchReplay(); t.after(() => replay.close());
  const { context, proposal, built } = batchFixture(); context.authority = { epoch: 0 };
  await replay.ready;
  const old = replay.worker, exited = once(old, 'exit');
  replay.timeoutMs = 1;
  const slow = { ...context, state: { ...context.state, discoveryQueue: [{ agent: '11'.repeat(32), commitment: rules.hash('timeout'),
    tip: 90, height: 2000, snapshotHash: context.hashAt(2000), proposal: { name: 'dmwslow', pat: '123', fld: 10, dt: 'n' } }] } };
  await assert.rejects(replay.run(network, proposal, slow), /replay_timeout/);
  await exited;
  replay.timeoutMs = 120000;
  const next = replay.run(network, proposal, context);
  await assert.rejects(replay.run(network, proposal, context), /replay_busy/);
  assert.equal((await next).digest, Buffer.from(built.signingDigest).toString('hex'));
  assert.notEqual(replay.worker, old);
  await replay.close(); await assert.rejects(replay.run(network, proposal, context), /replay_closed/);
});

test('an idle or in-flight worker exit can be retried without restarting the signer', async t => {
  const replay = new BatchReplay(); t.after(() => replay.close());
  const { context, proposal, built } = batchFixture(); context.authority = { epoch: 0 };
  await replay.ready; await replay.worker.terminate();
  assert.equal((await replay.run(network, proposal, context)).digest, Buffer.from(built.signingDigest).toString('hex'));
  const running = assert.rejects(replay.run(network, proposal, context), /replay_exit/);
  await replay.worker.terminate(); await running;
  assert.equal((await replay.run(network, proposal, context)).digest, Buffer.from(built.signingDigest).toString('hex'));
});

test('replay timeout setting rejects values that Node would silently clamp', () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, '30000', 1.5, 2147483648]) assert.throws(() => new BatchReplay({ timeoutMs }), /replay_timeout_setting/);
});

test('replay node cache rejects unbounded or invalid capacities', () => {
  for (const nodeCacheEntries of [0, -1, NaN, Infinity, '4096', 1.5]) assert.throws(() => new BatchReplay({ nodeCacheEntries }), /replay_node_cache_setting/);
});
