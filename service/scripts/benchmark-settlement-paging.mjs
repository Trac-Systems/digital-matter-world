import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Synthetic accepted claim snapshots isolate closure and delivery from intake.
// Every measured batch uses the SQLite gateway worker, real account proofs and
// independent signer replay. There are no network adapters or broadcasts.
const root = resolve(process.env.BENCH_ROOT ?? new URL('../..', import.meta.url).pathname);
const directory = resolve(process.env.BENCH_OUT ?? '.test-tmp/settlement-paging');
const reference = process.env.BENCH_REFERENCE && resolve(process.env.BENCH_REFERENCE);
const load = file => import(pathToFileURL(join(root, file)));
const r = await load('rules/src/index.js');
const { accountOperationsRoot } = await load('rules/src/account-batch.js');
const { Replay } = await load('service/src/replay.mjs');
const { hotState } = await load('service/src/replay-state.mjs');
const { BatchReplay } = await load('committee/signer/replay-worker.mjs');
const { preflightBatch } = await load('committee/signer/preflight.mjs');
const { MAX_WIRE_BYTES } = await load('contract/settings.js');
const { accountSettings } = await load('rules/src/account-settings.js');
const { EvidenceStore } = await load('service/prod/evidence.mjs');
const { buildCreditAccounts } = await load('service/src/account-batch.mjs');
const { attest, receiptSigners } = await load('rules/test/witness-fixture.mjs');
const { ed25519 } = await load('rules/node_modules/@noble/curves/ed25519.js');
const number = (key, fallback) => {
  const n = Number(process.env[key] ?? fallback);
  assert.ok(Number.isSafeInteger(n) && n >= 0, key); return n;
};
// Per-phase worker timings and synchronous read round trips: on Node 24 use
// BENCH_PROFILE=1 node --import ./service/scripts/settlement-replay-profile.mjs
// service/scripts/benchmark-settlement-paging.mjs. Profile data is diagnostic;
// BENCH_CAPTURE / BENCH_REFERENCE still compare only canonical outputs.
const mode = process.env.BENCH_MODE ?? 'cost';
assert.ok(['cost', 'closure', 'stream'].includes(mode));
const readyArrivals = process.env.BENCH_READY === '1';
const pairs = number('BENCH_PAIRS', 3600), pages = number('BENCH_PAGES', 32);
const batches = number('BENCH_BATCHES', mode === 'cost' ? 1 : 120);
const assets = number('BENCH_ASSETS', 4), perOwner = number('BENCH_OWNER_PAIRS', 100);
assert.ok(pairs > 0 && assets > 0 && perOwner > 0 && perOwner <= 100);
const overrides = JSON.parse(process.env.BENCH_VALUES ?? '{}');
const publicClaims = process.env.BENCH_PUBLIC === '1';
let document = r.settingsRevision({ network: 'settlement-benchmark', effectiveBatch: '1', effectiveBitcoinWindow: '0',
  values: { ...r.SETTINGS_PROFILE, ...(publicClaims ? { ...r.PUBLIC_MINT_SETTINGS, claimsNeverCloseHeight: '0' } : {}),
    puzzleBits: 0, settlementPagesPerObservation: pages,
    closureWorkBudget: number('BENCH_WORK', 2048), closureReadBudget: number('BENCH_READS', 131072),
    closureByteBudget: number('BENCH_BYTES', 67108864), ...overrides } });
let settings = r.batchSettings({ document, receiptSigners, batchVersion: 2 });
const originalDocument = document, switchBatch = number('BENCH_SWITCH_BATCH', 0);
const successor = switchBatch ? r.settingsRevision({ network: document.network, previous: document,
  effectiveBatch: String(switchBatch), effectiveBitcoinWindow: '10000002',
  values: { ...document.values, ...JSON.parse(process.env.BENCH_SWITCH_VALUES ?? '{"closureWorkBudget":12288,"closureReadBudget":262144,"closureByteBudget":536870912,"settlementPagesPerObservation":64}') } }) : null;
