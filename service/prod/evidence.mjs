import { createPrivateKey, createPublicKey, sign, verify, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { rules } from '../src/rules.mjs';
import { check, atomicWrite, hash, serial } from '../src/util.mjs';
import { endpoint, evidenceSnapshotPolicy } from './config.mjs';
import { HttpSource } from './http.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export const EVIDENCE_LIMIT = 8_000_000;
const MAX_ROWS = 4096, MAX_AGE = 30000;
const text = value => rules.stableJSON(value);
const publicKey = key => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key, 'hex')]), format: 'der', type: 'spki' });
export const signEvidence = (value, secret) => sign(null, Buffer.from(text(value)), createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secret)]), format: 'der', type: 'pkcs8' })).toString('hex');
export function verifyEvidence(value, signature, key) {
  try { return /^[0-9a-f]{128}$/.test(signature) && verify(null, Buffer.from(text(value)), publicKey(key), Buffer.from(signature, 'hex')); } catch { return false; }
}
const pick = (row, keys) => row === null ? null : Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
const projections = {
  mints: ['id','request','signature','receiver','payer','kind','authorization','requestedFeeQuote','quote','context','feeAuthorization','paymentId','paymentIds','paymentEvidence','creditIds','permit','mintInscription','mintLocator','admissionBatch'],
  batches: ['batch','publications'], receiptObservations: ['seal','receipts','archive'],
  linkRequests: ['id','request','sig','terms','paymentId'],
  payoutBindings: ['id','request','agentSignature','walletSignature','acceptedAt','attestations'],
  payoutTransitions: ['id','acceptedAt']
};
const plain = ['activeMints','paymentRequests','receiptCertificates','finds','findProvenance','patternProvenance','typeProvenance','types','payoutCurrent'];
const spaces = [...Object.keys(projections), ...plain, 'meta', 'ceremonies'];
// Only reader evidence is exported. Never copy a database, runtime config,
// journal, wallet, release package, pending transaction or credential file.
export function projectEvidence(space, id, row) {
  if (row === null) return null;
  if (space === 'meta') return id === 'patterns' ? row : undefined;
  if (space === 'ceremonies') return id.startsWith('mint/') ? { stage: row.stage, result: { certificate: row.result?.certificate ?? null } } : undefined;
  if (space === 'inscriptions') return undefined;
  if (projections[space]) return pick(row, projections[space]);
  check(plain.includes(space) || /^payoutHistory\/[0-9a-f]{64}\/(tap|ethereum)$/.test(space), 'evidence_space');
  return row;
}
function noSecrets(value, depth = 0) {
  check(depth < 100, 'evidence_depth');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    check(!/^(secret|secretKey|privateKey|gatewayKey|gatewaySecret|passphrase|password|journalKey|apiToken|sidecarToken|preimage|shares|keys|credentials)$/i.test(key), 'evidence_secret_field');
    noSecrets(item, depth + 1);
  }
}
async function boundedFile(root, path, limit) {
  check(typeof path === 'string' && /^(blocks\/[a-zA-Z0-9._-]+\.bin|[1-9][0-9]*\.json)$/.test(path), 'evidence_path');
  const filename = resolve(root, path); check(filename.startsWith(resolve(root) + '/'), 'evidence_path');
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await fd.stat(); check(stat.isFile() && stat.size <= limit, 'evidence_file_limit'); const bytes = Buffer.alloc(limit + 1), r = await fd.read(bytes, 0, bytes.length, 0); check(r.bytesRead <= limit, 'evidence_file_limit'); return bytes.subarray(0, r.bytesRead); }
  finally { await fd.close(); }
}
export function evidencePublisher({ config, store, reads, secret, now = Date.now }) {
  const gate = serial(), used = new Map();
  const { retries, backoffMs } = evidenceSnapshotPolicy(config.prod.evidenceSnapshot);
  return request => gate(async () => {
    const { signature, ...challenge } = request;
    check(Object.keys(challenge).sort().join(',') === 'epoch,member,network,nonce,time,version' && challenge.version === 1 && challenge.network === config.network && challenge.epoch === config.epoch, 'evidence_domain');
    const member = config.committee.find(m => m.id === challenge.member);
    check(member && verifyEvidence(challenge, signature, member.peer.identity), 'evidence_authentication');
    check(/^[0-9a-f]{64}$/.test(challenge.nonce) && Number.isSafeInteger(challenge.time) && challenge.time <= now() + 1000 && now() - challenge.time <= MAX_AGE, 'evidence_challenge');
    for (const [nonce, expiry] of used) if (expiry < now()) used.delete(nonce);
    check(!used.has(challenge.nonce) && used.size < 1024, 'evidence_replay'); used.set(challenge.nonce, now() + MAX_AGE);
    // Authentication and nonce consumption happen once. Each retry discards all
    // rows, files and context from the failed attempt; writers remain unblocked.
    for (let attempt = 0; ; attempt++) {
      check(now() - challenge.time <= MAX_AGE, 'evidence_challenge');
      try {
        const revision = store.sequence, stamp = await reads.trac('stamp'), rows = [], archives = {}, contexts = {};
        let size = 0;
        const budget = value => { size += Buffer.byteLength(JSON.stringify(value)); check(size < EVIDENCE_LIMIT - 10000, 'evidence_capacity'); };
        for (const space of spaces) {
          const page = store.list(space, { limit: MAX_ROWS }); check(page.length < MAX_ROWS, 'evidence_row_limit');
          for (const { id, value } of page) {
            const projected = projectEvidence(space, id, value); if (projected === undefined) continue;
            noSecrets(projected); const row = { space, id, value: projected }; budget(row); rows.push(row); check(rows.length < MAX_ROWS, 'evidence_row_limit');
          }
        }
        for (const row of rows.filter(r => r.space === 'payoutCurrent')) {
          const space = 'payoutHistory/' + row.id, page = store.list(space, { limit: MAX_ROWS });
          check(page.length < MAX_ROWS && rows.length + page.length < MAX_ROWS, 'evidence_row_limit');
          for (const r of page) { const entry = { space, ...r }; noSecrets(entry); budget(entry); rows.push(entry); }
        }
        for (const row of rows) {
          const files = row.space === 'batches' ? row.value.publications?.map(p => p.audit) ?? [] : row.space === 'receiptObservations' && row.value.archive ? [row.value.archive] : [];
          for (const file of files) if (!archives[file.path]) {
            const bytes = await boundedFile(join(config.data, 'static'), file.path.replace(/^\//, ''), 1500000);
            check(hash(bytes) === file.hash, 'evidence_archive_hash');
            archives[file.path] = bytes.toString('base64'); budget(archives[file.path]);
          }
        }
        const sequence = stamp.last.n + 1;
        try { const bytes = await boundedFile(config.prod.contexts, sequence + '.json', EVIDENCE_LIMIT); contexts[sequence] = JSON.parse(bytes); noSecrets(contexts[sequence]); budget(contexts[sequence]); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        const finalStamp = await reads.trac('stamp');
        // Compare both only after the last await, with no yield before signing.
        check(store.sequence === revision && text(stamp) === text(finalStamp), 'evidence_snapshot_changed');
        check(now() - challenge.time <= MAX_AGE, 'evidence_challenge');
        const payload = { version: 1, network: config.network, epoch: config.epoch, member: challenge.member, nonce: challenge.nonce, observedAt: now(), stamp, revision, rows, archives, contexts };
        return { payload, signature: signEvidence(payload, secret) };
      } catch (error) {
        if (!['evidence_snapshot_changed', 'trac_snapshot_changed'].includes(error.message) || attempt >= retries) throw error;
        if (backoffMs) await delay(backoffMs);
      }
    }
  });
}

export class EvidenceStore {
  constructor({ config, identity, gateway, source, clock, stamp, now = Date.now }) { Object.assign(this, { config, identity, gateway, source, clock, stamp, now }); this.gate = serial(); }
  static async open(options) {
    const source = options.source ?? new HttpSource({ ...await endpoint(options.config.endpoint), maxBytes: EVIDENCE_LIMIT, retries: 0, requestsPerSecond: 10 });
    return new EvidenceStore({ ...options, source });
  }
  refresh() { return this.gate(async () => {
    this.payload = null;
    const challenge = { version: 1, network: this.config.network, epoch: this.config.epoch, member: this.config.member, nonce: randomBytes(32).toString('hex'), time: this.now() };
    const envelope = await this.source.request('/operator-evidence', { method: 'POST', body: { ...challenge, signature: signEvidence(challenge, this.identity) }, retry: false });
    const p = envelope.payload;
    check(p && verifyEvidence(p, envelope.signature, this.gateway), 'evidence_signature');
    for (const key of ['version','network','epoch','member','nonce']) check(p[key] === challenge[key], 'evidence_binding');
    check(Number.isSafeInteger(p.observedAt) && p.observedAt <= this.now() + 1000 && this.now() - p.observedAt < MAX_AGE, 'evidence_stale');
    check(Array.isArray(p.rows) && p.rows.length < MAX_ROWS && Buffer.byteLength(JSON.stringify(p)) <= EVIDENCE_LIMIT, 'evidence_capacity');
    noSecrets(p);
    const clock = await this.clock(), stamp = await this.stamp();
    check(clock.tip === p.stamp.tip && clock.tipHash === p.stamp.tipHash && text(stamp) === text(p.stamp), 'evidence_reorg');
    const rows = new Map();
    for (const r of p.rows) {
      check(typeof r.id === 'string' && r.id.length <= 256 && text(projectEvidence(r.space, r.id, r.value)) === text(r.value), 'evidence_projection');
      const key = text([r.space, r.id]); check(!rows.has(key), 'evidence_duplicate'); rows.set(key, r.value);
    }
    await atomicWrite(join(this.config.directory, 'evidence.json'), JSON.stringify(envelope));
    this.rows = rows; this.payload = p;
    this.batchesByHeight = new Map();
    for (const r of p.rows.filter(r => r.space === 'batches')) {
      const list = this.batchesByHeight.get(r.value.batch.to) ?? []; list.push(r.value); this.batchesByHeight.set(r.value.batch.to, list);
    }
  }); }
  ready() { check(this.payload && this.now() - this.payload.observedAt < MAX_AGE, 'evidence_missing_or_stale'); }
  get(space, id) { this.ready(); return this.rows.get(text([space, String(id)])) ?? null; }
  list(space, { after = '', limit = 1000 } = {}) { this.ready(); check(Number.isInteger(limit) && limit > 0 && limit <= MAX_ROWS, 'evidence_page'); return this.payload.rows.filter(r => r.space === space && r.id > after).sort((a,b) => a.id < b.id ? -1 : 1).slice(0,limit).map(({id,value}) => ({id,value})); }
  batchAt(height) { this.ready(); return this.batchesByHeight.get(height) ?? []; }
  context(n) { this.ready(); const c = this.payload.contexts[n]; check(c, 'evidence_context_missing'); return c; }
  archive(path) { this.ready(); const a = this.payload.archives[path]; check(a, 'evidence_archive_missing'); return Buffer.from(a, 'base64'); }
  close() { this.payload = null; this.identity?.fill(0); }
}
