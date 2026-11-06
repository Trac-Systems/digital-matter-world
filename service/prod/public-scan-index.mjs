import { DatabaseSync } from 'node:sqlite';

// Parsed public payment candidates by Bitcoin block hash. A block hash commits
// to its transactions, so an entry never changes; the file keeps the index
// across restarts so a scan step never downloads an old block again.
export class PublicScanIndex {
  constructor(filename, { memoryBlocks = 4096 } = {}) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS blocks (key TEXT PRIMARY KEY, candidates TEXT NOT NULL)');
    this.read = this.db.prepare('SELECT candidates FROM blocks WHERE key = ?');
    this.write = this.db.prepare('INSERT OR IGNORE INTO blocks (key, candidates) VALUES (?, ?)');
    this.memory = new Map(); this.memoryBlocks = memoryBlocks;
  }
  remember(key, candidates) {
    this.memory.delete(key); this.memory.set(key, candidates);
    while (this.memory.size > this.memoryBlocks) this.memory.delete(this.memory.keys().next().value);
    return candidates;
  }
  get(key) {
    const hit = this.memory.get(key);
    if (hit) return this.remember(key, hit);
    let row; try { row = this.read.get(key); } catch { return undefined; }
    return row ? this.remember(key, Object.freeze(JSON.parse(row.candidates).map(c => Object.freeze(c)))) : undefined;
  }
  // The index is only a cache: a failed write never fails the scan that parsed the block.
  set(key, candidates) { try { this.write.run(key, JSON.stringify(candidates)); } catch { /* kept in memory */ } this.remember(key, candidates); }
  close() { this.db.close(); }
}
