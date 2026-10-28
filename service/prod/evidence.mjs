import { MigrationRows, migrationCommitment, migrationPages, migrationPageRoot, EMPTY_MIGRATION_ROOT, createMigrationRows, appendMigrationPage, compareRowKey } from '../src/migration-pages.mjs';
import { createPrivateKey, createPublicKey, sign, verify, randomBytes } from 'node:crypto';
import { open, mkdir, readFile, mkdtemp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { rules } from '../src/rules.mjs';
import { check, atomicWrite, hash, serial } from '../src/util.mjs';
import { AuthenticatedIndex, evidenceKey, verifyRange } from '../src/authenticated-index.mjs';
import { projectEvidence, exportableSpace, noSecrets } from '../src/evidence-projection.mjs';
import { endpoint, evidenceSnapshotPolicy } from './config.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpSource } from './http.mjs';
import { pendingArtifactInventory } from '../src/pending-artifacts.mjs';
import { decodeNodeHints } from '../../rules/src/node-evidence.js';
export { projectEvidence } from '../src/evidence-projection.mjs';
export const EVIDENCE_VERSION = 2;
export const EVIDENCE_DEFAULTS = Object.freeze({ pageRows: 128, pageBytes: 2_000_000, chunkBytes: 256_000,
  migrationPageRows: 1024, migrationPageBytes: 1_000_000, migrationLeaseMs: 300_000, migrationRequestMs: 300_000, requestBytes: 16_384, maxAgeMs: 30_000, clockSkewMs: 1000, maxSnapshots: 16, maxChallenges: 4096, maxProofNodes: 8192,
  maxDepth: 100, maxIdBytes: 1024, cacheEntries: 256, nodeCacheEntries: 65536, prefetchCacheEntries: 16384,
  nodePrefetchAncestors: 1, nodeHintEntries: 65536, maxObjectBytes: 8_000_000, requestsPerSecond: 100 });
// Kept as a source-compatible name; this bounds ONE RESPONSE, never history.
export const EVIDENCE_LIMIT = EVIDENCE_DEFAULTS.pageBytes;
export function evidenceSettings(settings = {}) {
  check(Object.keys(settings).every(k => Object.hasOwn(EVIDENCE_DEFAULTS, k)), 'evidence_settings');
  const out = { ...EVIDENCE_DEFAULTS, ...settings };
  if (!Object.hasOwn(settings, 'migrationPageBytes')) out.migrationPageBytes = Math.min(out.migrationPageBytes, out.pageBytes - 8193);
  check(Object.values(out).every(v => Number.isSafeInteger(v) && v > 0) && out.chunkBytes * 2 < out.pageBytes && out.migrationPageBytes + 8192 < out.pageBytes && out.migrationLeaseMs <= 0x7fffffff && out.migrationRequestMs <= 0x7fffffff, 'evidence_settings'); return out;
}
const text = value => rules.stableJSON(value);
const publicKey = key => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key, 'hex')]), format: 'der', type: 'spki' });
export const signEvidence = (value, secret) => sign(null, Buffer.from(text(value)), createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secret)]), format: 'der', type: 'pkcs8' })).toString('hex');
export function verifyEvidence(value, signature, key) {
  try { return /^[0-9a-f]{128}$/.test(signature) && verify(null, Buffer.from(text(value)), publicKey(key), Buffer.from(signature, 'hex')); } catch { return false; }
}

