import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { readIndexSchema } from './read-index-storage.mjs';
import { mkdir, open, readFile, unlink, stat, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { hash, check, serial, atomicWrite, syncDirectory } from './util.mjs';
import { AuthenticatedIndex, evidenceKey } from './authenticated-index.mjs';
import { exportableSpace, projectEvidence } from './evidence-projection.mjs';
import { rules } from './rules.mjs';
import { R3_RESOURCES } from './r3-settings.mjs';
import { projectionSchema, projectRevision, flushProjectionRevisions } from './projection-state.mjs';
import { publicProjectionSchema, projectPublicRecord, patternLedgerAsset, consumesPublicRecord, flushPublicItems } from './public-projection-index.mjs';
import { patternSymbolFillSchema, fillPatternSymbols } from './pattern-symbol-fill.mjs';
const run = promisify(execFile);
const identity = async pid => (await run('ps', ['-p', String(pid), '-o', 'lstart='])).stdout.trim();
export const STORE_DEFAULTS = Object.freeze({ queueLimit: 4096, groupSize: 128, groupDelay: 3, pageLimit: 4096, defaultPageRows: 100, maxFrameBytes: 4000000, checkpointBytes: 2000000, cacheKiB: 4096 });
// The fsynced journal is the acknowledgement boundary. SQLite is a bounded-cache
// index of both live records and cold history, never a growing in-memory pool.
export class Store {
  static async open(directory, options = {}) {
    const store = new Store(directory, options);
    try { await store.init(); return store; } catch (e) { await store.close().catch(() => {}); throw e; }
  }
  constructor(directory, options = {}) {
    const settings = { ...R3_RESOURCES, ...STORE_DEFAULTS, ...options };
    check(Object.keys(options).every(k => Object.hasOwn(R3_RESOURCES, k) || Object.hasOwn(STORE_DEFAULTS, k)) && Object.entries(settings).every(([k, n]) => Number.isSafeInteger(n) && n >= (k === 'groupDelay' ? 0 : 1)), 'store_settings');
    for (const [canonical, alias] of [['journalFrameBytes', 'maxFrameBytes'], ['storePageRows', 'pageLimit'], ['sqliteCacheKiB', 'cacheKiB']]) {
      check(options[canonical] === undefined || options[alias] === undefined || options[canonical] === options[alias], 'store_setting_conflict');
      settings[alias] = settings[canonical] = options[canonical] ?? options[alias] ?? settings[canonical];
    }
    Object.assign(this, settings, { directory }); this.queue = []; this.gate = serial();
    check(this.journalFrameBytes > 512 && this.journalFrameBytes <= 0xffffffff && this.journalGroupBytes >= this.journalFrameBytes + 36, 'journal_settings');
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.directory, 'writer.lock');
    const guard = join(this.directory, 'writer.acquire');
    try { await mkdir(guard, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw Error('store_acquisition_recovery'); throw e; }
    try {
      try { this.lock = await open(this.lockPath, 'wx', 0o600); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const old = JSON.parse(await readFile(this.lockPath, 'utf8')), pid = typeof old === 'number' ? old : old.pid;
        check(Number.isSafeInteger(pid) && pid > 1, 'store_lock_invalid', 503);
        let alive = true; try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
        check(!alive || typeof old.identity === 'string' && old.identity !== await identity(pid), 'store_in_use', 503);
        await unlink(this.lockPath); this.lock = await open(this.lockPath, 'wx', 0o600);
      }
      this.lockIdentity = { pid: process.pid, identity: await identity(process.pid), token: randomUUID() };
      await this.lock.writeFile(JSON.stringify(this.lockIdentity)); await this.lock.sync();
    } finally { await rmdir(guard); }
    this.db = new DatabaseSync(join(this.directory, 'index.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; CREATE TABLE IF NOT EXISTS records (space TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(space,id)) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL); INSERT OR IGNORE INTO progress VALUES(1,0)');
    readIndexSchema(this.db);
    projectionSchema(this.db);
    publicProjectionSchema(this.db);
    patternSymbolFillSchema(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS staged_transactions (tx TEXT NOT NULL,part INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(tx,part)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS record_counts (space TEXT PRIMARY KEY,n INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS record_insert_count AFTER INSERT ON records BEGIN INSERT INTO record_counts VALUES(NEW.space,1) ON CONFLICT(space) DO UPDATE SET n=n+1; END;
      CREATE TRIGGER IF NOT EXISTS record_delete_count AFTER DELETE ON records BEGIN UPDATE record_counts SET n=n-1 WHERE space=OLD.space; END;`);
    if (!this.db.prepare('SELECT sequence FROM progress WHERE id=2').get()) {
      this.db.exec('BEGIN IMMEDIATE; INSERT OR REPLACE INTO record_counts SELECT space,count(*) FROM records GROUP BY space; INSERT INTO progress VALUES(2,1); COMMIT');
    }
    // Decimal materialized counts survive SQLite's signed-64 boundary. The one
    // schema migration copies only one row per space, never the record history.
    // Use SQL string carry/borrow, not an application-defined SQL function:
    // even preparing the old release's INSERT on a preactivation rollback copy
    // fails if a retained trigger references a function it does not register.
    // Keep its integer projection current while the count is representable.
    this.db.exec(`CREATE TABLE IF NOT EXISTS record_counts_decimal(space TEXT PRIMARY KEY,n TEXT NOT NULL) WITHOUT ROWID;
      INSERT OR IGNORE INTO record_counts_decimal SELECT space,CAST(n AS TEXT) FROM record_counts;
      DROP TRIGGER IF EXISTS record_insert_count; DROP TRIGGER IF EXISTS record_delete_count;
      DROP TRIGGER IF EXISTS record_insert_decimal; DROP TRIGGER IF EXISTS record_delete_decimal;
      CREATE TRIGGER record_insert_decimal AFTER INSERT ON records BEGIN
        INSERT INTO record_counts_decimal VALUES(NEW.space,'1') ON CONFLICT(space) DO UPDATE SET n=
          CASE WHEN rtrim(n,'9')='' THEN '1'||replace(n,'9','0')
          ELSE substr(rtrim(n,'9'),1,length(rtrim(n,'9'))-1)||
            CAST(CAST(substr(rtrim(n,'9'),-1) AS INTEGER)+1 AS TEXT)||
            replace(substr(n,length(rtrim(n,'9'))+1),'9','0') END;
        INSERT INTO record_counts SELECT space,CAST(n AS INTEGER) FROM record_counts_decimal WHERE space=NEW.space
          ON CONFLICT(space) DO UPDATE SET n=excluded.n;
      END;
      CREATE TRIGGER record_delete_decimal AFTER DELETE ON records BEGIN
        SELECT CASE WHEN (SELECT n FROM record_counts_decimal WHERE space=OLD.space)='0'
          THEN RAISE(ABORT,'record_count_corrupt') END;
        UPDATE record_counts_decimal SET n=coalesce(nullif(ltrim(
          substr(rtrim(n,'0'),1,length(rtrim(n,'0'))-1)||
          CAST(CAST(substr(rtrim(n,'0'),-1) AS INTEGER)-1 AS TEXT)||
          replace(substr(n,length(rtrim(n,'0'))+1),'0','9'),'0'),''),'0') WHERE space=OLD.space;
        UPDATE record_counts SET n=CAST((SELECT n FROM record_counts_decimal WHERE space=OLD.space) AS INTEGER) WHERE space=OLD.space;
      END;`);
    this.db.exec(`PRAGMA cache_size=-${this.sqliteCacheKiB}`);
    this.getStmt = this.db.prepare('SELECT value FROM records WHERE space=? AND id=?');
    this.publicProjectionActive = this.db.prepare("SELECT json_extract(value,'$.batchVersion') AS version FROM records WHERE space='meta' AND id='ruleState'").get()?.version === 2;
    this.putStmt = this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(space,id) DO UPDATE SET value=excluded.value');
    this.delStmt = this.db.prepare('DELETE FROM records WHERE space=? AND id=?');
    this.listStmt = this.db.prepare('SELECT id,value FROM records WHERE space=? AND id>? ORDER BY id LIMIT ?');
    this.countStmt = this.db.prepare('SELECT n FROM record_counts_decimal WHERE space=?');
    this.stageStmt = this.db.prepare('INSERT INTO staged_transactions VALUES(?,?,?)');
    this.stagesStmt = this.db.prepare('SELECT part,data FROM staged_transactions WHERE tx=? ORDER BY part');
    this.clearStagesStmt = this.db.prepare('DELETE FROM staged_transactions WHERE tx=?');
    this.sequence = this.db.prepare('SELECT sequence FROM progress WHERE id=1').get().sequence;
    this.db.exec('CREATE TABLE IF NOT EXISTS journal_progress(id INTEGER PRIMARY KEY,sequence TEXT NOT NULL)');
    const decimalProgress = this.db.prepare('SELECT sequence FROM journal_progress WHERE id=1').get();
    this.decimalSequence = !!decimalProgress || this.get('meta', 'ruleState')?.batchVersion === 2;
    if (this.decimalSequence) this.sequence = rules.decimalV2(decimalProgress?.sequence ?? this.sequence);
    this.evidenceIndex = new AuthenticatedIndex(this.db);
    this.db.exec('CREATE TABLE IF NOT EXISTS evidence_values(space TEXT,id TEXT,value TEXT,PRIMARY KEY(space,id)) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS evidence_progress(id INTEGER PRIMARY KEY,ready INTEGER NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO evidence_progress VALUES(1,?)').run(this.db.prepare('SELECT 1 FROM records LIMIT 1').get() ? 0 : 1);
    this.evidenceReady = this.db.prepare('SELECT ready FROM evidence_progress WHERE id=1').get().ready === 1;
    this.evidenceDeleteStmt = this.db.prepare('DELETE FROM evidence_values WHERE space=? AND id=?');
    this.evidencePutStmt = this.db.prepare('INSERT OR REPLACE INTO evidence_values VALUES(?,?,?)');
    this.decimalProgressStmt = this.db.prepare('INSERT OR REPLACE INTO journal_progress VALUES(1,?)');
    this.progressStmt = this.db.prepare('UPDATE progress SET sequence=? WHERE id=1');
    // Reserve old symbols before pending journal discoveries can claim them.
    // Startup holds the exclusive writer lock; each fill page commits its own
    // progress and yields, and subsequent opens check only the completion key.
    await fillPatternSymbols(this);
    this.path = join(this.directory, 'pending.log'); this.fd = await open(this.path, 'a+', 0o600);
    const size = (await this.fd.stat()).size; let offset = 0, previous = null;
    const header = Buffer.alloc(36);
    while (offset < size) {
      if (size - offset < 36) break;
      await this.fd.read(header, 0, 36, offset); const n = header.readUInt32BE(0);
      check(n > 0 && n <= this.journalFrameBytes, 'journal_frame_corrupt', 503);
      if (size - offset - 36 < n) break;
      const body = Buffer.alloc(n); await this.fd.read(body, 0, n, offset + 36);
      check(hash(body) === header.subarray(4).toString('hex'), 'journal_checksum', 503);
      const row = JSON.parse(body); rules.decimalV2(row.sequence);
      check(previous === null || rules.decimalV2(row.sequence) === rules.nextUint(rules.decimalV2(previous)), 'journal_sequence', 503);
      previous = row.sequence;
      if (rules.compareUint(rules.decimalV2(row.sequence), rules.decimalV2(this.sequence)) > 0) { check(rules.decimalV2(row.sequence) === rules.nextUint(rules.decimalV2(this.sequence)), 'journal_gap', 503); this.apply([row]); }
      offset += 36 + n;
    }
    if (offset !== size) { await this.fd.truncate(offset); await this.fd.sync(); }
    this.journalBytes = offset;
    // A transaction without its durable commit marker was never acknowledged.
    this.db.exec('DELETE FROM staged_transactions');
    await syncDirectory(this.directory);
    // Finds of imported v1 patterns (ledger asset p0) were left out of the public index before
    // it accepted them. Index the ones already stored, once.
    this.db.exec('CREATE TABLE IF NOT EXISTS public_projection_fixes(name TEXT PRIMARY KEY) WITHOUT ROWID');
    if (this.publicProjectionActive && !this.db.prepare("SELECT 1 FROM public_projection_fixes WHERE name='legacy-pattern-finds'").get()) {
      const rows = this.db.prepare("SELECT id,value FROM records WHERE space='finds'").all().map(r => ({ id: r.id, value: JSON.parse(r.value) }))
        .filter(r => patternLedgerAsset(r.value.asset) && !r.value.asset.startsWith('p2:'));
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of rows) projectPublicRecord(this, { space: 'finds', id: r.id, value: r.value }, null, { rebuild: true });
        this.db.exec("INSERT INTO public_projection_fixes VALUES('legacy-pattern-finds'); COMMIT");
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    if (this.publicProjectionActive && !this.db.prepare("SELECT 1 FROM public_projection_fixes WHERE name='public-mint-request-privacy'").get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of this.db.prepare("SELECT id,value FROM records WHERE space='mints'").iterate()) {
          const value = JSON.parse(r.value);
          if (value.publicMint) projectPublicRecord(this, { space: 'mints', id: r.id, value }, null, { rebuild: true });
        }
        this.db.exec("INSERT INTO public_projection_fixes VALUES('public-mint-request-privacy'); COMMIT");
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    // Compound sort keys written before v2 tiers ({ value, expression }) and the rank sort existed.
    if (this.publicProjectionActive && !this.db.prepare("SELECT 1 FROM public_projection_fixes WHERE name='compound-v2-sorts'").get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of this.db.prepare("SELECT id,value FROM records WHERE space='catalogTypes'").iterate()) {
          projectPublicRecord(this, { space: 'catalogTypes', id: r.id, value: JSON.parse(r.value) }, null, { rebuild: true });
        }
        this.db.exec("INSERT INTO public_projection_fixes VALUES('compound-v2-sorts'); COMMIT");
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  get(space, id) { const row = this.getStmt.get(space, String(id)); return row ? JSON.parse(row.value) : null; }
  list(space, { after = '', limit = this.defaultPageRows } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= this.storePageRows, 'page_limit');
    return this.listStmt.all(space, after, limit).map(row => ({ id: row.id, value: JSON.parse(row.value) }));
  }
  countUint(space) { return rules.uintV2(this.countStmt.get(space)?.n ?? '0'); }
  hasRows(space) { return this.countUint(space) !== '0'; }
  count(space) { return rules.safeNumberV2(this.countUint(space)); }
  applyOperation(op) {
    if (op.space === 'meta' && op.id === 'ruleState') this.publicProjectionActive = op.value?.batchVersion === 2;
    if (this.publicProjectionActive) {
      projectRevision(this, op);
      if (consumesPublicRecord(op.space)) op = projectPublicRecord(this, op, this.get(op.space, op.id));
    }
    if (this.evidenceReady) this.indexEvidence(op);
    if (op.value === undefined) this.delStmt.run(op.space, String(op.id));
    else this.putStmt.run(op.space, String(op.id), JSON.stringify(op.value));
  }
  apply(rows) {
    const previousProjection = this.publicProjectionActive;
    this.db.exec('BEGIN IMMEDIATE');
    this.projectionRevisions = new Map(); this.projectionItems = new Map();
    try {
      for (const row of rows) {
        if (row.stage) this.stageStmt.run(row.stage.tx, row.stage.part, row.stage.data);
        else if (row.commit) {
          let part = 0, text = '', root = '', count = 0;
          for (const chunk of this.stagesStmt.iterate(row.commit.tx)) {
            check(chunk.part === part++, 'journal_transaction_gap', 503);
            text += chunk.data;
            let end;
            while ((end = text.indexOf('\n')) >= 0) {
              const line = text.slice(0, end); text = text.slice(end + 1);
              root = hash(root + line); count++; this.applyOperation(JSON.parse(line));
            }
          }
          check(!text && part === row.commit.parts && count === row.commit.count && root === row.commit.root, 'journal_transaction_commit', 503);
          this.clearStagesStmt.run(row.commit.tx);
        } else for (const op of row.operations) this.applyOperation(op);
      }
      flushPublicItems(this); flushProjectionRevisions(this);
      const decimal = this.decimalSequence || this.publicProjectionActive;
      const sequence = decimal ? rules.decimalV2(rows.at(-1).sequence) : rows.at(-1).sequence;
      if (decimal) this.decimalProgressStmt.run(sequence);
      else this.progressStmt.run(sequence);
      this.db.exec('COMMIT'); this.sequence = sequence;
      this.decimalSequence = decimal;
    } catch (e) { this.db.exec('ROLLBACK'); this.publicProjectionActive = previousProjection; throw e; }
    finally { this.projectionRevisions = this.projectionItems = null; }
  }
  indexEvidence({ space, id, value }) {
    id = String(id);
    if (!exportableSpace(space)) return;
    const projected = projectEvidence(space, id, value ?? null), key = evidenceKey(space, id);
    if (projected == null) {
      this.evidenceDeleteStmt.run(space, id);
      this.evidenceIndex.set(key, null);
    } else {
      const text = canonicalEvidenceJSON(projected);
      this.evidencePutStmt.run(space, id, text);
      this.evidenceIndex.set(key, hash(text));
    }
    // Legacy catalogs are still committed as arrays. Publish a point index so
    // a mint reader never downloads that array to find one registered pattern.
    if (space === 'meta' && id === 'patterns') {
      const next = new Set((value ?? []).map(p => rules.patternAsset(p)));
      for (const pattern of this.get('meta', 'patterns') ?? []) if (!next.has(rules.patternAsset(pattern))) this.indexEvidence({ space: 'patternsByAsset', id: rules.patternAsset(pattern), value: null });
      for (const pattern of value ?? []) this.indexEvidence({ space: 'patternsByAsset', id: rules.patternAsset(pattern), value: pattern });
    }
    if (space === 'payoutCurrent' && id.endsWith('/tap')) {
      const previous = this.get(space, id), old = previous && this.get('payoutBindings', previous), next = value && this.get('payoutBindings', value);
      if (old) this.indexEvidence({ space: 'payoutOwners/' + hash(old.request.address), id, value: null });
      if (next) this.indexEvidence({ space: 'payoutOwners/' + hash(next.request.address), id, value });
    }
  }
  // Explicit offline migration. Never run an all-record rebuild from a read
  // request; old stores fail closed until an operator runs this once.
  rebuildEvidenceIndex() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM evidence_nodes; DELETE FROM evidence_values; UPDATE evidence_root SET key=NULL WHERE id=1');
      for (const row of this.db.prepare('SELECT space,id,value FROM records ORDER BY space,id').iterate()) this.indexEvidence({ ...row, value: JSON.parse(row.value) });
      this.db.exec('UPDATE evidence_progress SET ready=1 WHERE id=1; COMMIT'); this.evidenceReady = true;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  transact(operations) {
    if (this.closed || this.failed) return Promise.reject(Error('store_unavailable'));
    if (this.queue.length >= this.queueLimit) return Promise.reject(Object.assign(Error('store_backpressure'), { status: 503 }));
    check(Array.isArray(operations) && operations.length > 0, 'store_operations');
    // Copy at admission: callers cannot change a queued transaction's identity.
    operations = structuredClone(operations);
    return new Promise((resolve, reject) => {
      this.queue.push({ operations, resolve, reject });
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.groupDelay);
    });
  }
  // Offline plans can contain millions of writes. Freeze their identity on
  // disk before queueing, then use the same fsynced atomic journal protocol.
  // Only a bounded frame is ever materialized; no partially staged write is
  // visible without the final count/root commit marker.
  transactIterable(source) {
    if (this.closed || this.failed) return Promise.reject(Error('store_unavailable'));
    if (this.queue.length >= this.queueLimit) return Promise.reject(Object.assign(Error('store_backpressure'), { status: 503 }));
    const path = join(this.directory, 'transaction-' + randomUUID() + '.sqlite'); closeSync(openSync(path, 'wx', 0o600));
    const db = new DatabaseSync(path); let count = 0;
    const clean = () => { db.close(); unlinkSync(path); };
    try {
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA cache_size=-${this.sqliteCacheKiB}; CREATE TABLE operations(n INTEGER PRIMARY KEY,value TEXT NOT NULL); BEGIN`);
      const put = db.prepare('INSERT INTO operations VALUES(?,?)');
      for (const op of source) { const text = JSON.stringify(op); check(typeof text === 'string', 'store_operations'); put.run(count++, text); }
      check(count > 0, 'store_operations'); db.exec('COMMIT; PRAGMA query_only=ON');
    } catch (error) { clean(); throw error; }
    const operations = { length: count, *[Symbol.iterator]() { for (const row of db.prepare('SELECT value FROM operations ORDER BY n').iterate()) yield JSON.parse(row.value); } };
    return new Promise((resolve, reject) => {
      this.queue.push({ operations, resolve, reject });
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.groupDelay);
    }).finally(clean);
  }
  put(space, id, value) { return this.transact([{ space, id, value }]); }
  *transactionRows(operations) {
    let size = Buffer.byteLength(JSON.stringify({ sequence: '9'.repeat(Math.max(16, String(this.sequence).length + 1)), operations: [] }));
    for (const op of operations) { size += Buffer.byteLength(JSON.stringify(op)) + 1; if (size > this.journalFrameBytes) break; }
    if (size <= this.journalFrameBytes) { yield { operations: Array.isArray(operations) ? operations : [...operations] }; return; }
    const tx = randomUUID(); let part = 0, root = '', data = '';
    // Worst-case JSON escaping costs six bytes per UTF-16 code unit.
    const width = Math.min(this.journalFragmentBytes, Math.floor((this.journalFrameBytes - 256) / 6));
    for (const op of operations) {
      const line = JSON.stringify(op); root = hash(root + line);
      data += line + '\n';
      while (data.length >= width) {
        const end = /[\uD800-\uDBFF]/.test(data[width - 1]) ? width - 1 : width;
        yield { stage: { tx, part: part++, data: data.slice(0, end) } }; data = data.slice(end);
      }
    }
    if (data) yield { stage: { tx, part: part++, data } };
    yield { commit: { tx, parts: part, count: operations.length, root } };
  }
  flush() { return this.gate(async () => {
    while (this.queue.length) {
      const jobs = this.queue.splice(0, this.groupSize);
      try {
        let rows = [], frames = [], bytes = 0;
        const persist = async () => {
          if (!rows.length) return;
          await this.fd.writeFile(Buffer.concat(frames)); await this.fd.sync(); this.apply(rows); this.journalBytes += bytes;
          rows = []; frames = []; bytes = 0;
        };
        for (const job of jobs) {
          for (const data of this.transactionRows(job.operations)) {
            const increment = n => this.decimalSequence ? rules.addUint(this.sequence, String(n)) : rules.safeNumberV2(rules.addUint(String(this.sequence), String(n)));
            let row = { sequence: increment(rows.length + 1), ...data }, body = Buffer.from(JSON.stringify(row));
            check(body.length <= this.journalFrameBytes, 'journal_frame_size');
            if (bytes + 36 + body.length > this.journalGroupBytes) {
              await persist(); row = { sequence: increment(1), ...data }; body = Buffer.from(JSON.stringify(row));
            }
            const header = Buffer.alloc(36); header.writeUInt32BE(body.length); Buffer.from(hash(body), 'hex').copy(header, 4);
            frames.push(header, body); rows.push(row); bytes += header.length + body.length;
          }
        }
        await persist(); jobs.forEach(job => job.resolve());
        // Intake and feed updates also compact during a stalled Bitcoin clock.
        if (this.journalBytes >= this.checkpointBytes) await this.checkpoint();
      } catch (e) { this.failed = e; for (const job of [...jobs, ...this.queue.splice(0)]) job.reject(e); }
    }
  }); }
  async compact() {
    await this.flush();
    return this.gate(() => this.checkpoint());
  }
  async checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await this.fd.close(); this.fd = null;
    await atomicWrite(this.path, Buffer.alloc(0)); this.fd = await open(this.path, 'a+', 0o600); this.journalBytes = 0;
  }
  async bytes() { return (await stat(this.path)).size; }
  async close({ checkpoint = false } = {}) {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer);
    await this.flush();
    // A clean service stop can retain the committed SQLite snapshot and leave
    // only a future crash tail to verify on reopen. Never truncate before the
    // WAL checkpoint has completed durably.
    if (checkpoint && this.fd) await this.checkpoint();
    await this.fd?.close(); this.db?.close();
    if (this.lock) { await this.lock.close(); const owned = JSON.parse(await readFile(this.lockPath, 'utf8')); check(owned.token === this.lockIdentity?.token, 'store_lock_changed'); await unlink(this.lockPath); }
  }
}

// Canonical JSON accepts only JSON values (and rejects -0, nonfinite numbers,
// undefined and sparse arrays). On that domain the round trip is an identity.
// Keep normalization for legacy callers that supply structured-clone values.
export function canonicalEvidenceJSON(value) {
  try { return rules.stableJSON(value); }
  catch { return rules.stableJSON(JSON.parse(JSON.stringify(value))); }
}
