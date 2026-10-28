import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EvidenceStore, evidencePublisher, signEvidence } from '../evidence.mjs';
import { Store } from '../../src/store.mjs';
import { AuthenticatedIndex, verifyRange } from '../../src/authenticated-index.mjs';
import { edPublic, hash } from '../../src/util.mjs';
import { migrateReaderStorage } from '../../scripts/migrate-reader-storage.mjs';
import * as rules from '../../../rules/src/index.js';

test('claim nodes stream by content hash beyond 8 MB without an all-history proof index', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dmw-claim-evidence-')), store = await Store.open(join(root, 'gateway'));
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const before = store.evidenceIndex.root(), rows = [];
  for (let i = 0; i < 5000; i++) {
    const key = String(i), value = { winner: hash(key), data: 'x'.repeat(1800) }, prefix = rules.hash(key);
    const row = { prefix, key, value, commitment: rules.hashObject(['dmw-named-leaf-v2', prefix, key, value]) };
    rows.push({ space: 'claimNodes', id: rules.hashObject(['dmw-stored-index-v2', row]), value: row });
  }
  await store.transact(rows); assert.equal(store.evidenceIndex.root(), before);
  assert.ok(store.db.prepare("SELECT sum(length(value)) AS n FROM records WHERE space='claimNodes'").get().n > 8_000_000);
  const secret = Buffer.alloc(32, 4), identity = Buffer.alloc(32, 5), stamp = { tip: 10, tipHash: hash('tip') };
  const config = { network: 'test', epoch: 0, data: store.directory, committee: [{ id: 'one', peer: { identity: edPublic(identity) } }], prod: { contexts: root } };
  const publisher = evidencePublisher({ config, store, reads: { trac: async () => stamp }, secret }); t.after(() => publisher.close());
  let tamper, calls = 0, bytes = 0;
  const reader = await EvidenceStore.open({ config: { directory: join(root, 'reader'), network: 'test', epoch: 0, member: 'one' },
    identity, gateway: edPublic(secret), clock: async () => stamp, stamp: async () => stamp, source: { request: async (_, { body }) => {
      const result = await publisher(body); calls++; bytes += JSON.stringify(result).length;
      if (tamper) { tamper(result.payload); result.signature = signEvidence(result.payload, secret); } return result;
    } } }); t.after(() => reader.close());
  await reader.refresh(); calls = 0; bytes = 0;
  assert.deepEqual(await reader.claimNode(rows[4000].id), rows[4000].value); assert.equal(calls, 1); assert.ok(bytes < 5000);
  const pointReadBytes = bytes;
  tamper = p => { p.result.nodes[0][1].value.winner = hash('replacement'); };
  await assert.rejects(reader.claimNode(rows[4001].id), /evidence_claim_node_hash/);
  tamper = p => { p.result = null; };
  await assert.rejects(reader.claimNode(rows[4002].id), /evidence_claim_node_hash/);
  tamper = null;
  await assert.rejects(reader.claimNode(hash('missing')), /evidence_claim_node_hash/);
  calls = 0;
  reader.hintNodes('claimNodes', rows.slice(4500, 4550).map(row => row.id));
  for (const row of rows.slice(4500, 4550)) assert.deepEqual(await reader.claimNode(row.id), row.value);
  assert.equal(calls, 1, 'exact touched hashes batch unrelated leaf reads without fetching their history');
  const packed = await reader.replayNodes('claimNodes', rows[4500].id, [], 7);
  assert.equal(packed.length, 7); assert.equal(packed[0][0], rows[4500].id);
  for (const [id, row] of packed) assert.equal(rules.hashObject(['dmw-stored-index-v2', row]), id);
  assert.equal((await reader.replayNodes('claimNodes', rows[4500].id, [], 1)).length, 1);
  await assert.rejects(reader.replayNodes('claimNodes', rows[4500].id, [], 0), /evidence_replay_nodes/);
  reader.now = () => reader.payload.expiresAt;
  await assert.rejects(reader.replayNodes('claimNodes', rows[4500].id, [], 7), /evidence_missing_or_stale/);
  t.diagnostic(JSON.stringify({ archivedClaimNodes: rows.length, pointReadBytes, treeUnchanged: true }));
});

test('authenticated range proofs reject omitted leaves and survive AVL insertions/deletions', () => {
  const db = new DatabaseSync(':memory:'), index = new AuthenticatedIndex(db), keys = [];
  try {
    for (let i = 0; i < 200; i++) { const key = String((i * 73) % 200).padStart(4, '0'); keys.push(key); index.set(key, hash(key)); }
    for (const key of keys.filter((_, i) => i % 3 === 0)) index.set(key, null);
    const remaining = keys.filter((_, i) => i % 3 !== 0).sort(), lower = '0020', upper = '0120';
    const proof = index.proof(lower, upper, 1000);
    assert.deepEqual(verifyRange(index.root(), lower, upper, proof, 1000), remaining.filter(k => k >= lower && k <= upper).map(k => [k, hash(k)]));
    assert.throws(() => verifyRange(index.root(), lower, upper, index.root(), 1000), /proof_gap/);
    for (const key of remaining) index.set(key, null);
    assert.deepEqual(verifyRange(index.root(), lower, upper, index.proof(lower, upper, 1000), 1000), []);
  } finally { db.close(); }
});

