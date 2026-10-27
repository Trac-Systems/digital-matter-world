import { DatabaseSync } from 'node:sqlite';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { check, privateDirectory, sha256 } from './check.mjs';
import { stableJSON, DISCOVERY_LIMITS } from '../../rules/src/index.js';
import { setTimeout as sleep } from 'node:timers/promises';

// One durable intent per logical action; ambiguous sends retain the exact packet.
export class Journal {
  static async open(directory, scope, { now = Date.now, intervalMs = 1000, perTip = 12 } = {}) {
    check(Number.isSafeInteger(intervalMs) && intervalMs >= 0 && Number.isSafeInteger(perTip) && perTip > 0, 'Invalid rate limits');
    const dir = await privateDirectory(directory), path = join(dir, 'journal.sqlite');
    try { const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await fd.close(); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = await lstat(path); check(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077), 'Journal must be a private regular file');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS actions (scope TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL, result TEXT, state TEXT NOT NULL, PRIMARY KEY(scope,id)); CREATE TABLE IF NOT EXISTS rates (scope TEXT PRIMARY KEY, tip INTEGER NOT NULL, count INTEGER NOT NULL, at INTEGER NOT NULL);');
    db.exec('CREATE TABLE IF NOT EXISTS action_outcomes (scope TEXT NOT NULL, id TEXT NOT NULL, outcome TEXT, settlement TEXT, PRIMARY KEY(scope,id));');
    return new Journal(db, scope, { now, intervalMs, perTip });
  }
  constructor(db, scope, options) { this.db = db; this.scope = scope; Object.assign(this, options); }
  get(id) {
    const row = this.db.prepare('SELECT * FROM actions WHERE scope=? AND id=?').get(this.scope, id);
    return row ? { ...row, body: JSON.parse(row.body), result: row.result ? JSON.parse(row.result) : null } : null;
  }
  reserve(id, intent, body) {
    const fingerprint = sha256(stableJSON(intent));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.get(id);
      if (old) { check(old.fingerprint === fingerprint, 'Conflicting action refused; use the saved intent'); this.db.exec('COMMIT'); return old; }
      // MSB content hashes use JSON property order; retain the exact packet.
      this.db.prepare('INSERT INTO actions(scope,id,fingerprint,body,state) VALUES(?,?,?,?,?)').run(this.scope, id, fingerprint, JSON.stringify(body), 'prepared');
      this.db.exec('COMMIT'); return this.get(id);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  take(tip) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const at = this.now(), old = this.db.prepare('SELECT * FROM rates WHERE scope=?').get(this.scope);
      if (old && at < old.at + this.intervalMs) throw Object.assign(Error('Local rate limit; retry later'), { retryAfterMs: old.at + this.intervalMs - at });
      const count = old?.tip === tip ? old.count + 1 : 1;
      if (count > this.perTip) throw Object.assign(Error('Local per-tip move limit reached'), { retryAfterMs: 250 });
      this.db.prepare('INSERT OR REPLACE INTO rates VALUES(?,?,?,?)').run(this.scope, tip, count, at); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async waitTurn(getHead, wait = sleep) {
    for (;;) {
      const head = await getHead();
      try { this.take(head.tip.height); return head; }
      catch (error) { if (error.retryAfterMs === undefined) throw error; await wait(error.retryAfterMs); }
    }
  }
  finishTurn() {
    // Disk writes and submission can outlast the reservation interval. Keep
    // the next send spaced from this completed attempt, including failures.
    if (this.intervalMs > 0) this.db.prepare('UPDATE rates SET at=MAX(at,?) WHERE scope=?').run(this.now(), this.scope);
  }
  mark(id, state, result = null) {
    check(['sending', 'unknown', 'received', 'submitted', 'accepted', 'rejected'].includes(state), 'Invalid journal state');
    this.db.prepare('UPDATE actions SET state=?,result=? WHERE scope=? AND id=?').run(state, result === null ? null : stableJSON(result), this.scope, id);
  }
  evidence(id) {
    const row = this.db.prepare('SELECT outcome,settlement FROM action_outcomes WHERE scope=? AND id=?').get(this.scope, id);
    return { outcome: row?.outcome ? JSON.parse(row.outcome) : null, settlement: row?.settlement ? JSON.parse(row.settlement) : null };
  }
  observe(id, state, evidence) {
    check(['accepted', 'rejected'].includes(state), 'Invalid observed outcome');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE actions SET state=? WHERE scope=? AND id=?').run(state, this.scope, id);
      this.db.prepare('INSERT INTO action_outcomes(scope,id,outcome) VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET outcome=excluded.outcome').run(this.scope, id, stableJSON(evidence));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settle(id, settlement) {
    this.db.prepare('INSERT INTO action_outcomes(scope,id,settlement) VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET settlement=excluded.settlement').run(this.scope, id, stableJSON(settlement));
  }
  bitcoinChanges() {
    // Output 1 is cardinal change in our two-output commit builder. Restrict
    // this provenance to signed player plans; the source rechecks its script
    // and confirmation on Bitcoin before selecting it.
    const rows = this.db.prepare("SELECT body FROM actions WHERE scope=? AND (id GLOB 'bitcoin-pay/*' OR id GLOB 'bitcoin-mint/*' OR id GLOB 'bitcoin-deploy/*') ORDER BY rowid DESC LIMIT 16").all(this.scope);
    return rows.flatMap(row => { const { plan } = JSON.parse(row.body); return plan?.signedCommitPsbt && plan.commitHex && /^[0-9a-f]{64}$/.test(plan.commitTxid) ? [{ txid: plan.commitTxid, vout: 1 }] : []; });
  }
  recent(limit = 20) {
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'Invalid journal limit');
    return this.db.prepare('SELECT id,state FROM actions WHERE scope=? ORDER BY rowid DESC LIMIT ?').all(this.scope, limit);
  }
  hunting({ cursor, limit = 50 } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, 'Invalid hunting limit');
    const scope = sha256('hunting/' + this.scope);
    let before = Number.MAX_SAFE_INTEGER;
    if (cursor !== undefined) {
      check(typeof cursor === 'string' && cursor.length <= 512 && /^[\w-]+$/.test(cursor), 'Invalid hunting cursor');
      let anchor; try { anchor = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new Error('Invalid hunting cursor'); }
      check(anchor?.scope === scope && Number.isSafeInteger(anchor.before) && anchor.before > 0, 'Foreign or invalid hunting cursor');
      before = anchor.before;
    }
    // Select only header, claim and commitment packets, never the parent row
    // containing a discovery proposal and salt. Redact again before returning.
    const where = `a.scope=? AND (a.id GLOB 'claim/[0-9]*' OR a.id GLOB 'header/[0-9]*' OR
      (a.id GLOB 'discovery/*/commit' AND NOT EXISTS
        (SELECT 1 FROM actions r WHERE r.scope=a.scope AND r.id=substr(a.id,1,length(a.id)-6)||'reveal' AND r.state IN ('received','accepted','rejected'))))`;
    const rows = this.db.prepare(`SELECT a.rowid AS position,a.id,a.body,a.result,a.state FROM actions a WHERE ${where} AND a.rowid<? ORDER BY a.rowid DESC LIMIT ?`).all(this.scope, before, limit + 1);
    const selected = rows.slice(0, limit), items = selected.map(row => {
      const body = JSON.parse(row.body), receipt = row.result ? JSON.parse(row.result) : null;
      if (body.t === 'header') return { type: 'header', id: row.id, state: row.state, headerBlock: body.p.height, plots: [], receiptTip: receipt?.tip ?? null };
      if (body.t === 'claim') return { type: 'claim', id: row.id, state: row.state, window: body.p.window,
        closesAt: body.p.window + 2, drawAt: body.p.window + 2, settlesWhenCounted: body.p.window + 2, settlesAt: body.p.window + 2,
        plots: body.p.plots.map(p => ({ block: p.block, patterns: p.patterns })), header: !!body.p.header, headerBlock: body.p.header?.height ?? null,
        receiptTip: receipt?.tip ?? null };
      const actionId = row.id.slice(10, -7), parent = this.get(`discovery/${actionId}`), reveal = this.get(`discovery/${actionId}/reveal`);
      const witnessed = parent?.result?.receipt, tip = receipt?.tip ?? witnessed?.tip ?? null;
      return { type: 'discovery', actionId, state: row.state, sealed: true, commitment: body.p.commitment,
        receiptTip: tip, revealFrom: tip === null ? null : tip + 2, revealUntil: tip === null ? null : tip + DISCOVERY_LIMITS.lifetime,
        witnessRecorded: !!witnessed, revealState: reveal?.state ?? null };
    });
    const total = this.db.prepare(`SELECT count(*) AS n FROM actions a WHERE ${where}`).get(this.scope).n;
    return { items, total, limit, next: rows.length > limit ? Buffer.from(JSON.stringify({ scope, before: selected.at(-1).position })).toString('base64url') : null,
      sort: 'journal', order: 'desc', route: 'local:hunting' };
  }
  close() { this.db.close(); }
}
