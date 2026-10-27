import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { createGzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { check, syncDirectory } from './util.mjs';

const archiveName = /^headers\/(mainnet|regtest)-(0|[1-9][0-9]{0,6})-([0-9a-f]{64})\.bin(\.[0-9a-f]{64}\.gz)?$/;

// Only public canonical headers go here. The production adapter has already
// checked this history against Core and the contract beacon. Clients must still
// verify the archive from genesis and check its tip independently.
export class HeaderFiles {
  constructor({ history, files, network }) {
    check(['mainnet', 'regtest'].includes(network), 'header_network');
    Object.assign(this, { history, files, network });
  }
  async manifest() {
    if (this.building) return this.building;
    this.building = this.snapshot();
    try { return await this.building; } finally { this.building = null; }
  }
  async snapshot() {
    const { history, files, network } = this, height = history.length - 1;
    check(height >= 0 && height <= 2000000, 'header_history_unavailable', 503);
    const tip = history.hashAt(height);
    if (!this.current) {
      try {
        const saved = JSON.parse(await readFile(files.path('headers/manifest.json'), 'utf8'));
        if (saved.network === network && archiveName.test(saved.path?.slice(1)) && (await stat(files.path(saved.path.slice(1)))).size === saved.bytes) this.current = saved;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (this.current?.height === height && this.current.tip === tip) return this.current;
    const name = `headers/${network}-${height}-${tip}.bin`, path = files.path(name), stage = path + '.stage';
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let count = 0;
    try {
      // Clone/copy the previous immutable snapshot and append only new rows.
      // A reorg rebuilds from the canonical store; old URLs never change bytes.
      if (this.current && this.current.height < height && history.hashAt(this.current.height) === this.current.tip) {
        await copyFile(files.path(this.current.path.slice(1)), stage, constants.COPYFILE_FICLONE);
        count = this.current.height + 1;
      }
      const fd = await open(stage, count ? 'a' : 'w', 0o600);
      try {
        while (count <= height) {
          const end = Math.min(height + 1, count + 4096), bytes = Buffer.alloc((end - count) * 80);
          for (let h = count; h < end; h++) {
            const raw = history.raw(h), b = typeof raw === 'string' ? Buffer.from(raw, 'hex') : Buffer.from(raw);
            check(b.length === 80, 'header_length', 503); b.copy(bytes, (h - count) * 80);
          }
          await fd.writeFile(bytes); count = end; await yieldIO();
        }
        await fd.sync();
      } finally { await fd.close(); }
      check(history.hashAt(height) === tip, 'header_snapshot_changed', 503);
      const digest = createHash('sha256'), input = await open(stage, 'r');
      try { for await (const chunk of input.createReadStream()) digest.update(chunk); } finally { await input.close(); }
      const compressedHash = createHash('sha256'); let compressedBytes = 0;
      await pipeline(createReadStream(stage), createGzip({ level: 1 }), new Transform({ transform(chunk, encoding, done) {
        compressedHash.update(chunk); compressedBytes += chunk.length; done(null, chunk);
      } }), createWriteStream(stage + '.gz', { mode: 0o600 }));
      const compressed = await open(stage + '.gz', 'r'); try { await compressed.sync(); } finally { await compressed.close(); }
      check(history.hashAt(height) === tip, 'header_snapshot_changed', 503);
      const gzipHash = compressedHash.digest('hex'), gzipPath = '/' + name + '.' + gzipHash + '.gz';
      const manifest = { version: 1, network, height, count: height + 1, tip, bytes: (height + 1) * 80, sha256: digest.digest('hex'), path: '/' + name,
        gzip: { path: gzipPath, bytes: compressedBytes, sha256: gzipHash } };
      await rename(stage, path); await rename(stage + '.gz', files.path(gzipPath.slice(1))); await syncDirectory(dirname(path));
      await files.json('headers/manifest.json', manifest);
      this.current = manifest;
      // Keep three snapshots for in-flight/resumed readers, without accumulating
      // an entire 78 MB archive every block. Open file descriptors remain valid.
      const names = await readdir(dirname(path));
      const old = await Promise.all(names.filter(n => n.endsWith('.bin') && archiveName.test('headers/' + n) && n !== name.slice(8))
        .map(async n => ({ name: n, time: (await stat(files.path('headers/' + n))).mtimeMs })));
      for (const row of old.sort((a, b) => b.time - a.time).slice(2)) {
        await unlink(files.path('headers/' + row.name));
        for (const compressed of names.filter(n => n.startsWith(row.name + '.') && archiveName.test('headers/' + n))) await unlink(files.path('headers/' + compressed));
      }
      return manifest;
    } finally { for (const file of [stage, stage + '.gz']) await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async serve(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    const path = req.url;
    if (path === '/headers/manifest.json') {
      const bytes = Buffer.from(JSON.stringify(await this.manifest()));
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=5, must-revalidate');
      res.setHeader('Content-Length', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes); return true;
    }
    const at = /^\/headers\/height\/(0|[1-9][0-9]{0,6})\.json$/.exec(path);
    if (at) {
      const height = Number(at[1]), hash = this.history.hashAt(height), top = this.history.length - 1;
      check(hash, 'header_missing', 404);
      const bytes = Buffer.from(JSON.stringify({ height, hash, tip: { height: top, hash: this.history.hashAt(top) } }));
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=1, must-revalidate');
      res.setHeader('Content-Length', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes); return true;
    }
    const match = archiveName.exec(path.slice(1));
    if (!match || match[1] !== this.network) return false;
    let fd;
    try { fd = await open(this.files.path(path.slice(1)), 'r'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    const size = (await fd.stat()).size, etag = `"${match[1]}-${match[2]}-${match[3]}${match[4] ?? ''}"`;
    res.setHeader('Content-Type', match[4] ? 'application/gzip' : 'application/octet-stream'); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable, no-transform');
    if (req.headers['if-none-match'] === etag) { await fd.close(); res.writeHead(304); res.end(); return true; }
    let start = 0, end = size - 1;
    if (req.method === 'GET' && req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range && !range[1] && Number.isSafeInteger(Number(range[2])) && Number(range[2]) > 0) {
        start = Math.max(0, size - Number(range[2])); end = size - 1;
      } else { start = range?.[1] ? Number(range[1]) : NaN; end = range?.[2] ? Number(range[2]) : size - 1; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        await fd.close(); res.setHeader('Content-Range', `bytes */${size}`); res.writeHead(416); res.end(); return true;
      }
      end = Math.min(end, size - 1); res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') { await fd.close(); res.end(); return true; }
    const stream = fd.createReadStream({ start, end });
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return true;
  }
}
