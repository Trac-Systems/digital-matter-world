import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { check, hash } from '../src/util.mjs';

const identity = s => JSON.stringify([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String));
export function seedConsensus(views) {
  const value = hash(JSON.stringify([views.genesis, views.params]));
  views.db.exec('CREATE TABLE IF NOT EXISTS seed_consensus(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
  const saved = views.db.prepare('SELECT value FROM seed_consensus WHERE id=1').get();
  check(!saved || saved.value === value, 'bitcoin_seed_consensus_changed');
  views.db.prepare('INSERT OR IGNORE INTO seed_consensus VALUES(1,?)').run(value);
}
// The private checkpoint commits both the exact file identity and the last
// verified database row. Hashing is an initial integrity pass, persisted BEFORE
// importing: a crash resumes at a committed chunk without hashing the prefix.
export async function seedCheckpoint(views, filename, { sha256, audit = false, onCheckpoint } = {}) {
  check(sha256 === undefined || /^[0-9a-f]{64}$/.test(sha256), 'bitcoin_seed_hash');
  seedConsensus(views);
  views.db.exec('CREATE TABLE IF NOT EXISTS seed_checkpoints(path TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID');
  const file = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await file.stat({ bigint: true }), stamp = identity(info), path = views.seedKey(resolve(filename)), params = hash(JSON.stringify(views.params));
    check(info.isFile() && info.size > 0n && info.size % 80n === 0n && info.size <= BigInt(Number.MAX_SAFE_INTEGER), 'bitcoin_seed');
    const saved = views.db.prepare('SELECT value FROM seed_checkpoints WHERE path=?').get(path);
    let checkpoint = saved && JSON.parse(saved.value), bytes = 0, headers = 0;
    check(!checkpoint || checkpoint.genesis === views.genesis && checkpoint.params === params, 'bitcoin_seed_consensus_changed');
    const compatible = !audit && checkpoint?.identity === stamp && checkpoint.genesis === views.genesis && checkpoint.params === params && (!sha256 || checkpoint.sha256 === sha256);
    let parent;
    if (compatible && checkpoint.tip) {
      parent = views.get.get(checkpoint.tip);
      check(parent?.height === checkpoint.height && hash(JSON.stringify(parent)) === checkpoint.recordHash, 'bitcoin_seed_checkpoint');
    }
    if (compatible && (checkpoint.v === 1 || checkpoint.offset === Number(info.size))) {
      views.seedWork = { bytes: 0, headers: 0, reused: true }; return;
    }
    const save = value => views.db.prepare('INSERT OR REPLACE INTO seed_checkpoints VALUES(?,?)').run(path, JSON.stringify(value));
    const buffer = Buffer.alloc(80 * views.limits.seedChunkRows);
    if (!compatible) {
      const digest = createHash('sha256');
      for (let offset = 0; offset < Number(info.size);) {
        const length = Math.min(buffer.length, Number(info.size) - offset), result = await file.read(buffer, 0, length, offset);
        check(result.bytesRead === length, 'bitcoin_seed_changed'); digest.update(buffer.subarray(0, length)); offset += length; bytes += length;
      }
      const checksum = digest.digest('hex');
      check(!sha256 || checksum === sha256, 'bitcoin_seed_binding');
      check(identity(await file.stat({ bigint: true })) === stamp, 'bitcoin_seed_changed');
      checkpoint = { v: 2, identity: stamp, genesis: views.genesis, params, sha256: checksum, offset: 0 };
      save(checkpoint); parent = undefined;
    }
    let n = checkpoint.offset / 80, resume = true;
    while (checkpoint.offset < Number(info.size)) {
      const length = Math.min(buffer.length, Number(info.size) - checkpoint.offset), result = await file.read(buffer, 0, length, checkpoint.offset);
      check(result.bytesRead === length && identity(await file.stat({ bigint: true })) === stamp, 'bitcoin_seed_changed'); bytes += length;
      views.db.exec('BEGIN');
      try {
        for (let offset = 0; offset < length; offset += 80) {
          const raw = buffer.subarray(offset, offset + 80), id = createHash('sha256').update(createHash('sha256').update(raw).digest()).digest().reverse().toString('hex');
          const stored = resume ? views.get.get(id) : null;
          if (stored?.height === views.ordinal(n) && (n === 0 ? stored.hash === views.genesis : stored.parent === parent.hash)) parent = stored;
          else { resume = false; parent = views.insert(raw.toString('hex'), n, parent); }
          n++; headers++;
        }
        checkpoint = { ...checkpoint, offset: checkpoint.offset + length, height: parent.height, tip: parent.hash,
          recordHash: hash(JSON.stringify(parent)), chunkHash: hash(buffer.subarray(0, length)) };
        save(checkpoint); views.db.exec('COMMIT');
      } catch (error) { views.db.exec('ROLLBACK'); throw error; }
      views.seedWork = { bytes, headers, reused: compatible }; await onCheckpoint?.(checkpoint);
    }
    check(identity(await file.stat({ bigint: true })) === stamp, 'bitcoin_seed_changed');
    views.seedWork = { bytes, headers, reused: compatible };
  } finally { await file.close(); }
}
