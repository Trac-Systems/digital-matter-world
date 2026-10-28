import { HeaderCache } from './header-cache.mjs';
import { verifyHeaderManifest } from './header-manifest.mjs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { open, copyFile, readFile, rename, stat, unlink } from 'node:fs/promises';
import { check, integer, hex32, atomicWrite, diskSpace } from './check.mjs';
import { loadHistoryAsync, historyProof } from './headers.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = e => { if (e.code !== 'ENOENT') throw e; };
export function descriptor(ref, kind, maxBytes) {
  check(ref && hex32(ref.hash) && integer(ref.bytes) && ref.bytes > 0 && ref.bytes <= maxBytes &&
    ref.path === `/headers/${kind === 'json' ? 'tree' : 'chunks'}/${ref.hash}.${kind}`, 'Invalid header chunk descriptor');
}
export const CHUNK_DOWNLOAD_DEFAULTS = Object.freeze({ chunkBytes: 16000000, nodeBytes: 60000, cleanupFiles: 64, cacheKiB: 1024 });
export function chunkDownloadLimits(input = {}) {
  const limits = { ...CHUNK_DOWNLOAD_DEFAULTS, ...input };
  check(Object.entries(limits).every(([k, v]) => Object.hasOwn(CHUNK_DOWNLOAD_DEFAULTS, k) && integer(v) && v > 0), 'Invalid header chunk limits');
  return limits;
}

