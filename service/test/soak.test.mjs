import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { options, save, json, recorded, stopRecorded, identity, random, build } from '../scripts/soak/common.mjs';
import { Accounting, Histogram, memoryTrend, terminalPayment, diskSize, delta } from '../scripts/soak/metrics.mjs';
import { agent, network } from './helpers.mjs';
import { rules } from '../src/rules.mjs';
import { settlePaid } from '../scripts/soak/paid.mjs';

async function temporary(t) {
  await mkdir(join(build, 'service'), { recursive: true });
  const path = await mkdtemp(join(build, 'service', 'soak-test-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test('soak CLI validates workload, floor cadence and private output scope', () => {
  assert.equal(options(['--blocks', '300', '--agents', '100']).blocks, 300);
  for (const args of [['--blocks', '-1'], ['--agents', '501'], ['--every', '0'], ['--seed', 'NaN'], ['--stall-ms', '0'], ['--out', '/tmp/public'], ['--out', 'relative'], ['--wat'], ['--resume', '--stop']]) assert.throws(() => options(args));
});
test('soak durable checkpoints replace the complete document and stay private', async t => {
  const directory = await temporary(t), path = join(directory, 'state.json');
  await save(path, { stage: 1, transaction: 'first' }); await save(path, { stage: 2 });
  assert.deepEqual(await json(path), { stage: 2 }); assert.ok((await readFile(path, 'utf8')).endsWith('\n'));
});
test('soak supply accounting detects missing credits, duplicate batches and double burns', () => {
  const accounting = new Accounting(), who = agent(1), request = { owner: who.address, asset: 'p0', amount: '2', receive: '01'.repeat(32), nonce: '02'.repeat(32), until: 20, expires: 30 };
  accounting.apply({ n: 1, ops: [{ op: 'mk', asset: 'p0', amount: '10' }, { op: 'rq', request }, { op: 'xc', request: { in: [['p0', '3']], out: [['c0', '1']] } }] }, network);
  const rows = [['b/cnt', 10], ['an/1', who.address], ['v/1/p0', '5'], ['v/1/c0', '1'], ['e/1/p0', [[30, '2']]], ['m/' + rules.pendingId(network, request), { o: 1, asset: 'p0', amount: '2', e: 30, s: 0 }]];
  assert.deepEqual(accounting.check(rows).assets, { p0: '7', c0: '1' });
  assert.throws(() => accounting.check(rows.filter(([k]) => k !== 'v/1/c0')), /conservation/);
  assert.throws(() => accounting.apply({ n: 1, ops: [] }, network), /batch_gap/);
  accounting.apply({ n: 2, ops: [{ op: 'mc', id: rules.pendingId(network, request) }] }, network);
  assert.equal(accounting.supply.get('p0'), 5n);
  assert.throws(() => accounting.apply({ n: 3, ops: [{ op: 'mc', id: rules.pendingId(network, request) }] }, network), /consumption_without_request/);
});
test('soak conservation includes hashlocks and detects a missing timeout', () => {
  const accounting = new Accounting(); accounting.apply({ n: 1, ops: [{ op: 'mk', asset: 'p0', amount: '4' }] }, network);
  const rows = [['an/1', agent(1).address], ['an/2', agent(2).address], ['b/cnt', 5], ['v/1/p0', '1'], ['l/' + '03'.repeat(32), { o: 1, to: 2, assets: [['p0', '3']], refund: 10 }]];
  assert.equal(accounting.check(rows).locks, 1);
  delete rows.at(-1)[1].refund; assert.throws(() => accounting.check(rows), /lock_without_timeout/);
});
test('soak accounting pages real SQLite across asynchronous root reads and garbage collection', async t => {
  const directory = await temporary(t); await mkdir(join(directory, 'static'));
  const bytes = rules.encodeBinary({ receipts: [{ sequence: 1 }] }), root = rules.merkleRoot([bytes]);
  await writeFile(join(directory, 'static', 'audit.bin'), bytes);
  const db = new DatabaseSync(join(directory, 'index.sqlite')); t.after(() => db.close());
  db.exec('CREATE TABLE records(space TEXT, id TEXT, value TEXT)');
  for (let n = 1; n <= 130; n++) db.prepare('INSERT INTO records VALUES(?,?,?)').run('batches', String(n).padStart(16, '0'), JSON.stringify({ batch: { n, root, ops: [{ op: 'mk', asset: 'p0', amount: '1' }] }, publications: [{ audit: { path: '/audit.bin' } }] }));
  const accounting = new Accounting(); let receipts = 0;
  await accounting.update({ database: () => db }, async () => { await new Promise(resolve => setImmediate(resolve)); global.gc?.(); return root; }, { data: directory, network }, () => receipts++);
  assert.equal(accounting.lastBatch, 130); assert.equal(accounting.supply.get('p0'), 130n); assert.equal(receipts, 130);
  await accounting.update({ database: () => db }, () => { throw Error('already accounted'); }, { data: directory, network });
});
test('soak terminal-state assertion rejects neither and both exits', () => {
  assert.equal(terminalPayment({ released: true, refunded: false }, 'a'), 'released');
  assert.equal(terminalPayment({ released: false, refunded: true }, 'a'), 'refunded');
  for (const same of [true, false]) assert.throws(() => terminalPayment({ released: same, refunded: same }, 'a'), /exclusivity/);
});
test('soak accounting retries changing pages and lagging acceptance but rejects a stable supply mismatch', async () => {
  const accounting = new Accounting(); let attempt = 0, reads = 0;
  accounting.update = async () => {
    attempt++;
    if (attempt === 3) accounting.apply({ n: 1, ops: [{ op: 'mk', asset: 'p0', amount: '4' }] }, network);
  };
  const trac = async method => {
    assert.equal(method, 'stamp');
    return { revision: ++reads === 1 ? 1 : 2, last: { n: 1 } };
  };
  const rows = () => [['an/1', agent(1).address], ['b/cnt', 5], ['v/1/p0', attempt === 1 ? '5' : '4']];
  assert.equal((await accounting.snapshot(null, trac, { network }, rows)).assets.p0, '4');
  assert.equal(attempt, 3, 'wait for committed revision and local acceptance');
  await assert.rejects(accounting.snapshot(null, trac, { network }, () => [...rows(), ['v/1/p1', '1']]), /conservation: p1/);
});
test('soak bounded histograms retain tail failures and empty measurements', () => {
  const h = new Histogram(); assert.equal(h.summary().p99, null);
  for (let i = 0; i < 98; i++) h.add(1); h.add(2000); h.add(25000);
  assert.equal(h.summary().p99, 2000); assert.equal(h.summary().max, 25000); assert.equal(h.bins.length, 1002);
});
test('soak memory growth uses process-separated warmed segments', () => {
  const flat = Array.from({ length: 8 }, (_, i) => ({ block: i * 25, pid: 1, rss: 100000, heapUsed: 1000 }));
  assert.equal(memoryTrend(flat).status, 'pass');
  assert.equal(memoryTrend(flat.map(r => ({ ...r, rss: r.block * 2000000 }))).status, 'fail');
  assert.equal(memoryTrend(flat.map((r, i) => ({ ...r, pid: i }))).status, 'insufficient_samples');
});
test('soak physical disk metrics do not follow symlinks and report signed deltas', async t => {
  const directory = await temporary(t); await save(join(directory, 'file.json'), { test: true }); await symlink(directory, join(directory, 'loop'));
  const size = await diskSize(directory); assert.equal(size.files, 1); assert.ok(size.bytes > 0 && size.allocated > 0);
  assert.deepEqual(delta({ bytes: 20 }, { bytes: 30 }, 2), { bytes: -5 });
});
test('soak PID cleanup refuses recycled identities and stops only its recorded child', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const record = await recorded(child.pid, 'test-child'); t.after(async () => { if (await identity(child.pid)) await stopRecorded(record); });
  await assert.rejects(stopRecorded({ ...record, identity: record.identity + '-wrong' }), /pid_identity_changed/);
  assert.equal(await identity(child.pid), record.identity); await stopRecorded(record); assert.equal(await identity(child.pid), null);
});
test('soak seeded fault selection is reproducible', () => {
  const a = random(42), b = random(42); assert.deepEqual(Array.from({ length: 30 }, a), Array.from({ length: 30 }, b));
});
test('soak paid sends survive a dropped broadcast using one persisted signed identity', async () => {
  let prepared = 0, clock = 0, sends = 0, accepted = false; const events = [], packet = { tx: 'tx', nonce: 'nonce', signature: 'signed' };
  const tx = await settlePaid({ client: {
    prepare: async () => { prepared++; return packet; }, transactionStatus: async () => ({ state: accepted ? 'accepted' : 'pending' }),
    submit: async p => { assert.deepEqual(p, packet); assert.equal(events[0].state, 'prepared'); accepted = ++sends === 2; return { tx: p.tx }; }
  }, connect: async () => events.push({ state: 'connected' }), persist: async e => events.push(e), now: () => clock, wait: async ms => { clock += ms; } });
  assert.equal(tx, 'tx'); assert.equal(prepared, 1); assert.equal(sends, 2); assert.equal(events.at(-1).state, 'accepted');
});
test('soak paid sends reconcile acceptance after a lost response', async () => {
  let sent = false, clock = 0;
  const tx = await settlePaid({ client: { prepare: async () => ({ tx: 'same' }), transactionStatus: async () => ({ state: sent ? 'accepted' : 'pending' }),
    submit: async () => { sent = true; throw Error('response lost'); } }, connect: async () => {}, persist: async () => {}, now: () => clock, wait: async ms => { clock += ms; } });
  assert.equal(tx, 'same');
});
test('soak paid sends stop on rejection and retain the prepared packet on timeout', async () => {
  const persisted = []; let clock = 0;
  const args = { client: { prepare: async () => ({ tx: 'saved' }), transactionStatus: async () => ({ state: 'rejected' }), submit: async () => { throw Error('should not submit'); } },
    connect: async () => {}, persist: async r => persisted.push(r), now: () => clock, wait: async ms => { clock += ms; }, timeout: 1000 };
  await assert.rejects(settlePaid(args), /paid_transaction_rejected/); assert.equal(persisted[0].packet.tx, 'saved');
  args.client.transactionStatus = async () => ({ state: 'pending' });
  await assert.rejects(settlePaid(args), /paid_transaction_timeout/); assert.equal(persisted.at(-1).packet.tx, 'saved');
});
