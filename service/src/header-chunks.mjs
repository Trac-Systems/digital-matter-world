import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { open, unlink } from 'node:fs/promises';
import { headerManifestSigner } from '../../kit/lib/header-manifest.mjs';
import { check, hash, serial } from './util.mjs';

const compress = promisify(gzip);
export const HEADER_CHUNK_DEFAULTS = Object.freeze({ chunkRows: 4096, chunksPerTick: 4, manifestRetention: 3, garbagePerTick: 64, cacheSeconds: 5, immutableCacheSeconds: 31536000, manifestBytes: 60000 });
export class HeaderChunks {
  constructor({ store, history, files, network, settings = {}, secret, signingEpoch = '0', readOnly = false }) {
    Object.assign(this, { store, history, files, network }); this.settings = { ...HEADER_CHUNK_DEFAULTS, ...settings }; this.gate = serial(); this.signer = readOnly ? null : headerManifestSigner(secret, signingEpoch);
    check(['mainnet', 'regtest'].includes(network) && Object.entries(this.settings).every(([k, v]) => Object.hasOwn(HEADER_CHUNK_DEFAULTS, k) && Number.isSafeInteger(v) && v > 0), 'header_chunk_settings');
  }
  node(ref) {
    const node = this.store.get('headerTreeNodes', ref.hash);
    check(node && hash(Buffer.from(JSON.stringify(node))) === ref.hash, 'header_tree_missing', 503); return node;
  }
  async publish(node) {
    const bytes = Buffer.from(JSON.stringify(node)), ref = await this.files.immutable(`headers/tree/${hash(bytes)}.json`, bytes);
    if (!this.store.get('headerTreeNodes', ref.hash)) {
      const operations = [{ space: 'headerTreeNodes', id: ref.hash, value: node }, { space: 'headerTreeRefs', id: ref.hash, value: 0 },
        { space: 'headerTreeGarbage', id: ref.hash, value: ref }];
      for (const child of node.children ?? []) operations.push({ space: 'headerTreeRefs', id: child.hash, value: (this.store.get('headerTreeRefs', child.hash) ?? 0) + 1 }, { space: 'headerTreeGarbage', id: child.hash });
      await this.store.transact(operations);
    }
    return { ...ref, start: node.start, end: node.end, tip: node.tip, leaves: node.leaves, span: node.span };
  }
  async branch(left, right, span) {
    check(left && (!right || left.end === right.start), 'header_tree_gap');
    return this.publish({ version: 2, network: this.network, start: left.start, end: (right ?? left).end, tip: (right ?? left).tip,
      leaves: left.leaves + (right?.leaves ?? 0), span, children: [left, ...(right ? [right] : [])] });
  }
  async append(root, leaf) {
    if (!root) return leaf;
    if (root.leaves === root.span) return this.branch(root, leaf, root.span * 2);
    const node = this.node(root), [left, right] = node.children;
    return this.branch(left, await this.append(right, leaf), root.span);
  }
  // Reuse a canonical subtree by its terminal hash. A mismatch descends only
  // the changed suffix; no ancestor walk or full manifest list is constructed.
  async canonicalPrefix(ref) {
    if (!ref) return null;
    if (ref.end <= this.history.length && this.history.hashAt(ref.end - 1) === ref.tip) return ref;
    const node = this.node(ref);
    if (!node.children) return null;
    const left = await this.canonicalPrefix(node.children[0]);
    if (!left || left.end !== node.children[0].end) return left;
    const right = await this.canonicalPrefix(node.children[1]);
    return right ? this.branch(left, right, ref.span) : left;
  }
  async collect() {
    for (const { id, value: ref } of this.store.list('headerTreeGarbage', { limit: this.settings.garbagePerTick })) {
      if (this.store.get('headerTreeRefs', id) !== 0) { await this.store.put('headerTreeGarbage', id); continue; }
      const node = this.node(ref), operations = [];
      for (const child of node.children ?? []) {
        const next = this.store.get('headerTreeRefs', child.hash) - 1; check(next >= 0, 'header_tree_reference');
        operations.push({ space: 'headerTreeRefs', id: child.hash, value: next }, ...(next === 0 ? [{ space: 'headerTreeGarbage', id: child.hash, value: child }] : []));
      }
      for (const file of [ref, node.chunk, node.gzip].filter(Boolean)) await unlink(this.files.path(file.path.slice(1))).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await this.store.transact([...operations, ...['headerTreeNodes', 'headerTreeRefs', 'headerTreeGarbage'].map(space => ({ space, id }))]);
    }
  }
  async tick() { return this.gate(async () => {
    check(this.signer, 'header_read_only', 503);
    const saved = this.store.get('meta', 'headerChunks'), { history } = this;
    if (!history.length) return;
    let root = await this.canonicalPrefix(saved?.root), start = root?.end ?? 0;
    for (let work = 0; work < this.settings.chunksPerTick && start < history.length; work++) {
      const end = Math.min(history.length, start + this.settings.chunkRows), tip = history.hashAt(end - 1), bytes = Buffer.alloc((end - start) * 80);
      for (let h = start; h < end; h++) { const raw = Buffer.from(history.raw(h), 'hex'); check(raw.length === 80, 'header_length'); raw.copy(bytes, (h - start) * 80); }
      check(history.hashAt(end - 1) === tip, 'header_snapshot_changed', 503);
      const chunk = await this.files.immutable(`headers/chunks/${hash(bytes)}.bin`, bytes), compressed = await compress(bytes, { level: 1 });
      const gzip = await this.files.immutable(`headers/chunks/${hash(compressed)}.gz`, compressed);
      root = await this.append(root, await this.publish({ version: 2, network: this.network, start, end, tip, leaves: 1, span: 1, chunk, gzip })); start = end;
    }
    const unchanged = saved?.root.hash === root?.hash;
    if (!root || unchanged && saved.authentication?.key === this.signer.key && saved.authentication?.epoch === this.signer.epoch) { await this.collect(); return; }
    check(history.hashAt(root.end - 1) === root.tip, 'header_snapshot_changed', 503);
    const manifest = this.signer.sign({ version: 2, sequence: (BigInt(saved?.sequence ?? '-1') + 1n).toString(), network: this.network, height: root.end - 1, count: root.end, bytes: root.end * 80, tip: root.tip, root,
      verification: 'operator_signature_and_checksums_and_local_chain_and_independent_tip' });
    check(Buffer.byteLength(JSON.stringify(manifest)) <= this.settings.manifestBytes, 'header_manifest_budget', 503);
    // The root pointer is the only startup read; every immutable node has been
    // fsynced before this journal commit publishes it.
    const previous = this.store.get('meta', 'headerChunkVersions') ?? [], versions = unchanged ? previous : [root, ...previous];
    const changes = new Map(), refs = new Map();
    for (const [ref, delta] of [...(unchanged ? [] : [[root, 1]]), ...versions.slice(this.settings.manifestRetention).map(ref => [ref, -1])]) {
      changes.set(ref.hash, (changes.get(ref.hash) ?? this.store.get('headerTreeRefs', ref.hash) ?? 0) + delta); refs.set(ref.hash, ref);
    }
    await this.store.transact([{ space: 'meta', id: 'headerChunks', value: manifest },
      { space: 'meta', id: 'headerChunkVersions', value: versions.slice(0, this.settings.manifestRetention) },
      ...[...changes].flatMap(([id, value]) => [{ space: 'headerTreeRefs', id, value }, { space: 'headerTreeGarbage', id, ...(value === 0 ? { value: refs.get(id) } : {}) }])]);
    await this.files.json('headers/manifest-v2.json', manifest, { maxBytes: this.settings.manifestBytes });
    await this.collect();
  }); }
  manifest() {
    const value = this.store.get('meta', 'headerChunks'); check(value && this.history.hashAt(value.height) === value.tip, 'header_chunks_pending', 503); return value;
  }
  async serve(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    if (req.url === '/headers/manifest.json' || req.url === '/headers/manifest-v2.json') {
      const bytes = Buffer.from(JSON.stringify(this.manifest())), etag = '"' + hash(bytes) + '"';
      res.setHeader('Content-Type', 'application/json'); res.setHeader('ETag', etag); res.setHeader('Cache-Control', `public, max-age=${this.settings.cacheSeconds}, must-revalidate`);
      if (req.headers['if-none-match'] === etag) res.writeHead(304).end();
      else { res.setHeader('Content-Length', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes); }
      return true;
    }
    const match = /^\/headers\/(tree|chunks)\/([0-9a-f]{64})\.(json|bin|gz)$/.exec(req.url);
    if (!match || (match[1] === 'tree') !== (match[3] === 'json')) return false;
    let fd; try { fd = await open(this.files.path(req.url.slice(1)), 'r'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const size = (await fd.stat()).size, etag = '"' + match[2] + '"';
    res.setHeader('Content-Type', match[3] === 'json' ? 'application/json' : match[3] === 'gz' ? 'application/gzip' : 'application/octet-stream');
    res.setHeader('ETag', etag); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', `public, max-age=${this.settings.immutableCacheSeconds}, immutable, no-transform`);
    if (req.headers['if-none-match'] === etag) { await fd.close(); res.writeHead(304).end(); return true; }
    let start = 0, end = size - 1;
    if (req.method === 'GET' && req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range && !range[1] && Number(range[2]) > 0) start = Math.max(0, size - Number(range[2]));
      else { start = range?.[1] ? Number(range[1]) : NaN; end = range?.[2] ? Number(range[2]) : size - 1; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        await fd.close(); res.setHeader('Content-Range', `bytes */${size}`); res.writeHead(416).end(); return true;
      }
      end = Math.min(size - 1, end); res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') { await fd.close(); res.end(); return true; }
    const stream = fd.createReadStream({ start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return true;
  }
}