test('leaf misses prefetch hash-checked siblings within the configured node and byte budgets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dmw-neighbor-evidence-')), store = await Store.open(join(root, 'gateway'));
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  let state = rules.emptyNamedDiscovery();
  for (let i = 0; i < 512; i++) state = { ...state, records: rules.namedSet(state.records, String(i), { i }) };
  const persistence = new rules.NamedStorage({ get: () => null, cacheSize: 256 }), saved = persistence.save(state);
  await store.transact(saved.writes);
  const path = [], rows = new Map(saved.writes.map(r => [r.id, r.value]));
  const storage = new rules.NamedStorage({ get: (id, ancestors) => { path.push({ id, ancestors }); return rows.get(id); }, cacheSize: 256 });
  assert.deepEqual(rules.namedGet(storage.load(saved.snapshot).records, '123'), { i: 123 });
  const leaf = path.at(-1), secret = Buffer.alloc(32, 31), identity = Buffer.alloc(32, 32), stamp = { tip: 10, tipHash: hash('tip') };
  const settings = { pageRows: 64, nodeCacheEntries: 128, prefetchCacheEntries: 64, chunkBytes: 16000 };
  const publisher = evidencePublisher({ config: { network: 'test', epoch: 0, data: store.directory,
    committee: [{ id: 'one', peer: { identity: edPublic(identity) } }], prod: { contexts: root, evidenceSettings: settings } },
    store, reads: { trac: async () => stamp }, secret }); t.after(() => publisher.close());
  let calls = 0, response;
  const reader = await EvidenceStore.open({ config: { directory: join(root, 'reader'), network: 'test', epoch: 0, member: 'one', settings },
    identity, gateway: edPublic(secret), clock: async () => stamp, stamp: async () => stamp,
    source: { request: async (_, { body }) => { calls++; response = await publisher(body); return response; } } }); t.after(() => reader.close());
  await reader.refresh(); calls = 0;
  assert.deepEqual(await reader.namedNode(leaf.id, leaf.ancestors), rows.get(leaf.id));
  const neighbors = response.payload.result.nodes;
  assert(neighbors.length > 2 && neighbors.length <= settings.pageRows);
  assert(Buffer.byteLength(rules.stableJSON(neighbors)) <= settings.chunkBytes);
  for (const [id, row] of neighbors) assert.deepEqual(await reader.namedNode(id), row);
  assert.equal(calls, 1, 'nearby nodes require only one source request even when the first miss is a leaf');
  // Churn speculative neighbors without replacing the executor's hot nodes.
  let churn = 0;
  for (const [id] of rows) {
    if (reader.nodeCache.has('namedNodes/' + id) || reader.prefetchCache.has('namedNodes/' + id)) continue;
    await reader.namedNode(id); if (++churn === 16) break;
  }
  const before = calls; assert.deepEqual(await reader.namedNode(leaf.id), rows.get(leaf.id)); assert.equal(calls, before);
  assert(reader.nodeCache.size <= settings.nodeCacheEntries && reader.prefetchCache.size <= settings.prefetchCacheEntries);
  await assert.rejects(reader.namedNode(hash('missing'), leaf.ancestors), /evidence_index_node_hash/);
});