function keyCheck(space, id, settings) {
  check(exportableSpace(space) && typeof id === 'string' && Buffer.byteLength(id) <= settings.maxIdBytes, 'evidence_key');
}
function filePath(root, path) {
  check(typeof path === 'string' && /^(blocks\/[a-zA-Z0-9._-]+\.bin|[0-9a-f]{64}\.json)$/.test(path), 'evidence_path');
  const filename = resolve(root, path); check(filename.startsWith(resolve(root) + '/'), 'evidence_path'); return filename;
}
export function evidencePublisher({ config, store, reads, secret, now = Date.now }) {
  const settings = evidenceSettings(config.prod?.evidenceSettings), gate = serial(), used = new Map(), sessions = new Map();
  const { retries, backoffMs } = evidenceSnapshotPolicy(config.prod?.evidenceSnapshot);
  const drop = id => { const s = sessions.get(id); if (s) { clearTimeout(s.timer); s.db.exec('ROLLBACK'); s.db.close(); sessions.delete(id); } };
  const publish = request => gate(async () => {
    const { signature, ...challenge } = request;
    check(Object.keys(challenge).sort().join(',') === 'epoch,member,network,nonce,query,time,version' && challenge.version === EVIDENCE_VERSION && challenge.network === config.network && challenge.epoch === config.epoch, 'evidence_version');
    const member = config.committee.find(m => m.id === challenge.member);
    check(member && verifyEvidence(challenge, signature, member.peer.identity), 'evidence_authentication');
    check(/^[0-9a-f]{64}$/.test(challenge.nonce) && Number.isSafeInteger(challenge.time) && challenge.time <= now() + settings.clockSkewMs && now() - challenge.time <= settings.maxAgeMs, 'evidence_challenge');
    for (const [nonce, expiry] of used) if (expiry < now()) used.delete(nonce);
    for (const [id, s] of sessions) if (s.expiresAt <= now()) drop(id);
    const q = challenge.query; check(q && typeof q === 'object', 'evidence_query');
    if (q.op !== 'open' && Object.hasOwn(q, 'sequence')) {
      const session = sessions.get(q.snapshot);
      check(session && session.member === member.id && session.expiresAt > now(), 'evidence_snapshot_expired');
      check(typeof q.sequence === 'string' && /^(0|[1-9][0-9]*)$/.test(q.sequence) &&
        BigInt(q.sequence) > BigInt(session.sequence ?? '0'), 'evidence_replay');
      // One monotone replay marker per authenticated snapshot, rather than
      // one retained nonce per tree node. Consume before executing the query.
      session.sequence = q.sequence;
    } else {
      check(!used.has(challenge.nonce), 'evidence_replay');
      check(used.size < settings.maxChallenges, 'evidence_challenge_capacity', 429);
      // Include the challenge's clock skew in its replay-protection lifetime.
      used.set(challenge.nonce, challenge.time + settings.maxAgeMs);
    }
    let result;
    if (q.op === 'open' || q.op === 'migration-open') {
      check(Object.keys(q).join(',') === 'op' && store.evidenceReady, 'evidence_index_required');
      for (const [id, s] of sessions) if (s.member === member.id) drop(id);
      check(sessions.size < settings.maxSnapshots, 'evidence_capacity');
      for (let attempt = 0; ; attempt++) {
      check(now() - challenge.time <= settings.maxAgeMs, 'evidence_challenge');
      let db;
      try {
        const stamp = await reads.trac('stamp'); db = new DatabaseSync(join(store.directory, 'index.sqlite'));
        const index = new AuthenticatedIndex(db);
        db.exec('PRAGMA query_only=ON; BEGIN');
        const savedRevision = db.prepare('SELECT sequence FROM journal_progress WHERE id=1').get()?.sequence ?? db.prepare('SELECT sequence FROM progress WHERE id=1').get().sequence;
        const revision = config.v2 ? rules.decimalV2(savedRevision) : savedRevision, root = index.root();
        check(text(stamp) === text(await reads.trac('stamp')), 'evidence_snapshot_changed');
        const id = randomBytes(32).toString('hex'), observedAt = now();
        result = { id, root, revision, stamp, observedAt, expiresAt: observedAt + settings.maxAgeMs };
        if (q.op === 'migration-open') {
          // Explicit offline migration only: normal requests keep using the
          // bounded projection index. This root commits EVERY logical row.
          const rows = new MigrationRows(db);
          const { checkPublic } = await import('../../deploy/rehearsal/export.mjs');
          function* checked() { for (const row of rows) { checkPublic(row); yield row; } }
          const commitment = migrationCommitment(checked(), { pageRows: settings.migrationPageRows, pageBytes: settings.migrationPageBytes });
          result.expiresAt = now() + settings.migrationLeaseMs;
          result.migration = { ...commitment, artifacts: await pendingArtifactInventory(store.directory, rows) };
        }
        const timer = setTimeout(() => drop(id), result.expiresAt - now()); timer.unref();
        sessions.set(id, { ...result, db, index, member: member.id, timer });
        break;
      } catch (e) {
        db?.close();
        if (!['evidence_snapshot_changed', 'trac_snapshot_changed'].includes(e.message) || attempt >= retries) throw e;
        if (backoffMs) await delay(backoffMs);
      }
      }
    } else {
      const s = sessions.get(q.snapshot); check(s && s.member === member.id && s.expiresAt > now(), 'evidence_snapshot_expired');
      if (q.op === 'migration-page') {
        check(s.migration && Array.isArray(q.after) && q.after.length === 2 && q.after.every(v => typeof v === 'string') &&
          q.limit === s.migration.pageRows, 'evidence_migration_page');
        const query = s.db.prepare('SELECT space,id,value FROM records WHERE (space,id) > (?,?) ORDER BY space,id LIMIT ?');
        function* values() { for (const row of query.iterate(...q.after, q.limit)) yield [row.space, row.id, JSON.parse(row.value)]; }
        const rows = migrationPages(values(), { pageRows: s.migration.pageRows, pageBytes: s.migration.pageBytes }).next().value ?? [];
        s.expiresAt = now() + settings.migrationLeaseMs;
        clearTimeout(s.timer); s.timer = setTimeout(() => drop(q.snapshot), settings.migrationLeaseMs); s.timer.unref();
        result = { rows };
      } else if (q.op === 'get' || q.op === 'page') {
        keyCheck(q.space, q.op === 'get' ? q.id : q.after, settings);
        const get = q.op === 'get';
        check(get || Number.isSafeInteger(q.limit) && q.limit > 0 && q.limit <= settings.pageRows, 'evidence_page');
        const rows = get ? s.db.prepare('SELECT id,value FROM evidence_values WHERE space=? AND id=?').all(q.space, q.id)
          : s.db.prepare('SELECT id,value FROM evidence_values WHERE space=? AND id>? ORDER BY id LIMIT ?').all(q.space, q.after, q.limit);
        const lower = evidenceKey(q.space, get ? q.id : q.after) + (get ? '' : '0');
        const upper = get ? lower : rows.length === q.limit ? evidenceKey(q.space, rows.at(-1).id) : Buffer.from(q.space).toString('hex') + '/g';
        result = { rows: rows.map(r => ({ id: r.id, value: JSON.parse(r.value) })), proof: s.index.proof(lower, upper, settings.maxProofNodes) };
      } else if (q.op === 'index-nodes') {
        check(['claimNodes', 'namedNodes'].includes(q.space) && /^[0-9a-f]{64}$/.test(q.id), 'evidence_index_node');
        const query = s.db.prepare('SELECT value FROM records WHERE space=? AND id=?');
        const ancestors = q.ancestors ?? [];
        check(Array.isArray(ancestors) && ancestors.length <= settings.nodePrefetchAncestors && ancestors.every(id => /^[0-9a-f]{64}$/.test(id)), 'evidence_index_node');
        const ids = q.ids ?? [];
        check(Array.isArray(ids) && ids.length <= settings.pageRows && ids.every(id => /^[0-9a-f]{64}$/.test(id)), 'evidence_index_node');
        const queue = [q.id, ...ids, ...ancestors], visited = new Set(), nodes = []; let bytes = 2;
        // Prefetch a bounded connected neighborhood. Child references and
        // content hashes keep this flat; no lifetime-tree traversal or index.
        for (let i = 0; i < queue.length && nodes.length < settings.pageRows; i++) {
          const id = queue[i]; if (visited.has(id)) continue; visited.add(id);
          const raw = query.get(q.space, id); if (!raw) continue;
          const row = JSON.parse(raw.value);
          check(rules.hashObject(['dmw-stored-index-v2', row]) === id, 'evidence_index_node_hash');
          const size = Buffer.byteLength(text([id, row])) + (nodes.length ? 1 : 0);
          if (bytes + size > settings.chunkBytes) {
            check(nodes.length > 0, 'evidence_index_node_bytes'); break;
          }
          nodes.push([id, row]); bytes += size;
          for (const child of Object.values(row.children ?? {})) {
            const next = typeof child === 'string' ? child : child.storage;
            check(/^[0-9a-f]{64}$/.test(next), 'evidence_index_node'); queue.push(next);
          }
        }
        result = { nodes };
      } else if (['claim-node', 'named-node'].includes(q.op)) {
        // Claim paths are authenticated by the accepted notary root and each
        // content hash. Do not duplicate this lifetime tree in the mutable
        // evidence AVL, or embed an entire continuation in a context blob.
        check(/^[0-9a-f]{64}$/.test(q.id), 'evidence_claim_node');
        const row = s.db.prepare("SELECT value FROM records WHERE space=? AND id=?").get(q.op === 'claim-node' ? 'claimNodes' : 'namedNodes', q.id);
        result = row ? JSON.parse(row.value) : null;
        check(!result || rules.hashObject(['dmw-stored-index-v2', result]) === q.id, 'evidence_claim_node_hash');
      } else if (q.op === 'blob') {
        check(/^[0-9a-f]{64}$/.test(q.hash) && Number.isSafeInteger(q.offset) && q.offset >= 0 && q.offset <= settings.maxObjectBytes, 'evidence_blob');
        const context = q.path === q.hash + '.json', path = q.path.replace(/^\//, '');
        const filename = filePath(context ? config.prod.contexts : join(config.data, 'static'), path);
        const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const st = await fd.stat(); check(st.isFile() && st.size <= settings.maxObjectBytes && q.offset <= st.size, 'evidence_file_limit');
          const bytes = Buffer.alloc(Math.min(settings.chunkBytes, st.size - q.offset));
          const { bytesRead } = await fd.read(bytes, 0, bytes.length, q.offset); check(bytesRead === bytes.length, 'evidence_file_changed');
          result = { hash: q.hash, offset: q.offset, size: st.size, bytes: bytes.toString('base64') };
        } finally { await fd.close(); }
      } else if (q.op === 'close') { drop(q.snapshot); result = null; }
      else throw Error('evidence_query');
    }
    const payload = { version: EVIDENCE_VERSION, network: config.network, epoch: config.epoch, member: challenge.member, nonce: challenge.nonce, query: q, result };
    noSecrets(payload, settings.maxDepth);
    const envelope = { payload, signature: signEvidence(payload, secret) };
    check(Buffer.byteLength(JSON.stringify(envelope)) <= settings.pageBytes, 'evidence_page_bytes'); return envelope;
  });
  publish.requestBytes = settings.requestBytes;
  publish.close = () => { for (const id of sessions.keys()) drop(id); };
  return publish;
}