// Called with the existing download lock held. This never follows a private
// source URL: every immutable descriptor is a relative public-mirror path.
export async function downloadChunkArchive({ manifest: m, path, partial, source, independent, network, signal, onProgress, currentHistory, onHistory, preferGzip = true,
  limits: inputLimits, manifestTrust }) {
  const limits = chunkDownloadLimits(inputLimits);
  let previous;
  try { previous = JSON.parse(await readFile(path + '.manifest.json', 'utf8')); } catch (e) { absent(e); }
  const accepted = verifyHeaderManifest(m, manifestTrust, { network, previous });
  check(m?.version === 2 && m.network === network && integer(m.height) && integer(m.count) && m.count === m.height + 1 &&
    integer(m.bytes) && m.bytes === m.count * 80 && hex32(m.tip) && m.root?.start === 0 && m.root.end === m.count && m.root.tip === m.tip, 'Invalid chunk manifest');
  descriptor(m.root, 'json', limits.nodeBytes);
  await atomicWrite(path + '.manifest.json', JSON.stringify(accepted));
  const cache = await HeaderCache.open(path, m.root.hash, limits);
  try {
    await cache.sweep();
    let done = currentHistory;
    if (done) historyProof(done);
    else try { done = await loadHistoryAsync(path, { network, signal }); } catch (e) { absent(e); }
    const checkTip = async () => {
      check(await source.hash(m.height, { signal }) === m.tip, 'Source tip changed during download');
      if (independent) check(await independent.hash(m.height, { signal }) === m.tip, 'Independent tip mismatch');
    };
    if (done?.length === m.count && historyProof(done).tip === m.tip) { await checkTip(); await cache.sweep({ complete: true }); onHistory(done); return { ...historyProof(done), downloadedBytes: 0, independentTipChecked: !!independent }; }
    let prefix = 0;
    if (done) {
      check((historyProof(done).network ?? 'mainnet') === network, 'Verified history network mismatch');
      let low = -1, high = Math.min(done.length, m.count) - 1;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (done.get(mid).hash === await source.hash(mid, { signal })) low = mid; else high = mid - 1; }
      prefix = low + 1;
    }
    await diskSpace(partial, m.bytes + limits.chunkBytes * 2);
    if (done) await copyFile(path, partial);
    const output = await open(partial, done ? 'a+' : 'w+', 0o600); await output.truncate(prefix * 80);
    let written = prefix, transferred = 0;
    async function read(ref, kind, maxBytes) {
      descriptor(ref, kind, maxBytes); signal?.throwIfAborted();
      const filename = await cache.file(ref.hash, kind), stage = filename + '.part';
      try { if ((await stat(filename)).size === ref.bytes) { const bytes = await readFile(filename); if (digest(bytes) === ref.hash) return bytes; } } catch (e) { absent(e); }
      let offset = 0; try { offset = (await stat(stage)).size; } catch (e) { absent(e); }
      if (offset === ref.bytes) {
        const bytes = await readFile(stage);
        if (digest(bytes) === ref.hash) { await rename(stage, filename); return bytes; }
        await unlink(stage); offset = 0;
      }
      if (offset > ref.bytes) offset = 0;
      await diskSpace(stage, ref.bytes - offset);
      const response = await source.archive(ref.path, { start: offset, signal });
      try {
        check(response.status === 200 || response.status === 206, 'Header chunk unavailable; retry download');
        check(!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity', 'Invalid chunk encoding');
        if (response.status === 206) check(response.headers.get('content-range') === `bytes ${offset}-${ref.bytes - 1}/${ref.bytes}`, 'Invalid header Content-Range');
        else offset = 0;
        const fd = await open(stage, offset ? 'a' : 'w', 0o600);
        try {
          for await (const bytes of response.body ?? []) { signal?.throwIfAborted(); check(offset + bytes.length <= ref.bytes, 'Chunk exceeds descriptor'); await fd.writeFile(bytes); offset += bytes.length; transferred += bytes.length; }
          await fd.sync();
        } finally { await fd.close(); }
      } finally { await response.body?.cancel().catch(() => {}); }
      check(offset === ref.bytes, 'Header chunk download interrupted');
      const bytes = await readFile(stage);
      if (digest(bytes) !== ref.hash) { await unlink(stage); throw Error('Header chunk checksum mismatch'); }
      await rename(stage, filename); return bytes;
    }
    async function visit(ref, depth = 0) {
      check(depth <= Math.ceil(Math.log2(m.count)) + 1 && integer(ref.start) && integer(ref.end) && ref.start < ref.end && ref.end <= m.count, 'Invalid header tree range');
      if (ref.end <= prefix) return;
      const node = JSON.parse(await read(ref, 'json', limits.nodeBytes));
      check(node.version === 2 && node.network === network && node.start === ref.start && node.end === ref.end && node.tip === ref.tip, 'Header tree binding');
      if (node.children) {
        check(Array.isArray(node.children) && node.children.length >= 1 && node.children.length <= 2 && node.children[0].start === node.start && node.children.at(-1).end === node.end &&
          node.children.at(-1).tip === node.tip && (node.children.length === 1 || node.children[0].end === node.children[1].start), 'Invalid header tree');
        for (const child of node.children) await visit(child, depth + 1);
      } else {
        check(node.chunk?.bytes === (node.end - node.start) * 80 && Math.max(prefix, node.start) === written, 'Header chunk gap');
        descriptor(node.chunk, 'bin', limits.chunkBytes);
        const bytes = preferGzip && node.gzip ? gunzipSync(await read(node.gzip, 'gz', limits.chunkBytes), { maxOutputLength: node.chunk.bytes }) : await read(node.chunk, 'bin', limits.chunkBytes);
        check(bytes.length === node.chunk.bytes && digest(bytes) === node.chunk.hash, 'Header chunk checksum mismatch');
        const start = Math.max(prefix, node.start);
        await output.writeFile(bytes.subarray((start - node.start) * 80)); written = node.end;
        onProgress({ phase: 'downloading', count: written, target: m.count, bytes: written * 80, totalBytes: m.bytes });
      }
    }
    try {
      await visit(m.root); check(written === m.count, 'Header tree incomplete'); await output.sync();
    } finally { await output.close(); }
    const complete = await loadHistoryAsync(partial, { network, signal, onProgress: p => onProgress({ ...p, phase: 'verifying' }) });
    check(historyProof(complete).count === m.count && historyProof(complete).tip === m.tip, 'Header chunk chain mismatch'); await checkTip();
    await rename(partial, path);
    // The installed archive releases this root. Collection stays bounded and
    // finishes across subsequent refreshes or process restarts.
    const result = { ...historyProof(complete), snapshotHeight: m.height, downloadedBytes: transferred, independentTipChecked: !!independent, distribution: 'immutable_chunks' };
    await atomicWrite(path + '.json', JSON.stringify(result));
    await cache.sweep({ complete: true }); onHistory(complete); return result;
  } finally { cache.close(); }
}
