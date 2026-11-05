import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// Run against a retained source tree as well as the current checkout. All
// fixtures are synthetic; replay uses the real gateway and signer workers.
const root = resolve(process.env.BENCH_ROOT ?? new URL('../..', import.meta.url).pathname);
const directory = resolve(process.env.BENCH_OUT ?? '.test-tmp/closure-benchmark');
const reference = process.env.BENCH_REFERENCE && resolve(process.env.BENCH_REFERENCE);
const pairs = Number(process.env.BENCH_PAIRS ?? 4000), work = Number(process.env.BENCH_WORK ?? 2048);
const variant = process.env.BENCH_VARIANT ?? 'claims';
const bridgeDelayMs = Number(process.env.BENCH_BRIDGE_DELAY_MS ?? 0), busyMs = Number(process.env.BENCH_BUSY_MS ?? 0);
const gatewayReplays = Number(process.env.BENCH_GATEWAY_REPLAYS ?? 1);
const publicMints = process.env.BENCH_PUBLIC_MINTS === '1';
const pipelineRetries = process.env.BENCH_PIPELINE_RETRIES === '1';
const window = variant === 'spread' ? '10000' : '1000', tip = String(BigInt(window) + 2n);
await mkdir(directory, { recursive: true });
const load = file => import(pathToFileURL(join(root, file)));
const r = await load('rules/src/index.js');
const { accountOperationsRoot } = await load('rules/src/account-batch.js');
const { decodeNodeHints } = await load('rules/src/node-evidence.js');
const { Replay } = await load('service/src/replay.mjs');
const { BatchReplay } = await load('committee/signer/replay-worker.mjs');
const { EvidenceStore } = await load('service/prod/evidence.mjs');
const { attest, receiptSigners } = await load('rules/test/witness-fixture.mjs');
const { ed25519 } = await load('rules/node_modules/@noble/curves/ed25519.js');
const document = r.settingsRevision({ network: 'closure-benchmark', effectiveBatch: '1', effectiveBitcoinWindow: '0',
  values: { ...r.SETTINGS_PROFILE, ...(publicMints ? { ...r.PUBLIC_MINT_SETTINGS, claimsNeverCloseHeight: '0' } : {}),
    puzzleBits: 0, closureWorkBudget: work } });
const settings = r.batchSettings({ document, receiptSigners, batchVersion: 2 });
const raw = height => { const bytes = Buffer.alloc(80); bytes.writeUInt32LE(1); bytes.writeUInt32LE(Number(height), 76); return bytes.toString('hex'); };
const hashAt = height => r.parseHeader(raw(height), Number(height)).hash;
const history = { length: Number(tip) + 1, raw, get: height => r.parseHeader(raw(height), Number(height)), hashAt };
const filename = join(directory, 'index.sqlite'), db = new DatabaseSync(filename);
// Fixture persistence is outside the measured replay interval and disposable.
db.exec('PRAGMA synchronous=OFF');
db.exec('CREATE TABLE IF NOT EXISTS records (space TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(space,id)) WITHOUT ROWID; DELETE FROM records;');
const insert = db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)');
const persist = writes => { db.exec('BEGIN'); for (const row of writes) insert.run(row.space, row.id, JSON.stringify(row.value)); db.exec('COMMIT'); };
const query = db.prepare('SELECT value FROM records WHERE space=? AND id=?');
const get = (space, id) => { const row = query.get(space, id); return row && JSON.parse(row.value); };
const storage = new r.ClaimStorage({ get: id => get('claimNodes', id), cacheSize: 256 });
const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: String(BigInt(tip) + 1n) } }, String(BigInt(tip) - 1n));
const loaded = storage.load({ ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot) });
const named = r.emptyNamedDiscovery();
const namedSaved = new r.NamedStorage({ get: () => undefined, cacheSize: 256 }).save(named);
persist(namedSaved.writes);
const event = r.claimRound(window, variant === 'void' ? r.hash('orphan') : hashAt(window), window,
  { root: r.namedStateRoot(named), nextNumber: '2', revision: '0' });