export class EvidenceStore {
  constructor(options) { Object.assign(this, options); this.settings = evidenceSettings(this.config.settings); this.gate = serial(); this.exchangeGate = serial(); this.sequence = 0n; this.cache = new Map(); this.nodeCache = new Map(); this.prefetchCache = new Map(); this.nodeHints = new Map(); }
  static async open(options) {
    const settings = evidenceSettings(options.config.settings);
    const source = options.source ?? new HttpSource({ ...await endpoint(options.config.endpoint), maxBytes: settings.pageBytes, retries: 0, requestsPerSecond: settings.requestsPerSecond });
    const self = new EvidenceStore({ ...options, source, now: options.now ?? Date.now });
    self.cacheDirectory = join(options.config.directory, 'evidence-cache');
    await mkdir(self.cacheDirectory, { recursive: true, mode: 0o700 }); return self;
  }
  exchange(query) { return this.exchangeGate(() => this.exchangeOne(query)); }
  async exchangeOne(query) {
    if (query.snapshot) query = { ...query, sequence: String(++this.sequence) };
    const challenge = { version: EVIDENCE_VERSION, network: this.config.network, epoch: this.config.epoch, member: this.config.member, nonce: randomBytes(32).toString('hex'), time: this.now(), query };
    const envelope = await this.source.request('/operator-evidence', { method: 'POST', body: { ...challenge, signature: signEvidence(challenge, this.identity) }, retry: false, ...(query.op.startsWith('migration-') ? { timeoutMs: this.settings.migrationRequestMs } : {}) });
    const p = envelope.payload; check(p && verifyEvidence(p, envelope.signature, this.gateway), 'evidence_signature');
    for (const key of ['version','network','epoch','member','nonce','query']) check(text(p[key]) === text(challenge[key]), 'evidence_binding');
    check(Buffer.byteLength(JSON.stringify(envelope)) <= this.settings.pageBytes, 'evidence_page_bytes'); noSecrets(p, this.settings.maxDepth);
    if (query.op === 'open') this.openEnvelope = envelope; return p.result;
  }
  refresh() { return this.gate(async () => {
    this.payload = null; this.cache.clear(); this.nodeHints.clear();
    const snapshot = await this.exchange({ op: 'open' }), now = this.now();
    check(snapshot && /^[0-9a-f]{64}$/.test(snapshot.id) && /^[0-9a-f]{64}$/.test(snapshot.root) && (Number.isSafeInteger(snapshot.revision) || typeof snapshot.revision === 'string' && /^(0|[1-9][0-9]*)$/.test(snapshot.revision)) &&
      Number.isSafeInteger(snapshot.observedAt) && snapshot.observedAt <= now + this.settings.clockSkewMs && now - snapshot.observedAt < this.settings.maxAgeMs && snapshot.expiresAt > now, 'evidence_stale');
    const clock = await this.clock(), stamp = await this.stamp();
    check(String(clock.tip) === String(snapshot.stamp.tip) && clock.tipHash === snapshot.stamp.tipHash && text(stamp) === text(snapshot.stamp), 'evidence_reorg');
    // A checkpoint is an audit trail and restart hint, never authority to reuse
    // mutable records without a new independently checked chain snapshot.
    await atomicWrite(join(this.config.directory, 'evidence-checkpoint.json'), JSON.stringify(this.openEnvelope)); this.payload = snapshot;
  }); }
  ready() { check(this.payload && this.now() < this.payload.expiresAt && this.now() - this.payload.observedAt < this.settings.maxAgeMs, 'evidence_missing_or_stale'); }
  async records(q) {
    this.ready(); const snapshot = this.payload, key = text(q);
    if (this.cache.has(key)) return structuredClone(this.cache.get(key));
    const r = await this.exchange({ ...q, snapshot: snapshot.id });
    check(this.payload === snapshot, 'evidence_snapshot_changed'); this.ready();
    check(Array.isArray(r.rows) && r.rows.length <= (q.op === 'get' ? 1 : q.limit), 'evidence_page');
    const lower = evidenceKey(q.space, q.op === 'get' ? q.id : q.after) + (q.op === 'get' ? '' : '0');
    const upper = q.op === 'get' ? lower : r.rows.length === q.limit ? evidenceKey(q.space, r.rows.at(-1).id) : Buffer.from(q.space).toString('hex') + '/g';
    const leaves = verifyRange(snapshot.root, lower, upper, r.proof, this.settings.maxProofNodes);
    const actual = r.rows.map(row => {
      keyCheck(q.space, row.id, this.settings);
      check(text(projectEvidence(q.space, row.id, row.value)) === text(row.value), 'evidence_projection');
      return [evidenceKey(q.space, row.id), hash(text(row.value))];
    });
    check(text(actual) === text(leaves), 'evidence_proof_rows');
    if (this.cache.size >= this.settings.cacheEntries) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, r.rows); return structuredClone(r.rows);
  }
  async get(space, id) { return (await this.records({ op: 'get', space, id: String(id) }))[0]?.value ?? null; }
  async migrationRows() {
    return this.gate(async () => {
      this.payload = null; this.cache.clear();
      const snapshot = await this.exchange({ op: 'migration-open' });
      let rows;
      try {
        const descriptor = snapshot?.migration;
        check(descriptor?.version === 2 && snapshot.expiresAt > this.now() && text(await this.stamp()) === text(snapshot.stamp) &&
          descriptor.pageRows <= this.settings.migrationPageRows && descriptor.pageBytes <= this.settings.migrationPageBytes, 'evidence_migration_snapshot');
        const directory = await mkdtemp(join(this.config.directory, 'migration-'));
        rows = createMigrationRows(join(directory, 'rows.sqlite'));
        let after = ['', ''], count = 0, pages = 0, root = EMPTY_MIGRATION_ROOT;
        while (count < descriptor.rows) {
          const page = await this.exchange({ op: 'migration-page', snapshot: snapshot.id, after, limit: descriptor.pageRows });
          check(Array.isArray(page.rows) && page.rows.length > 0 && page.rows.length <= descriptor.pageRows &&
            Buffer.byteLength(text(page.rows)) <= descriptor.pageBytes, 'evidence_migration_page');
          for (const row of page.rows) {
            check(Array.isArray(row) && row.length === 3 && row.slice(0, 2).every(v => typeof v === 'string') &&
              compareRowKey(row, after) > 0, 'evidence_migration_page');
            after = row.slice(0, 2);
          }
          appendMigrationPage(rows, page.rows); count += page.rows.length; pages++; root = migrationPageRoot(root, page.rows);
          check(count <= descriptor.rows, 'evidence_migration_page');
        }
        const verified = migrationCommitment(rows, { pageRows: descriptor.pageRows, pageBytes: descriptor.pageBytes });
        check(count === descriptor.rows && pages === descriptor.pages && root === descriptor.root && verified.legacyRoot === descriptor.legacyRoot &&
          text(await this.stamp()) === text(snapshot.stamp), 'evidence_migration_root');
        rows.commitment = verified; rows.db.exec('PRAGMA query_only=ON');
        (this.migrations ??= new Set()).add(rows);
        return { rows, stamp: snapshot.stamp, revision: snapshot.revision, artifacts: descriptor.artifacts };
      } catch (error) { rows?.close(); throw error; }
      finally { await this.exchange({ op: 'close', snapshot: snapshot.id }).catch(() => {}); }
    });
  }
  async list(space, { after = '', limit = this.settings.pageRows } = {}) {
    // Callers may ask for a larger working page; exchange bounded proof pages.
    check(Number.isSafeInteger(limit) && limit > 0, 'evidence_page');
    const rows = [];
    while (rows.length < limit) {
      const size = Math.min(limit - rows.length, this.settings.pageRows), page = await this.records({ op: 'page', space, after, limit: size });
      rows.push(...page); if (page.length < size) break; after = page.at(-1).id;
    }
    return rows;
  }
  async context(n) {
    const descriptor = await this.get('evidenceContexts', String(n)); check(descriptor, 'evidence_context_missing');
    const context = JSON.parse(await this.archive(descriptor.path, descriptor.hash));
    for (const input of context.inputs ?? []) {
      this.hintNodes('namedNodes', input.namedEvidence?.hints);
      this.hintNodes('claimNodes', input.claimEvidence?.hints);
    }
    return context;
  }
  hintNodes(space, values) {
    const hints = decodeNodeHints(values, 'evidence_node_hints', this.settings.nodeHintEntries - this.nodeHints.size);
    for (let index = 0; index < hints.length; index++) this.nodeHints.set(space + '/' + hints[index], { hints, index });
  }
  async claimNode(id, ancestors) {
    try { return await this.indexNode('claimNodes', id, ancestors); }
    catch (error) { if (error.message === 'evidence_index_node_hash') throw Error('evidence_claim_node_hash'); throw error; }
  }
  namedNode(id, ancestors) { return this.indexNode('namedNodes', id, ancestors); }
  rememberNode(key, row) {
    this.prefetchCache.delete(key); this.nodeCache.delete(key); this.nodeCache.set(key, row);
    if (this.nodeCache.size > this.settings.nodeCacheEntries) this.nodeCache.delete(this.nodeCache.keys().next().value);
  }
  async indexNode(space, id, ancestors = []) {
    this.ready(); check(['claimNodes', 'namedNodes'].includes(space) && /^[0-9a-f]{64}$/.test(id), 'evidence_index_node');
    const snapshot = this.payload, key = space + '/' + id;
    if (this.nodeCache.has(key)) {
      const row = this.nodeCache.get(key); this.nodeCache.delete(key); this.nodeCache.set(key, row); return structuredClone(row);
    }
    if (this.prefetchCache.has(key)) {
      const row = this.prefetchCache.get(key); this.rememberNode(key, row); return structuredClone(row);
    }
    const hint = this.nodeHints.get(key), ids = [];
    if (hint) for (let i = hint.index; i < hint.hints.length && ids.length < this.settings.pageRows; i++) {
      const hash = hint.hints[i], key = space + '/' + hash;
      if (!this.nodeCache.has(key) && !this.prefetchCache.has(key)) ids.push(hash);
    }
    const result = await this.exchange({ op: 'index-nodes', snapshot: snapshot.id, space, id, ids, ancestors: ancestors.slice(0, this.settings.nodePrefetchAncestors) });
    check(this.payload === snapshot, 'evidence_snapshot_changed'); this.ready();
    check(Array.isArray(result?.nodes) && result.nodes.length <= this.settings.pageRows &&
      Buffer.byteLength(text(result.nodes)) <= this.settings.chunkBytes, 'evidence_index_node_hash');
    const nodes = new Map(result.nodes);
    check(nodes.size === result.nodes.length && nodes.has(id), 'evidence_index_node_hash');
    for (const [hash, row] of nodes) check(rules.hashObject(['dmw-stored-index-v2', row]) === hash, 'evidence_index_node_hash');
    for (const [hash, row] of nodes) {
      const key = space + '/' + hash;
      // Speculative neighbors must not evict nodes the executor actually used.
      if (hash === id || this.nodeCache.has(key)) continue;
      this.prefetchCache.delete(key); this.prefetchCache.set(key, row);
      if (this.prefetchCache.size > this.settings.prefetchCacheEntries) this.prefetchCache.delete(this.prefetchCache.keys().next().value);
    }
    this.rememberNode(key, nodes.get(id));
    return structuredClone(nodes.get(id));
  }
  async replayNodes(space, id, ancestors, limit) {
    check(Number.isSafeInteger(limit) && limit > 0, 'evidence_replay_nodes');
    const row = await this.indexNode(space, id, ancestors), rows = [[id, row]];
    let bytes = Buffer.byteLength(text(rows));
    // Transfer already authenticated hint neighbors with the requested row.
    // The replay worker still verifies every path against its committed root.
    // Fresh reads keep the evidence lease checks; no cross-replay worker cache.
    const hint = this.nodeHints.get(space + '/' + id);
    if (hint) for (let i = hint.index + 1; i < hint.hints.length && rows.length < Math.min(limit, this.settings.pageRows); i++) {
      const hash = hint.hints[i], key = space + '/' + hash, value = this.nodeCache.get(key) ?? this.prefetchCache.get(key);
      if (!value) continue;
      const size = Buffer.byteLength(text([hash, value])) + 1;
      if (bytes + size > this.settings.chunkBytes) break;
      rows.push([hash, value]); bytes += size;
    }
    this.ready(); return rows;
  }
  async archive(path, expectedHash) {
    this.ready(); check(/^[0-9a-f]{64}$/.test(expectedHash), 'evidence_archive_hash');
    const filename = join(this.cacheDirectory, expectedHash);
    try { const bytes = await readFile(filename); check(bytes.length <= this.settings.maxObjectBytes && hash(bytes) === expectedHash, 'evidence_archive_hash'); return bytes; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parts = []; let offset = 0, size;
    do {
      const r = await this.exchange({ op: 'blob', snapshot: this.payload.id, path, hash: expectedHash, offset });
      check(r.hash === expectedHash && r.offset === offset && Number.isSafeInteger(r.size) && r.size >= offset && r.size <= this.settings.maxObjectBytes && (size === undefined || size === r.size), 'evidence_blob');
      const part = Buffer.from(r.bytes, 'base64'); size = r.size;
      check(part.length <= this.settings.chunkBytes && offset + part.length <= size && (part.length > 0 || size === 0), 'evidence_blob');
      parts.push(part); offset += part.length;
    } while (offset < size);
    const bytes = Buffer.concat(parts); check(hash(bytes) === expectedHash, 'evidence_archive_hash');
    await atomicWrite(filename, bytes); return bytes;
  }
  async close() { for (const rows of this.migrations ?? []) rows.close(); if (this.payload) await this.exchange({ op: 'close', snapshot: this.payload.id }).catch(() => {}); this.payload = null; this.identity?.fill(0); }
}
