import { randomUUID, createHash } from 'node:crypto';
import { decimalV2 } from '../../rules/src/index.js';
import { linkSettings } from './link-settings.mjs';

export const linkCheck = (ok, code, status = 400) => {
  if (!ok) throw Object.assign(Error(code), { code, status });
};
const hash = value => createHash('sha256').update(value).digest('hex');
const actionId = (job, block, attempt) => 'bl-' + hash(JSON.stringify([job, block, attempt])).slice(0, 48);
export function linkBlocks(blocks, maxBlocks) {
  linkCheck(Array.isArray(blocks) && blocks.length > 0, 'invalid_blocks');
  linkCheck(blocks.length <= maxBlocks, 'too_many_blocks');
  for (const block of blocks) {
    linkCheck(typeof block === 'string' && /^(0|[1-9][0-9]*)$/.test(block), 'invalid_blocks');
    try { decimalV2(block); } catch { linkCheck(false, 'invalid_blocks'); }
  }
  return [...new Set(blocks)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
}
function page({ offset = 0, limit = 25 } = {}) {
  linkCheck(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 200, 'invalid_page_limit');
  return { offset, limit };
}

// Job progress and exact signed actions live in the same private SQLite file.
// No network operation is performed within a database transaction.
export class LinkJobs {
  constructor(journal, settings = {}) {
    this.journal = journal; this.settings = linkSettings(settings);
    journal.db.exec(`CREATE TABLE IF NOT EXISTS link_jobs (
      scope TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
      payer TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS link_job_items (
      scope TEXT NOT NULL, job TEXT NOT NULL, position INTEGER NOT NULL, block TEXT NOT NULL,
      state TEXT NOT NULL, attempt INTEGER NOT NULL, action_id TEXT NOT NULL, request_id TEXT,
      reason TEXT, updated_at TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,job,position));
      CREATE INDEX IF NOT EXISTS link_job_active ON link_job_items(scope,state);
      CREATE TABLE IF NOT EXISTS link_job_worker (scope TEXT PRIMARY KEY, pid INTEGER NOT NULL, instance TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS link_job_backoff (scope TEXT NOT NULL, kind TEXT NOT NULL, until_ms INTEGER NOT NULL, PRIMARY KEY(scope,kind));`);
  }
  now() { return this.journal.now(); }
  timestamp() { return new Date(this.now()).toISOString(); }
  transaction(fn) {
    this.journal.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.journal.db.exec('COMMIT'); return result; }
    catch (error) { this.journal.db.exec('ROLLBACK'); throw error; }
  }
  create({ blocks, payer }) {
    blocks = linkBlocks(blocks, this.settings.maxBlocks);
    linkCheck(typeof payer === 'string' && payer.length > 0 && payer.length <= 128, 'invalid_payer');
    const fingerprint = hash(JSON.stringify({ blocks, payer })), db = this.journal.db, scope = this.journal.scope;
    return this.transaction(() => {
      const running = db.prepare(`SELECT j.id FROM link_jobs j WHERE j.scope=? AND j.fingerprint=? AND EXISTS
        (SELECT 1 FROM link_job_items i WHERE i.scope=j.scope AND i.job=j.id AND i.state IN ('waiting','in_progress')) ORDER BY j.rowid LIMIT 1`).get(scope, fingerprint);
      if (running) return { job: this.get(running.id), existing: true };
      const id = randomUUID(), at = this.timestamp();
      db.prepare('INSERT INTO link_jobs(scope,id,fingerprint,created_at,payer) VALUES(?,?,?,?,?)').run(scope, id, fingerprint, at, payer);
      const insert = db.prepare("INSERT INTO link_job_items(scope,job,position,block,state,attempt,action_id,updated_at) VALUES(?,?,?,?,'waiting',0,?,?)");
      blocks.forEach((block, position) => insert.run(scope, id, position, block, actionId(id, block, 0), at));
      return { job: this.get(id), existing: false };
    });
  }
  record(id) {
    const row = this.journal.db.prepare('SELECT * FROM link_jobs WHERE scope=? AND id=?').get(this.journal.scope, id);
    linkCheck(row, 'link_job_not_found', 404); return row;
  }
  get(id) {
    const row = this.record(id), counts = { waiting: 0, inProgress: 0, linked: 0, failed: 0, cancelled: 0 };
    for (const item of this.journal.db.prepare('SELECT state,count(*) AS n FROM link_job_items WHERE scope=? AND job=? GROUP BY state').all(this.journal.scope, id))
      counts[item.state === 'in_progress' ? 'inProgress' : item.state] = item.n;
    return { id, createdAt: row.created_at, payer: row.payer,
      state: counts.waiting + counts.inProgress ? 'running' : row.cancelled ? 'cancelled' : 'done',
      total: Object.values(counts).reduce((n, count) => n + count, 0), counts };
  }
  list(options = {}) {
    const { offset, limit } = page({ limit: 10, ...options });
    const rows = this.journal.db.prepare('SELECT id FROM link_jobs WHERE scope=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(this.journal.scope, limit + 1, offset);
    return { jobs: rows.slice(0, limit).map(r => this.get(r.id)), next: rows.length > limit ? offset + limit : null };
  }
  detail(id, options) {
    const { offset, limit } = page(options), job = this.get(id);
    const rows = this.journal.db.prepare('SELECT * FROM link_job_items WHERE scope=? AND job=? ORDER BY position LIMIT ? OFFSET ?').all(this.journal.scope, id, limit + 1, offset);
    return { job, items: rows.slice(0, limit).map(r => ({ block: r.block, state: r.state, updatedAt: r.updated_at,
      ...(r.state === 'failed' ? { reason: r.reason } : {}), ...(r.request_id ? { requestId: r.request_id } : {}) })), next: rows.length > limit ? offset + limit : null };
  }
  cancel(id) {
    return this.transaction(() => {
      this.record(id);
      this.journal.db.prepare('UPDATE link_jobs SET cancelled=1 WHERE scope=? AND id=?').run(this.journal.scope, id);
      this.journal.db.prepare("UPDATE link_job_items SET state='cancelled',updated_at=? WHERE scope=? AND job=? AND state='waiting'").run(this.timestamp(), this.journal.scope, id);
      return { job: this.get(id) };
    });
  }
  active() {
    return this.journal.db.prepare("SELECT i.*,j.payer,j.cancelled FROM link_job_items i JOIN link_jobs j ON j.scope=i.scope AND j.id=i.job WHERE i.scope=? AND i.state IN ('waiting','in_progress') ORDER BY j.rowid,i.position").all(this.journal.scope);
  }
  delayUntil(kind) {
    return this.journal.db.prepare('SELECT until_ms FROM link_job_backoff WHERE scope=? AND kind=?').get(this.journal.scope, kind)?.until_ms ?? 0;
  }
  defer(kind, until) {
    this.journal.db.prepare('INSERT INTO link_job_backoff(scope,kind,until_ms) VALUES(?,?,?) ON CONFLICT(scope,kind) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)')
      .run(this.journal.scope, kind, until);
  }
  update(item, fields) {
    const allowed = ['state', 'attempt', 'action_id', 'request_id', 'reason', 'retry_at'];
    linkCheck(Object.keys(fields).every(k => allowed.includes(k)), 'invalid_link_update');
    return this.journal.db.prepare(`UPDATE link_job_items SET ${Object.keys(fields).map(k => k + '=?').join(',')},updated_at=? WHERE scope=? AND job=? AND position=? AND state IN ('waiting','in_progress')`)
      .run(...Object.values(fields), this.timestamp(), this.journal.scope, item.job, item.position).changes;
  }
  renew(item) {
    // Called only after a definite expiry/refusal, never after a timeout alone.
    const cancelled = this.record(item.job).cancelled, attempt = item.attempt + 1;
    this.update(item, { state: cancelled ? 'cancelled' : 'waiting', attempt, action_id: actionId(item.job, item.block, attempt), request_id: null, reason: null, retry_at: 0 });
  }
}
