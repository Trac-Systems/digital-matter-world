import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdir, readFile, copyFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { check, integer, hex32, atomicWrite, diskSpace } from './check.mjs';
import { historyProof, loadHistoryAsync } from './headers.mjs';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { downloadChunkArchive } from './header-chunks.mjs';

export function validateManifest(m, network) {
  check(m?.version === 1 && m.network === network && integer(m.height) && integer(m.count) && m.count === m.height + 1 &&
    integer(m.bytes) && m.bytes === m.count * 80 && hex32(m.tip) && hex32(m.sha256) && m.path === `/headers/${network}-${m.height}-${m.tip}.bin`, 'Invalid header manifest');
  if (m.gzip) check(hex32(m.gzip.sha256) && m.gzip.path === m.path + '.' + m.gzip.sha256 + '.gz' && integer(m.gzip.bytes) && m.gzip.bytes > 0 && m.gzip.bytes <= m.bytes + 100000, 'Invalid compressed header manifest');
  return m;
}
const absent = error => { if (error.code !== 'ENOENT') throw error; };
async function digestFile(path) {
  const fd = await open(path, 'r'), hash = createHash('sha256');
  try { for await (const chunk of fd.createReadStream()) hash.update(chunk); } finally { await fd.close(); }
  return hash.digest('hex');
}
async function lock(path) {
  try {
    const fd = await open(path, 'wx', 0o600);
    await fd.writeFile(String(process.pid)); await fd.close();
    return () => unlink(path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(path, 'utf8'));
    check(Number.isSafeInteger(pid) && pid > 0, 'Header download lock needs review');
    try { process.kill(pid, 0); } catch (e) {
      if (e.code !== 'ESRCH') throw e;
      await unlink(path); return lock(path);
    }
    throw Error('Header history is downloading in another local process');
  }
}