if (successor) r.settingsSuccessor(document, successor);
const trackSettlements = switchBatch || process.env.BENCH_TRACK_SETTLEMENTS === '1';
const raw = height => { const bytes = Buffer.alloc(80); bytes.writeUInt32LE(1); bytes.writeUInt32LE(Number(height), 76); return bytes.toString('hex'); };
const hashAt = height => r.parseHeader(raw(height), Number(height)).hash;
const history = { length: 1000000000, raw, get: height => r.parseHeader(raw(height), Number(height)), hashAt };
await mkdir(directory, { recursive: true });
const database = join(directory, 'index.sqlite');
const created = await open(database, 'wx'); await created.close();
const db = new DatabaseSync(database);
db.exec('CREATE TABLE records (space TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(space,id)) WITHOUT ROWID;');
const insert = db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)');
const query = db.prepare('SELECT value FROM records WHERE space=? AND id=?');
const get = (space, id) => { const row = query.get(space, id); return row ? JSON.parse(row.value) : null; };
const persist = writes => { db.exec('BEGIN'); try { for (const row of writes) insert.run(row.space, row.id, JSON.stringify(row.value)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
const store = { directory, cacheKiB: 4096, get };
// Keep the production authenticated reader and its bounded caches. Substitute
// only the transport with the same bounded SQLite neighborhood response.
const evidenceValues = JSON.parse(process.env.BENCH_EVIDENCE_VALUES ?? '{}');
const evidence = new EvidenceStore({ config: { settings: evidenceValues }, now: () => 0 });
let evidenceRequests = 0, evidenceResponseBytes = 0, evidenceResponseRows = 0;
const requestedNodes = new Set();
evidence.exchange = async request => {
  assert.equal(request.op, 'index-nodes'); evidenceRequests++;
  requestedNodes.add(request.space + '/' + request.id);
  const queue = [request.id, ...(request.ids ?? []), ...(request.ancestors ?? [])], visited = new Set(), nodes = [];
  let bytes = 2;
  for (let i = 0; i < queue.length && nodes.length < evidence.settings.pageRows; i++) {
    const id = queue[i]; if (visited.has(id)) continue; visited.add(id);
    const row = get(request.space, id); if (!row) continue;
    assert.equal(r.hashObject(['dmw-stored-index-v2', row]), id);
    const size = Buffer.byteLength(r.stableJSON([id, row])) + (nodes.length ? 1 : 0);
    if (bytes + size > evidence.settings.chunkBytes) { assert.ok(nodes.length); break; }
    nodes.push([id, row]); bytes += size;
    for (const child of Object.values(row.children ?? {})) queue.push(typeof child === 'string' ? child : child.storage);
  }
  evidenceResponseBytes += bytes; evidenceResponseRows += nodes.length; return { nodes };
};
const storage = () => new r.ClaimStorage({ get: id => get('claimNodes', id), cacheSize: 256 });
const named = r.emptyNamedDiscovery(), savedNamed = new r.NamedStorage({ get: () => undefined, cacheSize: 256 }).save(named);
persist(savedNamed.writes);
const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: '10000003' } }, '10000002');
let state = { ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot),
  namedSnapshot: savedNamed.snapshot, catalogRoot: r.namedStateRoot(named), accountRoot: accountOperationsRoot([]) };