loaded.rounds = [event];
const patterns = Object.fromEntries(['0', '1'].map(number => [number, { number, pat: '[0-9]', fld: 4, dt: 'n' }]));
for (let offset = 0; offset < pairs; offset += 40) {
  const plots = Array.from({ length: Math.min(20, Math.ceil((pairs - offset) / 2)) }, (_, j) => ({ block: String(10 + j + (variant === 'spread' ? offset / 2 : 0)), patterns: ['0', '1'] }));
  r.enterClaims({ state: loaded, event, agent: r.hash('claimant/' + offset), plots, patterns, history, settings });
}
if (['headers', 'claims', 'edge'].includes(variant)) event.headerSenders = [r.hash('header/1'), r.hash('header/2'), r.hash('header/1')];
if (variant === 'headers' || variant === 'edge') {
  event.headerCount = '3';
  for (let i = 0; i < 3; i++) loaded.headerInputs = r.recordSet(loaded.headerInputs, `${window}/${i}`, r.hash('header/' + (i + 2)));
}
if (variant === 'edge') {
  for (const plot of [{ block: '10', patterns: ['0'] }, { block: '11', patterns: ['0', '1'] }])
    r.enterClaims({ state: loaded, event, agent: r.hash('claimant/0'), plots: [plot], patterns, history, settings });
}
const saved = storage.save(loaded); persist(saved.writes);
let state = { ...saved.state, namedSnapshot: namedSaved.snapshot, catalogRoot: r.namedStateRoot(named), accountRoot: accountOperationsRoot([]) };
const manifest = { version: 1, network: document.network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '1',
  previousBatchRoot: r.hash('initial-batch'), bitcoinAnchor: { height: '0', hash: hashAt('0') }, settingsHash: r.hashObject(document),
  catalogRoot: state.catalogRoot, accountsRoot: state.accountRoot, receiptSegmentStart: '0',
  schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
const activation = { sequence: '1', previousRoot: manifest.previousBatchRoot, height: '0', hash: hashAt('0'), ruleset: 'dmw-v2',
  settingsRevision: '0', settingsHash: manifest.settingsHash, manifest, manifestHash: r.hashObject(manifest) };
const secret = r.hashBytes('synthetic-benchmark-gateway'), gateway = r.bytesToHex(ed25519.getPublicKey(secret));
const replay = new Replay(), signer = new BatchReplay();
let previousReceipt = null, previousRoot = r.hash('previous-batch');
const chunks = [];
let gatewayReads; replay.worker.on('message', message => { if (message.benchmarkReads) gatewayReads = message.benchmarkReads; });
const busyTimer = busyMs > 0 && setInterval(() => { const end = performance.now() + busyMs; while (performance.now() < end) {} }, 20);
try {
  await signer.ready;
  for (let n = 0; n < 100000; n++) {
    const batchSequence = String(n + 2), before = state.rounds.find(round => round.window === window)?.closing?.phase ?? 'scan';
    const receiptRoot = r.sealReceiptSegment([], { network: document.network, tip, hash: hashAt(tip), segment: String(n), previous: previousReceipt,
      ruleset: document.ruleset, settingsRevision: document.revision, settingsHash: r.hashObject(document) }, secret);
    const input = { state, settings, network: document.network, gateway, batchSequence, height: tip, executionHeight: tip,
      blockHash: hashAt(tip), tip, tipHash: hashAt(tip), entries: [], receiptRoot, rootAttestations: attest(receiptRoot),
      claimEvidence: { nodes: [] }, namedEvidence: { nodes: [] }, accountOperations: [] };
    let output, publicMintCalls = 0, gatewayMs = 0; const gatewayQueries = [], replayBytes = [];
    for (let repetition = 0; repetition < gatewayReplays; repetition++) {
      const replayStart = performance.now();
      const result = await replay.run(input, history, { store: { directory, cacheKiB: 4096 }, staged: new Map(),
        publicMintBatch: async pairs => { publicMintCalls++; if (bridgeDelayMs) await delay(bridgeDelayMs); return pairs.map(() => ({ value: null })); } });
      gatewayMs += performance.now() - replayStart;
      if (output && !pipelineRetries) assert.deepEqual(result, output);
      output = result; gatewayQueries.push(gatewayReads);
      if (pipelineRetries) replayBytes.push(JSON.stringify(result));
      if (pipelineRetries) {
        input.claimEvidence = result.claimEvidence; input.namedEvidence = result.namedEvidence;
        if (publicMints) input.publicMintEvidence = result.file.publicMintEvidence;
      }
    }
    const last = { n: String(n + 1), to: state.counted };
    const built = r.buildBatchV2({ network: document.network, epoch: '0', sequence: batchSequence, lastTo: last.to, previousRoot,
      files: [output.file], executionHeight: tip, executionHash: hashAt(tip), settings, activation,
      catalogRoot: output.state.catalogRoot, accountRoot: output.state.accountRoot });
    const proposal = { kind: 'batch', network: document.network, batch: built.batch, files: built.fileBytes.map(r.bytesToHex) };
    const { state: _state, settings: _settings, ...wire } = input;
    if (publicMints) wire.publicMintEvidence = output.file.publicMintEvidence;
    if (process.env.BENCH_COLD_SIGNER === '1') { wire.claimEvidence = { nodes: [] }; wire.namedEvidence = { nodes: [] }; }
    if (process.env.BENCH_COLD_SIGNER !== '1') {
      wire.claimEvidence = output.claimEvidence; wire.namedEvidence = output.namedEvidence;
    }
    let reads = 0, sourcePages = 0, sourceRows = 0;
    const reader = new EvidenceStore({ config: { settings: {} }, now: () => 0 });
    reader.payload = { id: 'local-snapshot', observedAt: 0, expiresAt: 30000 };
    reader.hintNodes('claimNodes', wire.claimEvidence.hints);
    reader.hintNodes('namedNodes', wire.namedEvidence.hints);
    // Keep the production reader/cache/neighbor implementation. Only its
    // authenticated transport is replaced by a deterministic SQLite page.
    reader.exchange = async request => {
      assert.equal(request.op, 'index-nodes'); sourcePages++;
      const queue = [request.id, ...(request.ids ?? []), ...(request.ancestors ?? [])], seen = new Set(), nodes = [];
      let bytes = 2;
      for (let i = 0; i < queue.length && nodes.length < reader.settings.pageRows; i++) {
        const id = queue[i]; if (seen.has(id)) continue; seen.add(id);
        const row = get(request.space, id); if (!row) continue;
        assert.equal(r.hashObject(['dmw-stored-index-v2', row]), id);
        const size = Buffer.byteLength(r.stableJSON([id, row])) + (nodes.length ? 1 : 0);
        if (bytes + size > reader.settings.chunkBytes) { assert.ok(nodes.length); break; }
        nodes.push([id, row]); bytes += size; sourceRows++;
        for (const child of Object.values(row.children ?? {})) queue.push(typeof child === 'string' ? child : child.storage);
      }
      return { nodes };
    };
    const bridge = async action => { reads++; if (bridgeDelayMs) await delay(bridgeDelayMs); return action(); };
    const replayNodes = (...args) => bridge(() => reader.replayNodes(...args));
    const context = { state, settings, gateway, patterns: {}, inputs: [wire], counted: tip, last, previousRoot, activation,
      authority: { epoch: '0' }, history, hashAt, replayNodes,
      claimNode: (id, ancestors) => bridge(() => reader.claimNode(id, ancestors)), namedNode: (id, ancestors) => bridge(() => reader.namedNode(id, ancestors)) };
    const signStart = performance.now(), signed = await signer.run(document.network, proposal, context), signerMs = performance.now() - signStart;
    assert.equal(signed.digest, r.bytesToHex(built.signingDigest));
    assert.deepEqual(signed.files, [output.file]);
    const bytes = Buffer.from(JSON.stringify({ output, proposal, signed }));
    const name = `chunk-${String(n).padStart(5, '0')}.json`;
    if (reference) assert.deepEqual(bytes, await readFile(join(reference, name)), `complete replay bytes differ at chunk ${n}`);
    await writeFile(join(directory, name), bytes);
    if (pipelineRetries) {
      const digests = JSON.stringify(replayBytes);
      if (reference) assert.equal(digests, await readFile(join(reference, name + '.replays'), 'utf8'));
      await writeFile(join(directory, name + '.replays'), digests);
    }
    const progress = output.file.closureProgress;
    const row = { n, before, after: output.state.rounds.find(round => round.window === window)?.closing?.phase ?? 'done',
      gatewayMs, signerMs, reads, sourcePages, sourceRows, gatewayQueries, publicMintCalls, progress, bytes: bytes.length, digest: r.hash(bytes) };
    chunks.push(row); console.log(JSON.stringify(row));
    persist([...output.claimWrites, ...output.namedWrites]); state = output.state;
    previousReceipt = r.receiptSegmentHash(receiptRoot); previousRoot = built.batch.root;
    if (output.file.closures.some(closure => closure.window === window)) break;
  }
  assert.ok(chunks.at(-1).after === 'done', 'window did not close');
  const result = { node: process.version, root, pairs, work, variant, bridgeDelayMs, busyMs, gatewayReplays, publicMints, pipelineRetries, signerEvidence: process.env.BENCH_COLD_SIGNER !== '1', chunks,
    gatewayMs: chunks.reduce((sum, row) => sum + row.gatewayMs, 0), signerMs: chunks.reduce((sum, row) => sum + row.signerMs, 0) };
  await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, chunks: chunks.length }));
} finally { if (busyTimer) clearInterval(busyTimer); await replay.close(); await signer.close(); db.close(); }
