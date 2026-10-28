import { DatabaseSync } from 'node:sqlite';
import { mkdir, unlink, rmdir, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { check, hex32 } from './check.mjs';

const absent = e => { if (e.code !== 'ENOENT') throw e; };
// The caller holds the archive download lock for this cache's entire lifetime.
// Each manifest owns its resume files. Switching the active root explicitly
// abandons the old transfer; an interrupted current transfer stays pinned.
export class HeaderCache {
  static async open(path, root, limits) {
    check(hex32(root), 'Invalid cache root');
    await mkdir(path + '.chunks-v2', { recursive: true, mode: 0o700 });
    return new HeaderCache(path, root, limits);
  }
  constructor(path, root, limits) {
    check(Number.isSafeInteger(limits.cleanupFiles) && limits.cleanupFiles > 0 && Number.isSafeInteger(limits.cacheKiB ?? 1024) && (limits.cacheKiB ?? 1024) > 0, 'Invalid chunk cache limits');
    this.directory = path + '.chunks-v2'; this.legacy = path + '.chunks'; this.root = root; this.limits = limits;
    this.db = new DatabaseSync(join(this.directory, 'index.sqlite'));
    try {
      this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-${limits.cacheKiB ?? 1024};
      CREATE TABLE IF NOT EXISTS files(root TEXT,name TEXT,PRIMARY KEY(root,name)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),active TEXT);`);
      this.db.prepare('INSERT OR REPLACE INTO state VALUES(1,?)').run(root);
    } catch (error) { this.db.close(); throw error; }
  }
  async file(hash, kind) {
    check(hex32(hash) && ['json', 'bin', 'gz'].includes(kind), 'Invalid cached chunk');
    const name = hash + '.' + kind;
    // SQLite retains the exclusive lock across these durable commits. This
    // also fences simultaneous stale-PID recovery in the outer file lock.
    // Journal ownership before creating either final or partial bytes.
    this.db.prepare('INSERT OR IGNORE INTO files VALUES(?,?)').run(this.root, name);
    await mkdir(join(this.directory, this.root), { recursive: true, mode: 0o700 });
    return join(this.directory, this.root, name);
  }
  async sweep({ complete = false } = {}) {
    if (complete) this.db.prepare('UPDATE state SET active=NULL WHERE id=1').run();
    const active = this.db.prepare('SELECT active FROM state WHERE id=1').get().active;
    // Two indexed ranges avoid scanning the active root's lifetime file set.
    const rows = this.db.prepare('SELECT root,name FROM files WHERE root<? ORDER BY root,name LIMIT ?').all(active ?? '', this.limits.cleanupFiles);
    rows.push(...this.db.prepare('SELECT root,name FROM files WHERE root>? ORDER BY root,name LIMIT ?').all(active ?? '', this.limits.cleanupFiles - rows.length));
    let deleted = 0;
    for (const row of rows) {
      check(hex32(row.root) && /^[0-9a-f]{64}\.(json|bin|gz)$/.test(row.name), 'Invalid chunk cache ledger');
      for (const suffix of ['', '.part']) await unlink(join(this.directory, row.root, row.name + suffix)).catch(absent);
      this.db.prepare('DELETE FROM files WHERE root=? AND name=?').run(row.root, row.name); deleted++;
      await rmdir(join(this.directory, row.root)).catch(e => { if (!['ENOENT', 'ENOTEMPTY'].includes(e.code)) throw e; });
    }
    // Old flat caches are never used by the new downloader. Delete them only
    // after a complete verified archive is installed. No recursive deletion,
    // links followed, full directory listing or deletion of unknown names.
    if (complete && deleted < this.limits.cleanupFiles) {
      let dir;
      try {
        dir = await opendir(this.legacy, { bufferSize: 1 });
        for (let work = deleted; work < this.limits.cleanupFiles; work++) {
          const entry = await dir.read(); if (!entry) break;
          if (entry.isFile() && /^[0-9a-f]{64}\.(json|bin|gz)(\.part)?$/.test(entry.name)) {
            await unlink(join(this.legacy, entry.name)).catch(absent); deleted++;
          }
        }
      } catch (e) { absent(e); } finally { await dir?.close(); }
    }
    return deleted;
  }
  close() { this.db.close(); }
}