const manifest = { version: 1, network: document.network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '1',
  previousBatchRoot: r.hash('initial-batch'), bitcoinAnchor: { height: '0', hash: hashAt('0') }, settingsHash: r.hashObject(document),
  catalogRoot: state.catalogRoot, accountsRoot: state.accountRoot, receiptSegmentStart: '0',
  schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
const activation = { sequence: '1', previousRoot: manifest.previousBatchRoot, height: '0', hash: hashAt('0'), ruleset: 'dmw-v2',
  settingsRevision: '0', settingsHash: manifest.settingsHash, manifest, manifestHash: r.hashObject(manifest) };
const secret = r.hashBytes('synthetic-settlement-gateway'), gateway = r.bytesToHex(ed25519.getPublicKey(secret));
const deployment = { network: document.network, admin: gateway,
  committee: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  beacon: { checkpoint: { height: '0', hash: hashAt('0'), time: 0, bits: 486604799, chainwork: '1' } },
  v2: { manifest, manifestHash: activation.manifestHash, document, importRoot: r.hash('synthetic-import'), importRows: 1 } };
const signerNodeCache = number('BENCH_SIGNER_CACHE', r.RESOURCE_PROFILE.namedNodeCache);
const replay = new Replay(), signer = new BatchReplay({ nodeCacheEntries: signerNodeCache });
const gatewayProfiles = [], signerProfiles = [];
replay.worker.on('message', message => { if (message.replayProfile) gatewayProfiles.push(message.replayProfile); });
signer.worker.on('message', message => { if (message.replayProfile) signerProfiles.push(message.replayProfile); });
const patterns = Object.fromEntries(Array.from({ length: assets }, (_, i) => [String(i), { number: String(i), pat: '[0-9]', fld: 4, dt: 'n' }]));
const seedPages = [], initialWindows = new Set();
let serial = 0, previousRoot = r.hash('previous-batch');
function addWindow(window, count, closed, pendingPages) {
  const claims = storage(), loaded = claims.load(state, { decimal: true });
  // Replace an automatic empty observation round if this is its first intake.
  loaded.rounds = loaded.rounds.filter(round => round.window !== window);
  // Accepted intake has already opened its tip. Otherwise replay would append
  // a second empty round for the injected window when it advances lastTip.
  if (BigInt(window) > BigInt(loaded.lastTip)) { loaded.lastTip = window; loaded.highestTip = window; }
  const event = r.claimRound(window, hashAt(window), window, { root: state.catalogRoot, nextNumber: String(assets), revision: '0' });
  event.policy = { settingsHash: r.hashObject(document), claimsPerWindow: 100, claimWindowBlocks: 2, finderWindow: document.values.finderWindow };
  loaded.rounds.push(event);
  // Fixtures use disjoint block ranges, so validation against an empty local
  // window is equivalent and does not repeatedly traverse retained history.
  assert.ok(count <= 20000);
  const fresh = { rounds: [event], ...(publicClaims ? { publicMintGet: () => null } : {}) };
  const id = serial++;
  for (let offset = 0; offset < count; offset += perOwner) {
    const plots = Array.from({ length: Math.min(perOwner, count - offset) }, (_, j) => ({ block: String(10 + id * 20000 + offset + j), patterns: [String((offset + j) % assets)] }));
    r.enterClaims({ state: fresh, event, agent: r.hash('claimant/' + Math.floor(offset / perOwner)), plots, patterns, history, settings });
  }
  if (closed) {
    r.freezeClaimWindow({ state: fresh, event, decidingHash: hashAt(String(BigInt(window) + 2n)), counted: String(BigInt(window) + 2n), settings });
    const kind = process.env.BENCH_KIND ?? 'all';
    for (let n = 0; n < Number(event.pages); n++) {
      const page = r.recordGet(fresh.settlementPages, `${window}/${n}`), field = Object.keys(page)[0];
      seedPages.push({ field, rows: page[field].length, binaryBytes: r.encodeBinary(page).length, jsonBytes: Buffer.byteLength(r.stableJSON(page)) });
      if (kind === 'winners' && field !== 'winners') event.cursor = String(n + 1);
    }
    if (pendingPages !== undefined) event.cursor = String(Math.max(0, Number(event.pages) - pendingPages));
  }
  for (const field of r.CLAIM_MAPS) for (const [key, value] of Object.entries(r.recordChanges(fresh[field])))
    loaded[field] = r.recordSet(loaded[field], key, value);
  const saved = claims.save(loaded); persist(saved.writes); state = hotState(saved.state);
  assert.equal(new Set(state.rounds.map(round => round.window)).size, state.rounds.length);
}
function backlog() {
  const rounds = state.rounds.filter(round => round.closed || round.closing || Number(round.inputPages) > 0);
  return { windows: rounds.length, retainedWindows: state.rounds.length, closing: rounds.filter(round => !round.closed).length,
    pages: rounds.reduce((n, round) => n + (round.closed ? Number(BigInt(round.pages) - BigInt(round.cursor)) : 0), 0),
    pairs: rounds.reduce((n, round) => n + Number(round.closurePairs ?? 0), 0),
    closureBytes: rounds.reduce((n, round) => n + Number(round.closureBytes ?? 0), 0),
    initialWindows: rounds.filter(round => initialWindows.has(round.window)).length };
}
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0] ?? 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? 0, max: sorted.at(-1) ?? 0 };
};
const rows = [];
try {
  await signer.ready;
  const initialCount = number('BENCH_BACKLOG_WINDOWS', mode === 'stream' ? 0 : 1);
  const pending = process.env.BENCH_BACKLOG_PAGES === undefined ? undefined : number('BENCH_BACKLOG_PAGES', 450);
  for (let i = 0; i < initialCount; i++) {
    const window = String(9000000 + i); initialWindows.add(window);
    const quota = pending === undefined ? undefined : Math.floor(pending / initialCount) + (i < pending % initialCount ? 1 : 0);
    addWindow(window, quota === undefined ? pairs : Math.ceil(quota / 2) * document.values.settlementPageRows,
      mode === 'cost' || pending !== undefined, quota);
  }
  for (let i = 0; i < number('BENCH_UNCLOSED_WINDOWS', 0); i++) {
    const window = String(9000000 + initialCount + i); initialWindows.add(window);
    addWindow(window, pairs, false);
  }
  const initial = backlog(), sizes = (process.env.BENCH_SIZES ?? '2000,3600,3600,3600,3600,10000').split(',').map(Number);
  let arrivals = 0, lastArrival = -1, drainedAtMinutes = null;
  for (let n = 0; n < batches; n++) {
    const minutes = n * 3, epoch = Math.floor(minutes / 10), tip = String(10000002 + epoch);
    const batchSequence = String(n + 2), beforeRounds = trackSettlements ? structuredClone(state.rounds) : undefined;
    document = r.effectiveSettings(originalDocument, successor, batchSequence, tip);
    settings = r.batchSettings({ document, receiptSigners, batchVersion: 2 });
    if (mode === 'stream' && epoch !== lastArrival) {
      addWindow(readyArrivals ? String(BigInt(tip) - 2n) : tip, sizes[arrivals % sizes.length], readyArrivals); arrivals++; lastArrival = epoch;
    }
    const prior = r.recordGet(storage().load(state).receiptSegments, `${tip}/${hashAt(tip)}`);
    const receiptRoot = r.sealReceiptSegment([], { network: document.network, tip, hash: hashAt(tip), segment: prior ? String(BigInt(prior.segment) + 1n) : '0',
      previous: prior?.hash ?? null, ruleset: document.ruleset, settingsRevision: document.revision, settingsHash: r.hashObject(document) }, secret);
    const input = { state, settings, network: document.network, gateway, batchSequence, height: tip, executionHeight: tip,
      blockHash: hashAt(tip), tip, tipHash: hashAt(tip), entries: [], receiptRoot, rootAttestations: attest(receiptRoot),
      claimEvidence: { nodes: [] }, namedEvidence: { nodes: [] }, financialPlanning: true,
      ...(successor ? { settingsDocuments: [originalDocument] } : {}) };
    gatewayProfiles.length = 0; signerProfiles.length = 0;
    const start = performance.now(), retries = [];
    let output, accounts, replayMs = 0, accountMs = 0, publicReadPages = 0, publicReadPairs = 0;
    const publicMintBatch = pairs => { publicReadPages++; publicReadPairs += pairs.length; return pairs.map(() => ({ value: null })); };
    for (;;) {
      const tick = performance.now();
      output = await replay.run(input, history, { store, staged: new Map(), publicMintBatch });
      replayMs += performance.now() - tick;
      if (output.deliveryRows !== undefined) { retries.push('audit_budget'); input.deliveryRows = output.deliveryRows; }
      input.claimEvidence = output.claimEvidence; input.namedEvidence = output.namedEvidence;
      if (output.claimReadHints) input.claimReadHints = output.claimReadHints;
      else delete input.claimReadHints;
      if (publicClaims) input.publicMintEvidence = output.file.publicMintEvidence;
      const accountStart = performance.now();
      try {
        accounts = await buildCreditAccounts({ store, credits: output.file.ops, document, height: tip });
        input.accountOperations = accounts.operations;
        delete input.financialPlanning;
        if (!output.file.settlements.length && !output.file.closures.length && !output.file.closureProgress?.length) input.receiptContinuation = true;
        output = r.finalizeBlockV2Accounts(output, input);
        accountMs += performance.now() - accountStart; break;
      } catch (error) {
        accountMs += performance.now() - accountStart;
        const cap = input.deliveryRows ?? pages * document.values.settlementPageRows;
        if (!['account_operation', 'account_operation_bytes', 'account_proof_budget', 'account_leaf_budget', 'financial_batch_assets', 'audit_budget'].includes(error.message) || cap <= 1) throw error;
        retries.push(error.message); input.deliveryRows = Math.max(1, Math.floor(cap / 2)); delete input.accountOperations;
        input.financialPlanning = true;
      }
    }
    const last = { n: String(n + 1), to: state.counted };
    const built = r.buildBatchV2({ network: document.network, epoch: '0', sequence: batchSequence, lastTo: last.to, previousRoot,
      files: [output.file], executionHeight: tip, executionHash: hashAt(tip), settings, activation,
      catalogRoot: output.state.catalogRoot, accountRoot: output.state.accountRoot });
    const gatewayMs = performance.now() - start;
    const proposal = { kind: 'batch', network: document.network, batch: built.batch, files: built.fileBytes.map(r.bytesToHex) };
    const { state: _state, settings: _settings, ...wire } = input;
    evidence.payload = { id: r.hash(batchSequence), observedAt: 0, expiresAt: 1 };
    evidence.nodeHints.clear(); evidence.hintNodes('claimNodes', wire.claimEvidence.hints, wire.claimReadHints);
    evidence.hintNodes('namedNodes', wire.namedEvidence.hints);
    evidenceRequests = 0; evidenceResponseBytes = 0; evidenceResponseRows = 0; requestedNodes.clear();
    let reads = 0, evidenceReadMs = 0, bridgeRows = 0;
    const replayNodes = async (...args) => {
      reads++; const start = performance.now();
      try { const rows = await evidence.replayNodes(...args); bridgeRows += rows.length; return rows; }
      finally { evidenceReadMs += performance.now() - start; }
    };
    const signerDocument = r.effectiveSettings(originalDocument, successor, built.batch.n, built.batch.execution.height);
    assert.equal(built.batch.settingsHash, r.hashObject(signerDocument));
    const context = { state, settings: r.batchSettings({ document: signerDocument, receiptSigners, batchVersion: 2 }), gateway, patterns: {}, inputs: [wire], counted: tip, last, previousRoot, activation,
      authority: { epoch: '0' }, history, hashAt, replayNodes, publicMintBatch,
      claimNode: (...args) => evidence.claimNode(...args), namedNode: (...args) => evidence.namedNode(...args) };
    const contextBytes = Buffer.byteLength(JSON.stringify(context));
    assert.ok(contextBytes <= Math.min(r.RESOURCE_PROFILE.archiveObjectBytes, evidence.settings.maxObjectBytes));
    const signStart = performance.now(), signed = await signer.run(document.network, proposal, context), signerReplayMs = performance.now() - signStart;
    assert.equal(signed.digest, r.bytesToHex(built.signingDigest)); assert.deepEqual(signed.files, [output.file]);
    const preflightStart = performance.now();
    const records = new Map([['b/cnt', tip], ['bt/last', last], ['bt/' + last.n, previousRoot], ['bt/observation', state.observation],
      ['v2/manifest', manifest], ['v2/settings', originalDocument], ['v2/settings-next', successor], ['v2/claims', state.claimRoot],
      ['s/assets', { version: 2, settings: accountSettings(document) }]]);
    const checked = await preflightBatch(built.batch, { counted: tip, last }, { deployment,
      read: key => records.has(key) ? records.get(key) : key.startsWith('b/h/') ? hashAt(key.slice(4)) : get('accountRecords', key) });
    assert.equal(checked.digest, signed.digest);
    const preflightMs = performance.now() - preflightStart, signerMs = signerReplayMs + preflightMs;
    if (process.env.BENCH_PROFILE === '1') {
      assert.ok(gatewayProfiles.length > 0 && signerProfiles.length === 1, 'load settlement-replay-profile.mjs with --import');
    }
    const signedBatch = { ...built.batch, sig: '0'.repeat(128) };
    const row = { n, minutes, arrivals, gatewayMs, replayMs, accountMs, signerMs, signerReplayMs, preflightMs, totalMs: gatewayMs + signerMs,
      ...(process.env.BENCH_PROFILE === '1' ? { gatewayProfiles: [...gatewayProfiles], signerProfiles: [...signerProfiles] } : {}),
      reads, evidenceReadMs, bridgeRows, evidenceRequests, evidenceUniqueRequests: requestedNodes.size, evidenceResponseBytes, evidenceResponseRows,
      publicReadPages, publicReadPairs, retries,
      deliveryRowLimit: input.deliveryRows ?? pages * document.values.settlementPageRows,
      deliveries: output.file.settlements.length, deliveredRows: output.file.settlements.reduce((sum, p) => sum + p.to - p.from, 0),
      winners: output.file.settlements.reduce((sum, p) => sum + p.winners.length, 0),
      auditBytes: output.auditBytes.length, summaryBytes: output.viewerBytes.length,
      batchBytes: Buffer.byteLength(r.stableJSON(signedBatch)), envelopeBytes: Buffer.byteLength(r.stableJSON({ network: document.network, op: 'bt', value: signedBatch })),
      signerRequestBytes: Buffer.byteLength(JSON.stringify(proposal)), claimEvidenceBytes: Buffer.byteLength(r.stableJSON(wire.claimEvidence)),
      contextBytes, claimReadHintBytes: Buffer.byteLength(wire.claimReadHints ?? ''),
      accountOperationBytes: accounts.operations.map(op => Buffer.byteLength(r.stableJSON(op))),
      accountProofBytes: accounts.operations.flatMap(op => [...op.accounts.map(account => account.proof), op.supply.proof])
        .reduce((sum, proof) => sum + Buffer.byteLength(r.stableJSON(proof)), 0),
      assetTouches: accounts.assetTouches,
      closureProgress: output.file.closureProgress ?? [], closures: output.file.closures.map(c => ({ window: c.window, pages: c.pages, claims: c.claims, winners: c.winners })),
      digest: signed.digest, claimRoot: output.state.claimRoot };
    if (trackSettlements) Object.assign(row, { settingsHash: built.batch.settingsHash, settingsRevision: document.revision,
      beforeRounds, afterRounds: output.state.rounds,
      closureResults: output.file.closures, settlementResults: output.file.settlements });
    assert.ok(row.auditBytes <= document.values.auditTotalBytes && row.summaryBytes <= document.values.summaryBytes);
    row.signerRequestReservedBytes = row.signerRequestBytes + document.values.batchEnvelopeReserveBytes;
    // The local transport skips HttpSource dispatch pacing. Preserve a lower
    // bound for the configured source rate; this still excludes network RTT.
    row.sourcePacingFloorMs = Math.max(0, evidenceRequests - 1) * 1000 / evidence.settings.requestsPerSecond;
    row.pacedLowerBoundMs = gatewayMs + Math.max(signerMs, row.sourcePacingFloorMs);
    row.residentBytes = process.memoryUsage().rss;
    assert.ok(row.batchBytes <= document.values.batchBytes && row.envelopeBytes <= MAX_WIRE_BYTES);
    assert.ok(row.signerRequestReservedBytes <= r.RESOURCE_PROFILE.signerRequestBytes);
    assert.equal(new Set(output.state.rounds.map(round => round.window)).size, output.state.rounds.length);
    if (reference || process.env.BENCH_CAPTURE === '1') {
      const bytes = Buffer.from(r.stableJSON({ batch: built.batch, audit: r.bytesToHex(output.auditBytes), summary: r.bytesToHex(output.viewerBytes),
        checkpoint: output.state.claimSnapshot, claimWrites: output.claimWrites, namedWrites: output.namedWrites, accounts: accounts.writes }));
      const name = `batch-${String(n).padStart(5, '0')}.json`;
      if (reference) assert.deepEqual(bytes, await readFile(join(reference, name)), `replay bytes differ at batch ${n}`);
      if (process.env.BENCH_CAPTURE === '1') await writeFile(join(directory, name), bytes);
    }
    persist([...output.claimWrites, ...output.namedWrites, ...accounts.writes]); state = hotState(output.state); previousRoot = built.batch.root;
    Object.assign(row, backlog()); rows.push(row);
    if (initialWindows.size && !row.initialWindows && drainedAtMinutes === null) drainedAtMinutes = minutes + 3;
    await writeFile(join(directory, 'progress.json'), JSON.stringify({ mode, initial, settings: document.values, rows }, null, 2) + '\n');
    console.log(JSON.stringify(row));
    if (mode === 'closure' && !row.windows) break;
  }
  const metrics = Object.fromEntries(['gatewayMs', 'replayMs', 'accountMs', 'signerMs', 'signerReplayMs', 'preflightMs', 'totalMs', 'sourcePacingFloorMs', 'pacedLowerBoundMs', 'residentBytes', 'auditBytes', 'summaryBytes', 'batchBytes', 'envelopeBytes', 'signerRequestBytes', 'signerRequestReservedBytes', 'claimEvidenceBytes', 'deliveries', 'winners']
    .map(key => [key, distribution(rows.map(row => row[key]))]));
  const result = { node: process.version, root, mode, readyArrivals, pairs, assets, perOwner, signerNodeCache, evidenceSettings: evidence.settings, settings: document.values,
    ...(successor ? { originalDocument, successor } : {}), initial, arrivals,
    drainedAtMinutes, final: backlog(), seedPages, metrics, rows };
  await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, rows: rows.length, seedPages: seedPages.length }));
} finally { await replay.close(); await signer.close(); db.close(); }
