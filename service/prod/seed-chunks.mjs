import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { verifyHeaderManifest, manifestHash } from '../../kit/lib/header-manifest.mjs';
import { descriptor, chunkDownloadLimits } from '../../kit/lib/header-chunks.mjs';
import { check, hash } from '../src/util.mjs';
import { seedConsensus } from './seed-checkpoint.mjs';

async function boundedFile(path, limit) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat(); check(stat.isFile() && stat.size <= limit, 'bitcoin_seed_file');
    const bytes = Buffer.alloc(stat.size + 1), { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    check(bytesRead === stat.size, 'bitcoin_seed_changed'); return bytes.subarray(0, bytesRead);
  } finally { await fd.close(); }
}
// An operator installs the signed manifest and its immutable tree/raw chunks
// offline. All six production readers use the same format with independent
// private verification checkpoints. The network source is never consulted.
export async function seedChunks(views, { manifestFile, directory, trust, limits: inputLimits, onCheckpoint, audit = false }) {
  check(isAbsolute(manifestFile ?? '') && isAbsolute(directory ?? ''), 'bitcoin_seed_paths');
  seedConsensus(views);
  const limits = chunkDownloadLimits(inputLimits), m = JSON.parse(await boundedFile(manifestFile, limits.nodeBytes));
  verifyHeaderManifest(m, trust, { network: views.client.network ?? 'mainnet' });
  const id = views.seedKey(manifestHash(m) + ':' + hash(JSON.stringify([views.genesis, views.params])));
  views.db.exec('CREATE TABLE IF NOT EXISTS seed_chunks(id TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID');
  const row = !audit && views.db.prepare('SELECT value FROM seed_chunks WHERE id=?').get(id);
  let checkpoint = row ? JSON.parse(row.value) : { count: 0 }, parent;
  if (checkpoint.count) {
    parent = views.get.get(checkpoint.tip);
    check(parent && BigInt(parent.height) + 1n === BigInt(checkpoint.count) && hash(JSON.stringify(parent)) === checkpoint.recordHash, 'bitcoin_seed_checkpoint');
  }
  const work = views.seedWork = { bytes: 0, headers: 0, nodes: 0, reused: !!row };
  if (checkpoint.count === m.count) { check(checkpoint.tip === m.tip, 'bitcoin_seed_checkpoint'); return; }
  async function read(ref, kind, maxBytes) {
    descriptor(ref, kind, maxBytes);
    const bytes = await boundedFile(join(directory, ref.path.slice(1)), maxBytes);
    check(bytes.length === ref.bytes && hash(bytes) === ref.hash, 'bitcoin_seed_chunk_checksum');
    if (kind === 'bin') work.bytes += bytes.length; else work.nodes++;
    return bytes;
  }
  async function visit(ref, depth = 0) {
    check(depth <= Math.ceil(Math.log2(m.count)) + 1 && Number.isSafeInteger(ref.start) && Number.isSafeInteger(ref.end) &&
      ref.start >= 0 && ref.start < ref.end && ref.end <= m.count, 'bitcoin_seed_tree');
    if (ref.end <= checkpoint.count) return;
    const node = JSON.parse(await read(ref, 'json', limits.nodeBytes));
    check(node.version === 2 && node.network === m.network && node.start === ref.start && node.end === ref.end && node.tip === ref.tip, 'bitcoin_seed_tree');
    if (node.children) {
      check(Array.isArray(node.children) && node.children.length >= 1 && node.children.length <= 2 && node.children[0].start === node.start &&
        node.children.at(-1).end === node.end && node.children.at(-1).tip === node.tip &&
        (node.children.length === 1 || node.children[0].end === node.children[1].start), 'bitcoin_seed_tree');
      for (const child of node.children) await visit(child, depth + 1);
      return;
    }
    check(node.chunk?.bytes === (node.end - node.start) * 80 && node.start <= checkpoint.count && checkpoint.count < node.end, 'bitcoin_seed_gap');
    const bytes = await read(node.chunk, 'bin', limits.chunkBytes);
    while (checkpoint.count < node.end) {
      const end = Math.min(node.end, checkpoint.count + views.limits.seedChunkRows);
      views.db.exec('BEGIN');
      try {
        for (let n = checkpoint.count; n < end; n++) {
          parent = views.insert(bytes.subarray((n - node.start) * 80, (n - node.start + 1) * 80).toString('hex'), n, parent); work.headers++;
        }
        if (end === node.end) check(parent.hash === node.tip, 'bitcoin_seed_tip');
        checkpoint = { count: end, tip: parent.hash, recordHash: hash(JSON.stringify(parent)), chunk: node.chunk.hash };
        views.db.prepare('INSERT OR REPLACE INTO seed_chunks VALUES(?,?)').run(id, JSON.stringify(checkpoint));
        views.db.exec('COMMIT');
      } catch (e) { views.db.exec('ROLLBACK'); throw e; }
      await onCheckpoint?.(checkpoint);
    }
  }
  await visit(m.root); check(checkpoint.count === m.count && checkpoint.tip === m.tip, 'bitcoin_seed_tip');
}
