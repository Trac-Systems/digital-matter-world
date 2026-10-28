import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { HeaderHistory, parseHeader, verifyHistory, targetFromBits, MAX_CLAIMS_PER_WINDOW } from '../../rules/src/index.js';
import { check, hex32, integer, atomicWrite, diskSpace } from './check.mjs';
import { serviceError, safeCode } from './errors.mjs';

export const DEFAULT_HEADER_SOURCES = Object.freeze(['https://mempool.space', 'https://blockstream.info']);
export function headerSource(origin = DEFAULT_HEADER_SOURCES[0], { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const base = new URL(origin);
  check((base.protocol === 'https:' || base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)) && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'Header source must be a credential-free HTTPS origin or local HTTP');
  async function get(path, json = false, signal) {
    const failure = (code, reason, status) => serviceError({ service: 'Bitcoin header source', origin: base.origin, route: path, status, code, reason });
    let r, error;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        signal?.throwIfAborted();
        r = await fetchImpl(base.origin + path, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
        if (r.ok) break;
        await r.body?.cancel();
      } catch (cause) { r = undefined; error = cause; }
      if (attempt === 2) throw failure(r ? 'http_error' : safeCode(error?.cause?.code ?? error?.code ?? error?.name), 'Bitcoin header source unavailable', r?.status);
      await sleep(250 * 2 ** attempt, undefined, { signal });
    }
    let size = 0; const chunks = [];
    try {
      for await (const c of r.body ?? []) { size += c.length; if (size > 60000) throw Object.assign(Error(), { code: 'response_limit' }); chunks.push(c); }
    } catch (error) { throw failure(safeCode(error.code), error.code === 'response_limit' ? 'response too large' : 'response body interrupted', r.status); }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!json) return text;
    try { return JSON.parse(text); } catch { throw failure('invalid_json', 'response is not valid JSON', r.status); }
  }
  return {
    origin: base.origin,
    manifest: ({ signal } = {}) => get('/headers/manifest.json', true, signal),
    chainView: height => { check(integer(height), 'Invalid height'); return get(`/headers/height/${height}.json`, true); },
    archive: (path, { start = 0, signal } = {}) => {
      check(/^\/headers\/(mainnet|regtest)-(0|[1-9][0-9]{0,6})-[0-9a-f]{64}\.bin(?:\.[0-9a-f]{64}\.gz)?$/.test(path) && integer(start), 'Invalid header archive path');
      return fetchImpl(base.origin + path, { redirect: 'error', headers: { 'accept-encoding': 'identity', ...(start ? { range: `bytes=${start}-` } : {}) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
    },
    async height() { const h = await get('/api/blocks/tip/height'); check(/^(0|[1-9][0-9]{0,9})$/.test(h), 'Invalid source height'); return Number(h); },
    async hash(height, { signal } = {}) { check(integer(height), 'Invalid height'); const h = await get(`/api/block-height/${height}`, false, signal); check(hex32(h), 'Invalid source hash'); return h; },
    async header(hash) { check(hex32(hash), 'Invalid hash'); const raw = await get(`/api/block/${hash}/header`); check(/^[0-9a-f]{160}$/.test(raw) && parseHeader(raw).hash === hash, 'Header hash mismatch'); return raw; },
    async blocks(height) { check(integer(height), 'Invalid height'); return get(`/api/blocks/${height}`, true); }
  };
}
export function checkedHeader(raw, height, hash, { powLimitBits = 0x1d00ffff, previous } = {}) {
  const h = parseHeader(raw, height), target = targetFromBits(h.bits);
  check(h.hash === hash && BigInt('0x' + h.hash) <= target && target <= targetFromBits(powLimitBits), 'Invalid header proof of work');
  if (previous) check(h.prev === previous, 'Header does not link to local chain');
  return h;
}
const verified = new WeakMap();
export async function loadHistory(path, { onProgress } = {}) {
  const history = new HeaderHistory(await readFile(path));
  if (onProgress) { const get = history.get.bind(history); history.get = height => { if (height % 4096 === 0) onProgress({ count: height, target: history.length }); return get(height); }; }
  const proof = verifyHistory(history);
  verified.set(history, proof); return history;
}
// Explicit regtest verification keeps the mainnet archive loader unchanged.
export async function loadRegtestHistory(path, { onProgress } = {}) {
  const history = new HeaderHistory(await readFile(path));
  const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
  let previous, work = 0n; const times = [];
  for (let height = 0; height < history.length; height++) {
    if (height % 4096 === 0) onProgress?.({ count: height, target: history.length });
    const h = history.get(height);
    checkedHeader(history.raw(height), height, h.hash, { powLimitBits: 0x207fffff, previous: previous?.hash });
    check(h.bits === 0x207fffff, 'Invalid regtest difficulty');
    if (height === 0) check(h.hash === genesis && h.prev === '0'.repeat(64), 'Invalid regtest genesis');
    else check(h.time > [...times].sort((a,b) => a-b)[Math.floor(times.length / 2)], 'Invalid regtest median time');
    work += (1n << 256n) / (targetFromBits(h.bits) + 1n);
    times.push(h.time); if (times.length > 11) times.shift(); previous = h;
  }
  const proof = { network: 'regtest', count: history.length, tip: previous.hash, chainwork: work.toString() };
  verified.set(history, proof); return history;
}
export function historyProof(history) { check(verified.has(history), 'Load and verify the complete header file first'); return verified.get(history); }
export function assertHistoryTip(history, tip) {
  const proof = historyProof(history);
  check(proof.count === tip.height + 1 && proof.tip === tip.hash, 'Full header history must reach the exact current tip before pattern search or proposal');
  return proof;
}
// CPU verification runs in a local computation thread so MCP initialization and
// claims never wait behind a million hashes. No signer or credentials enter it.
export function loadHistoryAsync(path, { network = 'mainnet', signal, onProgress = () => {} } = {}) {
  check(['mainnet', 'regtest'].includes(network), 'Invalid header network'); signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./header-verify-worker.mjs', import.meta.url), { workerData: { path, network } });
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { void worker.terminate(); finish(signal.reason ?? Error('Header verification cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (settled) return;
      if (message.progress) { onProgress(message.progress); return; }
      if (message.error) { finish(Object.assign(Error(message.error.message), { code: message.error.code })); return; }
      const history = new HeaderHistory(message.bytes); verified.set(history, message.proof); finish(null, history);
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { if (!settled) finish(Error(`Header verifier stopped (${code})`)); });
  });
}

const claimProofs = new WeakMap();
export async function loadClaimHeaders({ heights, source, trac, head, powLimitBits = 0x1d00ffff,
  independent = powLimitBits === 0x1d00ffff ? headerSource(DEFAULT_HEADER_SOURCES[1]) : undefined }) {
  check(Array.isArray(heights) && heights.length > 0 && heights.length <= MAX_CLAIMS_PER_WINDOW + 1 && heights.every(h => integer(h) && h <= head.tip.height), 'Invalid claim header set');
  const rows = new Map(), anchors = new Map();
  for (const height of new Set(heights)) {
    let hash = await trac.hashAt(height);
    if (!hash) {
      check(powLimitBits !== 0x1d00ffff || typeof independent?.hash === 'function', 'An independent source is required for pre-checkpoint mainnet headers');
      check(!source.origin || !independent?.origin || source.origin !== independent.origin, 'Use a different origin for the independent claim header source');
      check(source.chainView, 'Header source needs a verified chain view for pre-checkpoint claims');
      const view = await source.chainView(height);
      check(view.height === height && hex32(view.hash) && integer(view.tip?.height) && hex32(view.tip?.hash) && view.tip.height >= height &&
        view.tip.height <= head.tip.height && await trac.hashAt(view.tip.height) === view.tip.hash, 'Gateway header view differs from contract chain');
      hash = view.hash;
      if (independent) check(await independent.hash(height) === hash, 'Independent claim header mismatch');
      anchors.set(height, { ...view.tip });
    }
    const raw = await source.header(hash), header = checkedHeader(raw, height, hash, { powLimitBits });
    rows.set(height, { raw: typeof raw === 'string' ? raw : Buffer.from(raw).toString('hex'), header: Object.freeze(header) });
  }
  const row = h => { check(rows.has(h), 'Strategy requested a header outside the selected blocks'); return rows.get(h); };
  const history = Object.freeze({ length: head.tip.height + 1, raw: h => row(h).raw, get: h => row(h).header,
    field: (h, f, dt = 'n') => { const v = row(h).header; check((f === 4 || f === 10) ? dt === 'n' : f === 11 && ['n', 'h'].includes(dt), 'Invalid header field'); return (f === 4 ? h : f === 10 ? v.nonce : v.bits).toString(dt === 'h' ? 16 : 10); } });
  claimProofs.set(history, anchors); return history;
}
export async function assertHeaderChain({ history, height, hash, trac, head }) {
  const expected = await trac.hashAt(height);
  if (expected) { check(hash === expected, 'Claim history differs from contract chain'); return; }
  const anchor = claimProofs.get(history)?.get(height);
  if (anchor) {
    check(history.get(height).hash === hash && anchor.height <= head.tip.height && await trac.hashAt(anchor.height) === anchor.hash, 'Claim header view was reorganized'); return;
  }
  historyProof(history);
  const at = Math.min(history.length - 1, head.tip.height);
  check(history.get(height).hash === hash && history.get(at).hash === await trac.hashAt(at), 'Verified history does not overlap the current contract chain');
}
function encodeRow(row) {
  check(integer(row.height) && integer(row.timestamp) && integer(row.nonce) && hex32(row.merkle_root), 'Invalid header metadata');
  check(Number.isInteger(row.version) && row.version >= -0x80000000 && row.version <= 0xffffffff, 'Invalid header version');
  const prev = row.previousblockhash ?? (row.height === 0 ? '0'.repeat(64) : null);
  check(hex32(prev), 'Missing previous block');
  const bits = typeof row.bits === 'string' && /^[0-9a-f]{8}$/.test(row.bits) ? parseInt(row.bits, 16) : row.bits;
  check(integer(bits) && bits <= 0xffffffff, 'Invalid difficulty');
  const raw = Buffer.alloc(80);
  raw.writeUInt32LE(row.version >>> 0); Buffer.from(prev, 'hex').reverse().copy(raw, 4); Buffer.from(row.merkle_root, 'hex').reverse().copy(raw, 36);
  raw.writeUInt32LE(row.timestamp, 68); raw.writeUInt32LE(bits, 72); raw.writeUInt32LE(row.nonce, 76);
  checkedHeader(raw, row.height, row.id); return raw;
}
// Appending a partial file is safe: every resumed file is checked from genesis,
// and it becomes the final artifact only after complete consensus verification.
export async function downloadHeaders({ output, source = headerSource('https://dmtworld.tap-protocol.com'), independent = headerSource(DEFAULT_HEADER_SOURCES[1]), end, delayMs = 500, signal, onProgress = () => {}, network = 'mainnet', ...options }) {
  if (source.manifest) {
    const { downloadArchive } = await import('./header-download.mjs');
    return downloadArchive({ output, source, independent, end, signal, onProgress, network, ...options });
  }
  check(integer(delayMs) && delayMs <= 60000, 'Invalid request delay');
  const path = resolve(output); await mkdir(dirname(path), { recursive: true });
  const target = end ?? await source.height(); check(integer(target) && target <= 0xffffffff, 'Invalid final height');
  let done;
  try {
    done = await loadHistory(path);
    if (done.length > target) {
      const hash = await source.hash(target); check(done.get(target).hash === hash, 'Saved history differs from source');
      if (independent) check(await independent.hash(target) === hash, 'Independent tip mismatch');
      return { ...historyProof(done), downloaded: 0, snapshotHeight: target };
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const partial = path + '.part';
  let history;
  try { history = await loadHistory(partial); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  check((history?.length ?? 0) <= target + 1, 'Partial download is ahead of requested end');
  await diskSpace(partial, (target + 1 - (history?.length ?? 0)) * 80);
  const fd = await open(partial, 'a+', 0o600);
  let count = history?.length ?? 0, previous = history?.get(count - 1).hash, downloaded = 0;
  try {
    if (!count && done) { await fd.writeFile(done.bytes); count = done.length; previous = done.get(count - 1).hash; }
    check(count <= target + 1, 'Partial download is ahead of requested end');
    while (count <= target) {
      signal?.throwIfAborted();
      const top = Math.min(target, count + 9); let rows;
      for (let attempt = 0; attempt < 5; attempt++) {
        try { rows = await source.blocks(top); break; }
        catch { if (attempt === 4) throw new Error('Header download interrupted; resume the partial file'); await sleep(Math.min(8000, 500 * 2 ** attempt), undefined, { signal }); }
      }
      check(Array.isArray(rows), 'Invalid header page');
      const wanted = rows.filter(r => r.height >= count && r.height <= top).sort((a, b) => a.height - b.height);
      check(wanted.length === top - count + 1, 'Incomplete header page');
      const chunks = [];
      for (let i = 0; i < wanted.length; i++) {
        const row = wanted[i]; check(row.height === count + i, 'Duplicate or missing header');
        const raw = encodeRow(row), h = parseHeader(raw, row.height);
        if (previous) check(h.prev === previous, 'Header page does not link');
        previous = h.hash; chunks.push(raw);
      }
      await fd.writeFile(Buffer.concat(chunks)); await fd.sync(); count += wanted.length; downloaded += wanted.length;
      onProgress({ count, target: target + 1 }); await sleep(delayMs, undefined, { signal });
    }
  } finally { await fd.close(); }
  const complete = await loadHistory(partial), proof = historyProof(complete);
  check(proof.tip === await source.hash(target), 'Source tip changed during download');
  if (independent) check(proof.tip === await independent.hash(target), 'Independent tip mismatch');
  await rename(partial, path);
  const manifest = { ...proof, snapshotHeight: target, downloaded, independentTipChecked: !!independent };
  await atomicWrite(path + '.json', JSON.stringify(manifest, null, 2) + '\n'); return manifest;
}