test('targeted evidence crosses 4096 rows and 8 MB; snapshots, proofs and restart cache stay bounded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dmw-evidence-v2-'));
  const store = await Store.open(join(root, 'gateway'), { groupDelay: 1 }); t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const secret = Buffer.alloc(32, 7), identity = Buffer.alloc(32, 9), stamp = { tip: 5, tipHash: 'ab'.repeat(32), last: { n: 3, to: 4 } };
  let now = 10000;
  const settings = { pageRows: 8, pageBytes: 100_000, chunkBytes: 16000, maxAgeMs: 60000 };
  const config = { network: 'test', epoch: 1, data: store.directory, committee: [{ id: 'one', peer: { identity: edPublic(identity) } }], prod: { contexts: join(root, 'contexts'), evidenceSettings: settings } };
  await mkdir(config.prod.contexts); await mkdir(join(config.data, 'static', 'blocks'), { recursive: true });
  const value = { label: 'named', payload: 'a'.repeat(2200) };
  await store.put('types', 'named', value);
  const publisher = evidencePublisher({ config, store, reads: { trac: async () => stamp }, secret, now: () => now }); t.after(() => publisher.close());
  let calls = [], tamper;
  const source = { request: async (_path, { body }) => {
    const envelope = await publisher(body); calls.push({ op: body.query.op, bytes: JSON.stringify(envelope).length, rows: envelope.payload.result?.rows?.length ?? 0 });
    if (tamper) { tamper(envelope.payload); envelope.signature = signEvidence(envelope.payload, secret); }
    return envelope;
  } };
  const options = { config: { directory: join(root, 'signer'), network: 'test', epoch: 1, member: 'one', settings }, identity: Buffer.from(identity), gateway: edPublic(secret), source,
    clock: async () => ({ tip: stamp.tip, tipHash: stamp.tipHash }), stamp: async () => stamp, now: () => now };
  const reader = await EvidenceStore.open(options); t.after(() => reader.close());
  await reader.refresh(); assert.deepEqual(await reader.get('types', 'named'), value);
  const small = calls.filter(c => c.op === 'get').at(-1);
  for (let start = 0; start < 5000; start += 100) await store.transact(Array.from({ length: 100 }, (_, i) => ({ space: 'types', id: 'old-' + String(start + i).padStart(8, '0'), value: { ...value, label: String(start + i) } })));
  assert.ok(store.db.prepare("SELECT sum(length(value)) AS n FROM records WHERE space='types'").get().n > 8_000_000);
  await store.put('types', 'after-snapshot', { changed: true });
  assert.equal(await reader.get('types', 'after-snapshot'), null, 'old root and its absence proof remain pinned while the writer advances');
  await reader.refresh(); calls = [];
  assert.deepEqual(await reader.get('types', 'named'), value);
  const large = calls.at(-1); assert.equal(large.rows, small.rows); assert.equal(calls.length, 1); assert.ok(large.bytes < small.bytes + 10000, 'only logarithmic proof growth');
  assert.deepEqual(await reader.get('types', 'after-snapshot'), { changed: true });
  let after = '', count = 0;
  // Traverse several boundaries, then seek near the final page directly.
  for (let i = 0; i < 4; i++) { const page = await reader.list('types', { after, limit: 8 }); count += page.length; after = page.at(-1).id; }
  assert.equal(count, 32); assert.equal((await reader.list('types', { after: 'old-00004998', limit: 8 })).length, 1);
  tamper = p => { if (p.query.op === 'get') p.result.rows[0].value.label = 'forged'; };
  await assert.rejects(reader.get('types', 'old-00004999'), /proof_rows/); tamper = null;
  tamper = p => { if (p.query.op === 'page') p.result.rows.splice(1, 1); };
  await assert.rejects(reader.list('types', { after: 'old-00000200', limit: 8 }), /proof_rows|proof_gap/); tamper = null;
  const archive = Buffer.alloc(100000, 123), digest = hash(archive), path = '/blocks/audit.bin';
  await writeFile(join(config.data, 'static', 'blocks', 'audit.bin'), archive);
  assert.deepEqual(await reader.archive(path, digest), archive);
  await reader.close();
  const restarted = await EvidenceStore.open({ ...options, identity: Buffer.from(identity) }); t.after(() => restarted.close());
  await restarted.refresh(); calls = [];
  assert.deepEqual(await restarted.archive(path, digest), archive); assert.equal(calls.length, 0, 'immutable hash cache survives restart');
  now += 60001; await assert.rejects(restarted.get('types', 'named'), /missing_or_stale/);
  const old = { version: 1, network: 'test', epoch: 1, member: 'one', nonce: '11'.repeat(32), time: now };
  await assert.rejects(publisher({ ...old, signature: signEvidence(old, identity) }), /evidence_version/);
  t.diagnostic(JSON.stringify({ historicalRows: store.count('types'), historicalBytes: store.db.prepare("SELECT sum(length(value)) AS n FROM records WHERE space='types'").get().n, smallRequestBytes: small.bytes, largeRequestBytes: large.bytes, recordsPerGet: large.rows }));
});