async function transfer({ path, descriptor, source, offset, signal, onProgress }) {
  if (offset === descriptor.bytes) return 0;
  const response = await source.archive(descriptor.path, { start: offset, signal }); let transferred = 0;
  try {
    check(response.status === 200 || response.status === 206, 'Header file unavailable; retry the resumable download');
    check(!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity', 'Header Range transfer must use identity encoding');
    if (response.status === 206) check(response.headers.get('content-range') === `bytes ${offset}-${descriptor.bytes - 1}/${descriptor.bytes}`, 'Invalid header Content-Range');
    else offset = 0; // A server may legally ignore Range and send the whole file.
    const length = response.headers.get('content-length');
    check(length === null || Number(length) === descriptor.bytes - offset, 'Invalid header Content-Length');
    const fd = await open(path, offset ? 'a' : 'w', 0o600);
    try {
      for await (const chunk of response.body ?? []) {
        signal?.throwIfAborted(); check(offset + chunk.length <= descriptor.bytes, 'Header file exceeds manifest');
        await fd.writeFile(chunk); offset += chunk.length; transferred += chunk.length;
        onProgress(offset);
      }
      await fd.sync();
    } finally { await fd.close(); }
    check(offset === descriptor.bytes, 'Header download interrupted; resume the partial file');
    return transferred;
  } finally { await response.body?.cancel().catch(() => {}); }
}

async function gzipTransfer({ partial, manifest, source, signal, onProgress }) {
  const path = partial + '.gz', metadata = path + '.json', descriptor = manifest.gzip; let offset = 0;
  try {
    const saved = JSON.parse(await readFile(metadata, 'utf8'));
    if (saved.path === descriptor.path && saved.sha256 === descriptor.sha256 && saved.bytes === descriptor.bytes) offset = (await stat(path)).size;
  } catch (e) { absent(e); }
  check(offset <= descriptor.bytes, 'Partial compressed header file exceeds manifest');
  await diskSpace(partial, descriptor.bytes - offset + manifest.bytes);
  await atomicWrite(metadata, JSON.stringify(descriptor));
  const progress = bytes => onProgress({ phase: 'downloading', count: Math.floor(manifest.count * bytes / descriptor.bytes), target: manifest.count, bytes, totalBytes: descriptor.bytes });
  progress(offset);
  const transferred = await transfer({ path, descriptor, source, offset, signal, onProgress: progress });
  try {
    check(await digestFile(path) === descriptor.sha256, 'Compressed header archive checksum mismatch');
    let size = 0;
    await pipeline(createReadStream(path), createGunzip(), new Transform({ transform(chunk, encoding, done) {
      size += chunk.length; done(size > manifest.bytes ? Error('Uncompressed header file exceeds manifest') : null, chunk);
    } }), createWriteStream(partial, { mode: 0o600 }), { signal });
    check(size === manifest.bytes, 'Uncompressed header file length mismatch');
    const fd = await open(partial, 'r'); try { await fd.sync(); } finally { await fd.close(); }
    await atomicWrite(partial + '.json', JSON.stringify(manifest));
    return transferred;
  } catch (error) { await unlink(partial).catch(absent); throw error; }
  finally { if (!signal?.aborted) { await unlink(path).catch(absent); await unlink(metadata).catch(absent); } }
}

// No metadata-page fallback for a gateway missing its archive. A missing route
// stays an explicit background retry rather than an hours-long silent download.
export async function downloadArchive({ output, source, independent, network = 'mainnet', end, signal, onProgress = () => {}, currentHistory, onHistory = () => {}, preferGzip = true, chunkLimits, manifestTrust }) {
  check(['mainnet', 'regtest'].includes(network), 'Invalid header network');
  check(network !== 'mainnet' || typeof independent?.hash === 'function', 'An independent mainnet tip source is required');
  check(!source.origin || !independent?.origin || source.origin !== independent.origin, 'Use a different origin for the independent tip source');
  signal?.throwIfAborted();
  const path = resolve(output), partial = path + '.part', metadata = partial + '.json';
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const unlock = await lock(path + '.lock');
  try {
    const announced = await source.manifest({ signal });
    if (announced?.version === 2) {
      check(end === undefined || end === announced.height, 'Bulk download uses the manifest snapshot height');
      return await downloadChunkArchive({ manifest: announced, path, partial, source, independent, network, signal, onProgress, currentHistory, onHistory, preferGzip, limits: chunkLimits, manifestTrust });
    }
    let authenticated;
    try { authenticated = await stat(path + '.manifest.json'); } catch (e) { absent(e); }
    check(!authenticated, 'Authenticated header distribution cannot downgrade to a legacy manifest');
    const manifest = validateManifest(announced, network);
    check(end === undefined || end === manifest.height, 'Bulk download uses the manifest snapshot height');
    const verify = file => loadHistoryAsync(file, { network, signal, onProgress: p => onProgress({ ...p, phase: 'verifying', bytes: manifest.bytes, totalBytes: manifest.bytes }) });
    let done = currentHistory;
    if (done) historyProof(done);
    else try { done = await verify(path); } catch (e) { absent(e); }
    if (done) check((historyProof(done).network ?? 'mainnet') === network, 'Verified history network mismatch');
    const checkTip = async () => {
      signal?.throwIfAborted();
      check(await source.hash(manifest.height, { signal }) === manifest.tip, 'Source tip changed during download');
      if (independent) check(await independent.hash(manifest.height, { signal }) === manifest.tip, 'Independent tip mismatch');
    };
    if (done?.length === manifest.count && historyProof(done).tip === manifest.tip) {
      // A remote manifest cannot claim different bytes for an already verified
      // chain. Check its digest too, including when a cached file is reused.
      const digest = historyProof(done).sha256 ?? createHash('sha256').update(done.bytes).digest('hex');
      check(digest === manifest.sha256, 'Header archive checksum mismatch');
      await checkTip(); onHistory(done);
      return { ...historyProof(done), snapshotHeight: manifest.height, downloaded: 0, independentTipChecked: !!independent };
    }
    let offset = 0, saved;
    try { saved = validateManifest(JSON.parse(await readFile(metadata, 'utf8')), network); offset = (await stat(partial)).size; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (saved && offset > 0) {
      check(offset <= saved.bytes, 'Partial header file exceeds manifest');
      if (saved.path !== manifest.path && (saved.height > manifest.height || await source.hash(saved.height, { signal }) !== saved.tip)) offset = 0;
    } else offset = 0;
    let transferredBytes = 0, compressed = false;
    if (offset || done || !manifest.gzip || !preferGzip)
      await diskSpace(partial, offset ? manifest.bytes - offset : Math.max(manifest.bytes, done?.bytes.length ?? 0));
    if (!offset && !done && manifest.gzip && preferGzip) {
      compressed = true;
      transferredBytes = await gzipTransfer({ partial, manifest, source, signal, onProgress }); offset = manifest.bytes;
    } else if (!offset && done) {
      // Find the common prefix on a reorg with O(log height) hash reads. Only
      // the replacement tail is transferred; every result is verified again.
      let high = Math.min(done.length, manifest.count) - 1, low = 0;
      check(done.get(0).hash === await source.hash(0, { signal }), 'Source genesis mismatch');
      if (done.get(high).hash === await source.hash(high, { signal })) low = high;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (done.get(mid).hash === await source.hash(mid, { signal })) low = mid; else high = mid - 1;
      }
      await copyFile(path, partial);
      offset = (low + 1) * 80;
      const fd = await open(partial, 'r+'); try { await fd.truncate(offset); } finally { await fd.close(); }
    } else if (!offset) { const fd = await open(partial, 'w', 0o600); await fd.close(); }
    await atomicWrite(metadata, JSON.stringify(manifest));
    onProgress({ phase: 'downloading', count: Math.floor(offset / 80), target: manifest.count, bytes: offset, totalBytes: manifest.bytes });
    if (offset < manifest.bytes) {
      transferredBytes = await transfer({ path: partial, descriptor: manifest, source, offset, signal,
        onProgress: bytes => onProgress({ phase: 'downloading', count: Math.floor(bytes / 80), target: manifest.count, bytes, totalBytes: manifest.bytes }) });
    }
    let complete;
    try {
      check(await digestFile(partial) === manifest.sha256, 'Header archive checksum mismatch');
      complete = await verify(partial);
      const proof = historyProof(complete);
      check(proof.count === manifest.count && proof.tip === manifest.tip, 'Header archive tip mismatch');
    } catch (error) {
      // Keep interrupted bytes for Range resume; a complete, invalid artifact
      // must never become the final file or be retried as a trusted prefix.
      if (!signal?.aborted) { await unlink(partial).catch(absent); await unlink(metadata).catch(absent); }
      throw error;
    }
    await checkTip();
    await rename(partial, path); await unlink(metadata).catch(absent);
    const result = { ...historyProof(complete), snapshotHeight: manifest.height, downloaded: compressed ? manifest.count : Math.ceil(transferredBytes / 80), downloadedBytes: transferredBytes, compression: compressed ? 'gzip' : 'identity', independentTipChecked: !!independent };
    await atomicWrite(path + '.json', JSON.stringify(result, null, 2) + '\n'); onHistory(complete); return result;
  } finally { await unlock(); }
}
