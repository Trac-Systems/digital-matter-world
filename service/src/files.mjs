import { open, readFile, mkdir, link, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, hash, check, syncDirectory } from './util.mjs';
export class Files {
  constructor(directory) { this.directory = directory; }
  receiptName(root, observation) { return root.settingsHash ? `receipts/v2/${hash(JSON.stringify(root))}.json` : `receipts/${observation.id}${observation.receiptSuffix ?? ''}.json`; }
  path(name) { check(/^[a-zA-Z0-9/:_\-.]+$/.test(name) && !name.split('/').some(p => p === '..' || p === '.' || !p), 'file_name'); return join(this.directory, name); }
  async immutable(name, bytes) {
    const path = this.path(name); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = path + '.' + process.pid + '.stage';
    // Publish by hard link only after fsync; a crash cannot expose a partial file.
    await atomicWrite(tmp, bytes);
    try { await link(tmp, path); await syncDirectory(dirname(path)); }
    catch (e) { if (e.code !== 'EEXIST') throw e; check(hash(await readFile(path)) === hash(bytes), 'immutable_conflict', 503); }
    finally { await unlink(tmp); }
    return { path: '/' + name, hash: hash(bytes), bytes: bytes.length };
  }
  async json(name, value, { immutable = false, maxBytes = 60000 } = {}) {
    const bytes = Buffer.from(JSON.stringify(value)); check(bytes.length <= maxBytes, 'feed_budget', 503);
    if (immutable) return this.immutable(name, bytes);
    await atomicWrite(this.path(name), bytes); return { path: '/' + name, hash: hash(bytes), bytes: bytes.length };
  }
  async publish(output, observation) {
    const digest = hash(output.auditBytes), decimal = !!output.file.settingsHash;
    const stem = decimal ? `blocks/v2/${digest}` : `blocks/${output.file.observation}-${output.file.height}-${digest}`;
    const audit = await this.immutable(stem + '.bin', output.auditBytes);
    const summary = await this.immutable(stem + '.json', output.viewerBytes);
    const receiptName = this.receiptName(output.file.receiptRoot, observation);
    const receipts = await this.json(receiptName, output.file.receiptRoot, { immutable: true });
    return { observation: output.file.observation, height: output.file.height, tip: output.file.tip, audit, summary, receipts };
  }
  async serve(req, res) {
    let name;
    try { name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).slice(1); this.path(name); }
    catch { return false; }
    const immutable = /^(blocks|receipts)\/.+\.(json|bin)$/.test(name) || /^(patterns|records)\/.+-[0-9a-f]{64}\.json$/.test(name);
    if (!immutable && name !== 'latest.json') return false;
    let fd; try { fd = await open(this.path(name), 'r'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    const info = await fd.stat();
    const etag = '"' + info.ino.toString(16) + '-' + info.size.toString(16) + '-' + info.mtimeMs.toString(16) + '"';
    res.setHeader('ETag', etag); res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=1, must-revalidate');
    res.setHeader('Content-Type', name.endsWith('.bin') ? 'application/octet-stream' : 'application/json; charset=utf-8');
    if (req.headers['if-none-match'] === etag) { await fd.close(); res.writeHead(304); res.end(); return true; }
    res.setHeader('Content-Length', info.size);
    if (req.method === 'HEAD') { await fd.close(); res.end(); return true; }
    const stream = fd.createReadStream(); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return true;
  }
}