test('legacy reader storage requires explicit migration and resumes with byte-identical context data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dmw-reader-migration-')), data = join(root, 'data'), contexts = join(root, 'contexts');
  await mkdir(contexts);
  let store = await Store.open(data);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  await store.put('types', 'one', { legacy: true });
  // Reproduce a pre-v2 store, without mutating the original source record.
  store.db.exec('DELETE FROM evidence_progress'); await store.close();
  store = await Store.open(data); assert.equal(store.evidenceReady, false);
  const identity = Buffer.alloc(32, 4), secret = Buffer.alloc(32, 5), config = { network: 'test', epoch: 1, data,
    committee: [{ id: 'one', peer: { identity: edPublic(identity) } }], prod: { contexts } };
  const publisher = evidencePublisher({ config, store, reads: { trac: async () => ({}) }, secret });
  const challenge = { version: 2, network: 'test', epoch: 1, member: 'one', nonce: 'ff'.repeat(32), time: Date.now(), query: { op: 'open' } };
  await assert.rejects(publisher({ ...challenge, signature: signEvidence(challenge, identity) }), /evidence_index_required/);
  publisher.close(); await store.close();
  const bytes = Buffer.from('{"old":"unchanged", "spacing": true}\n'); await writeFile(join(contexts, '1.json'), bytes);
  await migrateReaderStorage({ data, contexts, network: 'test' });
  store = await Store.open(data);
  assert.equal(store.evidenceReady, true); assert.deepEqual(store.get('types', 'one'), { legacy: true });
  assert.deepEqual(store.get('evidenceContexts', '1'), { path: hash(bytes) + '.json', hash: hash(bytes) });
  const before = store.evidenceIndex.root(); await store.close();
  await migrateReaderStorage({ data, contexts, network: 'test' });
  store = await Store.open(data); assert.equal(store.evidenceIndex.root(), before, 'migration is idempotent');
});


test('flat range proofs stay canonical at history depth and reject gaps, aliases and cycles', () => {
  const db = new DatabaseSync(':memory:'), index = new AuthenticatedIndex(db);
  try {
    for (let i = 0; i < 20000; i++) index.set(String(i).padStart(8, '0'), hash(String(i)));
    const proof = index.proof('00012345', '00012345', 256);
    const payload = { payload: { result: { rows: [], proof } } };
    assert.doesNotThrow(() => rules.stableJSON(payload));
    assert.deepEqual(verifyRange(index.root(), '00012345', '00012345', proof, 256), [['00012345', hash('12345')]]);
    const absent = index.proof('00012345x', '00012345x', 256);
    assert.deepEqual(verifyRange(index.root(), '00012345x', '00012345x', absent, 256), []);
    for (const change of [
      p => { p.nodes[p.root][2] = p.root; },
      p => { p.nodes.push(p.nodes[0]); },
      p => { p.nodes[p.root][2] = hash('concealed'); },
      p => { p.nodes[0][1] = hash('replacement'); }
    ]) {
      const forged = structuredClone(proof); change(forged);
      assert.throws(() => verifyRange(index.root(), '00012345', '00012345', forged, 256), /evidence_proof/);
    }
  } finally { db.close(); }
});

test('snapshot sequences bound replay state independently of streamed reads, including restart and skew', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dmw-sequence-evidence-')), store = await Store.open(join(root, 'gateway'));
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const secret = Buffer.alloc(32, 21), identity = Buffer.alloc(32, 22), stamp = { tip: 10, tipHash: hash('tip') };
  let now = 10000;
  const settings = { maxChallenges: 2, maxAgeMs: 100, clockSkewMs: 20, cacheEntries: 1 };
  const config = { network: 'test', epoch: 0, data: store.directory, committee: [{ id: 'one', peer: { identity: edPublic(identity) } }], prod: { contexts: root, evidenceSettings: settings } };
  const publisher = evidencePublisher({ config, store, reads: { trac: async () => stamp }, secret, now: () => now }); t.after(() => publisher.close());
  let previous;
  const options = { config: { directory: join(root, 'reader'), network: 'test', epoch: 0, member: 'one', settings },
    identity: Buffer.from(identity), gateway: edPublic(secret), clock: async () => stamp, stamp: async () => stamp, now: () => now,
    source: { request: async (_, { body }) => { previous = structuredClone(body); return publisher(body); } } };
  const reader = await EvidenceStore.open(options); t.after(() => reader.close());
  await reader.refresh(); const firstOpen = previous;
  for (let i = 0; i < 30; i++) assert.equal(await reader.get('types', String(i)), null);
  const read = previous; await assert.rejects(publisher(read), /evidence_replay/);
  await reader.refresh(); await assert.rejects(publisher(read), /evidence_snapshot_expired/);
  const capacity = { ...firstOpen, nonce: hash('new-open') }; delete capacity.signature;
  await assert.rejects(publisher({ ...capacity, signature: signEvidence(capacity, identity) }), e => e.message === 'evidence_challenge_capacity' && e.status === 429);
  await assert.rejects(publisher(firstOpen), /evidence_replay/);
  // Capacity does not evict a live challenge. After expiry a fresh open works.
  now += 101; await reader.refresh(); assert.equal(await reader.get('types', 'after-expiry'), null);
  now += 101;
  const future = { ...capacity, nonce: hash('future'), time: now + settings.clockSkewMs };
  await publisher({ ...future, signature: signEvidence(future, identity) });
  now += settings.maxAgeMs + 1;
  await assert.rejects(publisher({ ...future, signature: signEvidence(future, identity) }), /evidence_replay/);
});
