import { DatabaseSync } from 'node:sqlite';
import { readIndexSchema } from './read-index-storage.mjs';
import { mkdir, open, readFile, unlink, stat, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { hash, check, serial, atomicWrite, syncDirectory } from './util.mjs';
const run = promisify(execFile);
const identity = async pid => (await run('ps', ['-p', String(pid), '-o', 'lstart='])).stdout.trim();
const MAX_FRAME = 4_000_000;
// The fsynced journal is the acknowledgement boundary. SQLite is a bounded-cache
// index of both live records and cold history, never a growing in-memory pool.
export class Store {
  static async open(directory, options = {}) {
    const store = new Store(directory, options);
    try { await store.init(); return store; } catch (e) { await store.close().catch(() => {}); throw e; }
  }
  constructor(directory, { queueLimit = 4096, groupSize = 128, groupDelay = 3 } = {}) {
    Object.assign(this, { directory, queueLimit, groupSize, groupDelay }); this.queue = []; this.gate = serial();
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
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; CREATE TABLE IF NOT EXISTS records (space TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(space,id)) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL); INSERT OR IGNORE INTO progress VALUES(1,0)');
    readIndexSchema(this.db);
    this.db.exec("CREATE INDEX IF NOT EXISTS batch_execution_height ON records(json_extract(value,'$.batch.to')) WHERE space='batches'");
    this.getStmt = this.db.prepare('SELECT value FROM records WHERE space=? AND id=?');
    this.putStmt = this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(space,id) DO UPDATE SET value=excluded.value');
    this.delStmt = this.db.prepare('DELETE FROM records WHERE space=? AND id=?');
    this.listStmt = this.db.prepare('SELECT id,value FROM records WHERE space=? AND id>? ORDER BY id LIMIT ?');
    this.countStmt = this.db.prepare('SELECT count(*) AS n FROM records WHERE space=?');
    this.sequence = this.db.prepare('SELECT sequence FROM progress WHERE id=1').get().sequence;
    this.path = join(this.directory, 'pending.log'); this.fd = await open(this.path, 'a+', 0o600);
    const size = (await this.fd.stat()).size; let offset = 0, previous = null;
    const header = Buffer.alloc(36);
    while (offset < size) {
      if (size - offset < 36) break;
      await this.fd.read(header, 0, 36, offset); const n = header.readUInt32BE(0);
      check(n > 0 && n <= MAX_FRAME, 'journal_frame_corrupt', 503);
      if (size - offset - 36 < n) break;
      const body = Buffer.alloc(n); await this.fd.read(body, 0, n, offset + 36);
      check(hash(body) === header.subarray(4).toString('hex'), 'journal_checksum', 503);
      const row = JSON.parse(body); check(Number.isSafeInteger(row.sequence) && (previous === null || row.sequence === previous + 1), 'journal_sequence', 503);
      previous = row.sequence;
      if (row.sequence > this.sequence) { check(row.sequence === this.sequence + 1, 'journal_gap', 503); this.apply([row]); }
      offset += 36 + n;
    }
    if (offset !== size) { await this.fd.truncate(offset); await this.fd.sync(); }
    this.journalBytes = offset;
    await syncDirectory(this.directory);
  }
  get(space, id) { const row = this.getStmt.get(space, String(id)); return row ? JSON.parse(row.value) : null; }
  list(space, { after = '', limit = 100 } = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 4096, 'page_limit');
    return this.listStmt.all(space, after, limit).map(row => ({ id: row.id, value: JSON.parse(row.value) }));
  }
  batchAt(height) {
    return this.db.prepare("SELECT value FROM records WHERE space='batches' AND json_extract(value,'$.batch.to')=? ORDER BY id").all(height).map(row => JSON.parse(row.value));
  }
  count(space) { return this.countStmt.get(space).n; }
  apply(rows) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) for (const op of row.operations) {
        if (op.value === undefined) this.delStmt.run(op.space, String(op.id));
        else this.putStmt.run(op.space, String(op.id), JSON.stringify(op.value));
      }
      const sequence = rows.at(-1).sequence;
      this.db.prepare('UPDATE progress SET sequence=? WHERE id=1').run(sequence);
      this.db.exec('COMMIT'); this.sequence = sequence;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  transact(operations) {
    if (this.closed || this.failed) return Promise.reject(Error('store_unavailable'));
    if (this.queue.length >= this.queueLimit) return Promise.reject(Object.assign(Error('store_backpressure'), { status: 503 }));
    check(Array.isArray(operations) && operations.length > 0, 'store_operations');
    check(Buffer.byteLength(JSON.stringify({ sequence: Number.MAX_SAFE_INTEGER, operations })) <= MAX_FRAME, 'journal_frame_size');
    return new Promise((resolve, reject) => {
      this.queue.push({ operations, resolve, reject });
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.groupDelay);
    });
  }
  put(space, id, value) { return this.transact([{ space, id, value }]); }
  flush() { return this.gate(async () => {
    while (this.queue.length) {
      const jobs = this.queue.splice(0, this.groupSize);
      try {
        const rows = jobs.map((job, i) => ({ sequence: this.sequence + 1 + i, operations: job.operations }));
        const frames = rows.map(row => { const body = Buffer.from(JSON.stringify(row)); check(body.length <= MAX_FRAME, 'journal_frame_size'); const header = Buffer.alloc(36); header.writeUInt32BE(body.length); Buffer.from(hash(body), 'hex').copy(header, 4); return Buffer.concat([header, body]); });
        const bytes = Buffer.concat(frames);
        await this.fd.writeFile(bytes); await this.fd.sync(); this.apply(rows); this.journalBytes += bytes.length;
        // Intake and feed updates also compact during a stalled Bitcoin clock.
        if (this.journalBytes >= 2_000_000) await this.checkpoint();
        jobs.forEach(job => job.resolve());
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
  async close() {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer);
    await this.flush(); await this.fd?.close(); this.db?.close();
    if (this.lock) { await this.lock.close(); const owned = JSON.parse(await readFile(this.lockPath, 'utf8')); check(owned.token === this.lockIdentity?.token, 'store_lock_changed'); await unlink(this.lockPath); }
  }
}
