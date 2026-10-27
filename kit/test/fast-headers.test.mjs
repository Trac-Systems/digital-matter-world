import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HeaderHistory, parseHeader } from '../../rules/src/index.js';
import { chain } from '../../contract/tests/helpers/chain.mjs';
import { Files } from '../../service/src/files.mjs';
import { HeaderFiles } from '../../service/src/header-files.mjs';
import { serve } from '../../service/src/http.mjs';
import { headerSource, downloadHeaders, historyProof, loadClaimHeaders, assertHistoryTip, loadHistoryAsync } from '../lib/headers.mjs';
import { HistorySync } from '../lib/history-sync.mjs';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { gameTools } from '../lib/tools.mjs';
import { createMcp } from '../lib/mcp.mjs';
import { temp, cleanup, fakeTrac, testWallet, patterns } from './helpers.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { tip = 63 } = {}) {
  const dir = await temp(t), bytes = Buffer.from((await readFile(new URL('./fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  const full = new HeaderHistory(bytes), state = { tip, requests: [], transferred: 0 };
  const history = { get length() { return state.tip + 1; }, hashAt: h => h >= 0 && h <= state.tip ? full.get(h).hash : null, raw: h => full.raw(h) };
  const files = new Files(join(dir, 'static')), headers = new HeaderFiles({ history, files, network: 'mainnet' });
  const http = await serve({ intake: {}, files, headers }); cleanup(t, () => http.close());
  const source = headerSource(http.url, { fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/api/block-height/')) return new Response(history.hashAt(Number(path.split('/').at(-1))));
    return fetch(url, options);
  } });
  const archive = source.archive;
  source.archive = async (path, options = {}) => { state.requests.push(options.start); const r = await archive(path, options); state.transferred += Number(r.headers.get('content-length')); return r; };
  source.blocks = () => { throw Error('Metadata pages must never be used'); };
  const independent = { hash: async h => history.hashAt(h) }, output = join(dir, 'headers.bin');
  return { dir, bytes, full, history, state, source, independent, output, headers, preferGzip: false };
}
test('bulk download verifies one file from genesis and transfers only the appended bytes on refresh', async t => {
  const f = await fixture(t, { tip: 31 }); let verified;
  const first = await downloadHeaders({ ...f, onHistory: h => { verified = h; } });
  assert.equal(first.count, 32); assert.equal(first.independentTipChecked, true); assert.equal(historyProof(verified).tip, f.full.get(31).hash);
  assert.deepEqual(f.state.requests, [0]); assert.equal(f.state.transferred, 32 * 80);
  assert.equal((await downloadHeaders(f)).downloaded, 0); assert.equal(f.state.requests.length, 1);
  f.state.tip = 63;
  const next = await downloadHeaders({ ...f, currentHistory: verified }); assert.equal(next.downloaded, 32);
  assert.deepEqual(f.state.requests, [0, 32 * 80]); assert.equal(f.state.transferred, 64 * 80);
  assert.deepEqual(await readFile(f.output), f.bytes);
});
test('an interrupted stream resumes at the exact byte, including part of a header', async t => {
  const f = await fixture(t), archive = f.source.archive; let interrupted = false;
  f.source.archive = async (path, options) => {
    if (interrupted) return archive(path, options);
    interrupted = true; let first = true;
    return new Response(new ReadableStream({ async pull(controller) {
      if (first) { first = false; controller.enqueue(f.bytes.subarray(0, 137)); }
      else { await sleep(10); controller.error(Error('disconnected')); }
    } }), { headers: { 'content-length': String(f.bytes.length) } });
  };
  await assert.rejects(downloadHeaders(f), /disconnected/);
  assert.equal((await stat(f.output + '.part')).size, 137); await assert.rejects(stat(f.output), { code: 'ENOENT' });
  await downloadHeaders(f); assert.deepEqual(f.state.requests, [137]); assert.deepEqual(await readFile(f.output), f.bytes);
});
test('resume safely restarts when Range is ignored, and rejects false Content-Range', async t => {
  for (const badRange of [false, true]) {
    const f = await fixture(t), manifest = await f.source.manifest();
    await writeFile(f.output + '.part', f.bytes.subarray(0, 137)); await writeFile(f.output + '.part.json', JSON.stringify(manifest));
    f.source.archive = async () => new Response(badRange ? f.bytes.subarray(137) : f.bytes, { status: badRange ? 206 : 200,
      headers: badRange ? { 'content-range': `bytes 0-${f.bytes.length - 138}/${f.bytes.length}` } : {} });
    if (badRange) { await assert.rejects(downloadHeaders(f), /Content-Range/); await assert.rejects(stat(f.output), { code: 'ENOENT' }); }
    else { await downloadHeaders(f); assert.deepEqual(await readFile(f.output), f.bytes); }
  }
});
test('corrupted bytes, forged checksums, wrong manifest tips and independent tip mismatches never publish a file', async t => {
  for (const variant of ['corrupt', 'forged', 'tip', 'independent', 'source', 'oversized', 'path', 'network']) {
    const f = await fixture(t), original = await f.source.manifest(), manifest = { ...original }, bytes = Buffer.from(f.bytes);
    if (['corrupt', 'forged'].includes(variant)) bytes[80 + 76] ^= 1;
    if (variant === 'forged') manifest.sha256 = hash(bytes);
    if (variant === 'tip') { manifest.tip = '11'.repeat(32); manifest.path = `/headers/mainnet-63-${manifest.tip}.bin`; manifest.gzip = { ...manifest.gzip, path: manifest.path + '.' + manifest.gzip.sha256 + '.gz' }; }
    if (variant === 'path') manifest.path = 'https://otherParty.invalid/archive.bin';
    if (variant === 'network') manifest.network = 'regtest';
    f.source.manifest = async () => manifest;
    f.source.archive = async () => new Response(variant === 'oversized' ? Buffer.concat([bytes, Buffer.from([0])]) : bytes);
    if (variant === 'independent') f.independent.hash = async () => '22'.repeat(32);
    if (variant === 'source') f.source.hash = async () => '22'.repeat(32);
    await assert.rejects(downloadHeaders(f), /checksum|pow|tip mismatch|tip changed|exceeds|manifest/);
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  }
});
test('failed update preserves the prior verified file and a mainnet bulk download requires an independent source', async t => {
  const f = await fixture(t, { tip: 31 }); await downloadHeaders(f); const original = await readFile(f.output);
  f.state.tip = 63; f.independent.hash = async () => '22'.repeat(32);
  await assert.rejects(downloadHeaders(f), /Independent tip mismatch/); assert.deepEqual(await readFile(f.output), original);
  await assert.rejects(downloadHeaders({ ...f, independent: null }), /independent mainnet/);
});

test('gzip downloads resume compressed bytes, verify both digests and use raw Range for later headers', async t => {
  const f = await fixture(t, { tip: 31 }), manifest = await f.source.manifest();
  const compressed = Buffer.from(await (await f.source.archive(manifest.gzip.path)).arrayBuffer()); f.state.requests = []; f.state.transferred = 0;
  await writeFile(f.output + '.part.gz', compressed.subarray(0, 137)); await writeFile(f.output + '.part.gz.json', JSON.stringify(manifest.gzip));
  const result = await downloadHeaders({ ...f, preferGzip: true });
  assert.equal(result.compression, 'gzip'); assert.equal(result.downloadedBytes, compressed.length - 137);
  assert.deepEqual(f.state.requests, [137]); assert.deepEqual(await readFile(f.output), f.bytes.subarray(0, 32 * 80));
  f.state.tip = 63; await downloadHeaders({ ...f, preferGzip: true });
  assert.deepEqual(f.state.requests, [137, 32 * 80]); assert.deepEqual(await readFile(f.output), f.bytes);
});

test('forged compressed files and inflated output are refused before publication', async t => {
  for (const variant of ['checksum', 'inflated']) {
    const f = await fixture(t), manifest = await f.source.manifest();
    if (variant === 'checksum') {
      const actual = manifest.gzip.path, archive = f.source.archive;
      manifest.gzip.sha256 = '11'.repeat(32); manifest.gzip.path = manifest.path + '.' + manifest.gzip.sha256 + '.gz';
      f.source.archive = (_path, options) => archive(actual, options);
    }
    else {
      // The real gzip contains 64 headers but this forged manifest promises 32.
      manifest.height = 31; manifest.count = 32; manifest.bytes = 32 * 80; manifest.tip = f.full.get(31).hash;
      manifest.path = `/headers/mainnet-31-${manifest.tip}.bin`; manifest.gzip.path = manifest.path + '.' + manifest.gzip.sha256 + '.gz';
      const actual = await f.headers.manifest(), archive = f.source.archive;
      f.source.archive = (_path, options) => archive(actual.gzip.path, options);
    }
    f.source.manifest = async () => manifest;
    await assert.rejects(downloadHeaders({ ...f, preferGzip: true }), /checksum|exceeds manifest/);
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  }
});

test('current and pre-checkpoint claims need only their headers; forged hashes, PoW and reorgs are refused', async t => {
  const f = await fixture(t), history = f.full, { trac } = fakeTrac({ get: h => history.get(h), hashAt: h => h < 50 ? null : history.get(h).hash }, { tip: 63 });
  const requests = [], source = { chainView: f.source.chainView, header: async hash => {
    for (let h = 0; h < history.length; h++) if (history.get(h).hash === hash) { requests.push(h); return Buffer.from(history.raw(h)).toString('hex'); }
    throw Error('unknown header');
  } };
  const journal = await Journal.open(join(f.dir, 'journal'), 'fast-claim'); cleanup(t, () => journal.close());
  const agent = new Agent({ wallet: testWallet(), network: trac.network, service: { network: trac.network, block: async () => ({ claimWindow: { window: 63, open: true } }) }, trac, journal });
  const sparse = await loadClaimHeaders({ heights: [63, 5, 12], source, trac, head: await trac.head(), independent: f.independent });
  assert.deepEqual(requests, [63, 5, 12]); assert.throws(() => sparse.get(0), /outside/); assert.throws(() => historyProof(sparse), /complete header file/);
  const claim = { event: { window: 63, hash: history.get(63).hash }, plots: [{ block: 5, patterns: [0] }, { block: 12, patterns: [0] }], history: sparse, patterns,
    header: { height: 63, raw: sparse.raw(63) } };
  assert.equal((await agent.claim(claim)).state, 'dry-run');
  await assert.rejects(agent.headers({ height: 5, raw: sparse.raw(5), history: sparse }), /window is closed/);
  await assert.rejects(loadClaimHeaders({ heights: [5], source, trac, head: await trac.head(), independent: { hash: async () => 'aa'.repeat(32) } }), /Independent claim/);
  await assert.rejects(loadClaimHeaders({ heights: [5], source, trac, head: await trac.head(), independent: null }), /independent source is required/);
  await assert.rejects(loadClaimHeaders({ heights: [63], source: { header: async () => 'ff'.repeat(80) }, trac, head: await trac.head() }));
  await assert.rejects(loadClaimHeaders({ heights: [5], source: { ...source, chainView: async () => ({ height: 5, hash: history.get(5).hash, tip: { height: 63, hash: 'aa'.repeat(32) } }) }, trac, head: await trac.head(), independent: f.independent }), /differs from contract/);
  trac.hashAt = async h => h < 50 ? null : 'bb'.repeat(32); await assert.rejects(agent.claim(claim), /reorganized/);
  assert.throws(() => assertHistoryTip(sparse, history.get(63)), /complete header file/);
});

test('mine_once sends the tip header while the all-history archive loads', async t => {
  const f = await fixture(t), { trac } = fakeTrac({ get: h => f.full.get(h), hashAt: h => f.full.get(h).hash }, { tip: 63 });
  const journal = await Journal.open(join(f.dir, 'journal'), 'fast-once'); cleanup(t, () => journal.close());
  const requests = [], source = { header: async hash => { const h = [63, 5].find(h => f.full.get(h).hash === hash); assert.notEqual(h, undefined); requests.push(h); return Buffer.from(f.full.raw(h)).toString('hex'); } };
  const service = { network: trac.network, patterns: async () => ({ patterns, total: patterns.length, limit: 50, next: null }), latest: async () => ({ summary: {} }),
    publication: async () => ({ tip: 63, tipHash: f.full.get(63).hash, }), block: async () => ({ claimWindow: { window: 63, open: true } }) };
  const agent = new Agent({ wallet: testWallet(), network: trac.network, service, trac, journal }), tools = gameTools({ agent, source });
  const claim = await tools.mine_once.run({}); assert.equal(claim.action, 'header'); assert.equal(claim.claimState, 'history_downloading'); assert.deepEqual(requests, [63]);
  await assert.rejects(tools.post_header.run({ height: 5 }), /window is closed/); assert.equal((await tools.post_header.run({})).action, 'header');
});

test('discovery reports download progress immediately and uses fresh verified history without restarting tools', async t => {
  const f = await fixture(t); let release;
  const blocked = new Promise(resolve => { release = resolve; }), manifest = f.source.manifest;
  f.source.manifest = async (...args) => { await blocked; return manifest(...args); };
  const sync = new HistorySync({ ...f, pollMs: 100000 }).start(); cleanup(t, () => sync.close());
  let headReads = 0;
  const agent = { owner: '11'.repeat(32), trac: { head: async () => { headReads++; return { tip: f.full.get(63) }; } }, catalog: async () => [] };
  const tools = gameTools({ agent, historySync: sync });
  const server = await createMcp({ agent, historySync: sync }), client = new Client({ name: 'fast-start-test', version: '1' });
  cleanup(t, () => server.close()); cleanup(t, () => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  assert.equal((await client.listTools()).tools.length, Object.keys(tools).length);
  const pending = await client.callTool({ name: 'search_patterns', arguments: {} });
  assert.equal(pending.isError, undefined); assert.equal(JSON.parse(pending.content[0].text).state, 'history_downloading');
  for (const name of ['search_patterns', 'propose_pattern', 'reveal_pattern']) {
    const result = await tools[name].run({}); assert.equal(result.state, 'history_downloading'); assert.match(result.message, /history downloading \(0%\)/);
  }
  assert.equal(headReads, 0); release(); await sync.pending;
  const result = await tools.search_patterns.run({ maxCandidates: 1, candidates: [{ name: 'dmwfast', pat: '[12]', fld: 4, dt: 'n' }] });
  assert.equal(result.accepted.length, 1); assert.equal(sync.status().state, 'ready');
  agent.trac.head = async () => ({ tip: { height: 64, hash: '11'.repeat(32) } });
  assert.equal((await tools.search_patterns.run({})).state, 'history_downloading');
});

test('verification in the background has the same proof as the canonical mainnet verifier', async t => {
  const f = await fixture(t); await writeFile(f.output, f.bytes); const history = await loadHistoryAsync(f.output);
  assert.equal(historyProof(history).sha256, hash(f.bytes)); assert.equal(historyProof(history).count, 64);
});

test('a regtest reorg downloads only the replacement tail and claims use fresh headers while history catches up', async t => {
  const dir = await temp(t), genesis = Buffer.from('01000000' + '00'.repeat(32) + '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' + 'dae5494dffff7f2002000000', 'hex');
  const prefix = [genesis.toString('hex'), ...chain(31, parseHeader(genesis))];
  const branches = [1, 2].map(tag => new HeaderHistory(Buffer.from([...prefix, ...chain(32, parseHeader(prefix.at(-1)), 600, tag)].join(''), 'hex')));
  let selected = branches[0]; const ranges = [];
  const source = {
    hash: async h => selected.get(h).hash,
    header: async hash => { for (let h = 0; h < selected.length; h++) if (selected.get(h).hash === hash) return Buffer.from(selected.raw(h)).toString('hex'); throw Error('missing header'); },
    manifest: async () => ({ version: 1, network: 'regtest', height: 63, count: 64, tip: selected.get(63).hash, bytes: 5120, sha256: hash(selected.bytes), path: `/headers/regtest-63-${selected.get(63).hash}.bin` }),
    archive: async (_path, { start }) => { ranges.push(start); return new Response(selected.bytes.slice(start), { status: start ? 206 : 200,
      headers: start ? { 'content-range': `bytes ${start}-5119/5120` } : {} }); }
  };
  const output = join(dir, 'reorg.bin'); let before;
  await downloadHeaders({ output, source, independent: null, network: 'regtest', onHistory: h => { before = h; } });
  selected = branches[1];
  const { trac } = fakeTrac({ get: h => selected.get(h), hashAt: h => h >= 50 ? selected.get(h).hash : null }, { tip: 63 });
  source.chainView = async h => ({ height: h, hash: selected.get(h).hash, tip: selected.get(63) });
  const journal = await Journal.open(join(dir, 'journal'), 'reorg-claim'); cleanup(t, () => journal.close());
  const service = { network: trac.network, patterns: async () => ({ patterns, total: patterns.length, limit: 50, next: null }), latest: async () => ({ summary: {} }),
    publication: async () => ({ tip: 63, tipHash: selected.get(63).hash, }), block: async () => ({ claimWindow: { window: 63, open: true } }) };
  const agent = new Agent({ wallet: testWallet(), network: trac.network, service, trac, journal, powLimitBits: 0x207fffff });
  assert.equal((await agent.runOnce({ history: before, source })).action, 'header');
  await assert.rejects(agent.postHeader({ height: 5, source }), /window is closed/);
  assert.equal((await agent.postHeader({ height: 63, history: before, source })).payload.raw, await source.header(selected.get(63).hash));
  const result = await downloadHeaders({ output, source, independent: null, network: 'regtest', currentHistory: before });
  assert.equal(result.downloaded, 32); assert.deepEqual(ranges, [0, 32 * 80]); assert.deepEqual(await readFile(output), Buffer.from(selected.bytes));
});
