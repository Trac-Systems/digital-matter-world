import { createHash } from 'node:crypto';
import { CLAIM_DEFAULTS, MAX_CLAIMS_PER_WINDOW } from '../../rules/src/index.js';
import { validateDefinition, fieldValue } from '../../rules/src/patterns.js';
import { amountWith } from '../../rules/src/pattern-amount.js';
import { readInteger } from '../lib/api-values.mjs';

const compareCount = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const CHUNK = 128, CHUNK_BYTES = CHUNK * 8 + 128;
export const CLAIM_HUNT_DEFAULTS = Object.freeze({ cacheBytes: 32 * 1024 * 1024, sliceMs: 20 });

// Reuse the consensus amount calculation, including nullable global expressions,
// left-to-right alternatives and zero-valued field-value matches. Only compilation
// and validation move out of the block loop; consensus code remains untouched.
export function compileClaimAmount(pattern) {
  const definition = { pat: pattern.pat, fld: pattern.fld, dt: pattern.dt, amountMode: pattern.amountMode };
  validateDefinition(definition);
  const regex = new RegExp(definition.pat, 'g');
  return (history, block) => amountWith(definition, regex, typeof history.field === 'function'
    ? history.field(block, definition.fld, definition.dt)
    : fieldValue(definition.fld === 4 ? { height: block } : history.get(block), definition.fld, definition.dt));
}

function slicer(sliceMs) {
  let deadline = performance.now() + sliceMs;
  return () => {
    if (performance.now() < deadline) return;
    return new Promise(resolve => setImmediate(() => { deadline = performance.now() + sliceMs; resolve(); }));
  };
}

// Cache only local matching heights, never taken/claimable decisions. A native,
// sliced prefix digest recognizes replacement HeaderHistory objects and rejects
// forks or in-place byte changes without retaining or copying an archive. Generic
// histories must be append-only on the same object; replacement resets the cache.
export class ClaimMatchCache {
  constructor({ maxBytes = CLAIM_HUNT_DEFAULTS.cacheBytes } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Error('Invalid claim cache byte limit');
    this.maxBytes = maxBytes;
    this.clear(); this.tail = Promise.resolve();
  }
  clear() { this.entries = new Map(); this.bytes = 0; this.identity = undefined; this.length = 0; this.digest = undefined; }
  async run(history, checkpoint, select) {
    const previous = this.tail;
    let release; this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { await this.prepare(history, checkpoint); return await select(this); }
    finally { release(); }
  }
  async prepare(history, checkpoint) {
    if (!this.maxBytes) return;
    const bytes = history.bytes;
    if (bytes instanceof Uint8Array && bytes.length === history.length * 80) {
      const digest = createHash('sha256'), prefix = this.length * 80;
      let offset = 0, prefixDigest;
      // Digest the old prefix separately, then continue through appended headers.
      for (const end of [Math.min(prefix, bytes.length), bytes.length]) {
        while (offset < end) {
          const next = Math.min(offset + 256 * 1024, end);
          digest.update(bytes.subarray(offset, next)); offset = next;
          const pause = checkpoint(); if (pause) await pause;
        }
        if (offset === prefix) prefixDigest = digest.copy().digest('hex');
      }
      const nextDigest = digest.digest('hex');
      if (!this.digest || this.length > history.length || prefixDigest !== this.digest) this.clear();
      this.digest = nextDigest;
    } else {
      if (this.identity?.deref() !== history || this.length > history.length || this.digest) this.clear();
      this.identity = new WeakRef(history);
    }
    this.length = history.length;
  }
  entry(key) {
    let entry = this.entries.get(key);
    if (entry) return entry;
    const bytes = 512 + key.length * 2;
    if (this.bytes + bytes > this.maxBytes) return;
    entry = { scanned: 0, size: 0, chunks: [], bytes };
    this.entries.set(key, entry); this.bytes += bytes; return entry;
  }
  append(key, entry, block) {
    if (entry.size % CHUNK === 0) {
      if (this.bytes + CHUNK_BYTES > this.maxBytes) {
        // Discard this incomplete list. This hunt continues its scan in order;
        // later hunts scan this definition again if the cache cannot hold it.
        this.entries.delete(key); this.bytes -= entry.bytes; return false;
      }
      entry.chunks.push(new Float64Array(CHUNK)); entry.bytes += CHUNK_BYTES; this.bytes += CHUNK_BYTES;
    }
    entry.chunks[Math.floor(entry.size / CHUNK)][entry.size % CHUNK] = block; entry.size++; return true;
  }
}

const at = (entry, index) => entry.chunks[Math.floor(index / CHUNK)][index % CHUNK];
function contains(entry, block) {
  let low = 0, high = entry.size;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (at(entry, mid) < block) low = mid + 1; else high = mid; }
  return low < entry.size && at(entry, low) === block;
}

export function createClaimSelector({ cacheBytes = CLAIM_HUNT_DEFAULTS.cacheBytes, sliceMs = CLAIM_HUNT_DEFAULTS.sliceMs,
  cache = new ClaimMatchCache({ maxBytes: cacheBytes }) } = {}) {
  if (!Number.isFinite(sliceMs) || sliceMs <= 0 || sliceMs > 20) throw Error('Claim slice must be greater than zero and at most 20 ms');
  return async function chooseClaims({ history, patterns = [], taken = {}, claimsPerWindow = CLAIM_DEFAULTS.claimsPerWindow,
    claimableHeight = history.length - 1, window = claimableHeight }) {
    const budget = Math.min(MAX_CLAIMS_PER_WINDOW, Math.max(0, claimsPerWindow));
    if (!(budget > 0) || !patterns.length || !history.length) return [];
    const checkpoint = slicer(sliceMs);
    return cache.run(history, checkpoint, async cache => {
      const plots = new Map(); let selected = 0, work = 0;
      const ordered = [...patterns].sort((a, b) => {
        const x = a.knownMatchCount ?? a.rarity, y = b.knownMatchCount ?? b.rarity;
        return (x == null ? y == null ? 0 : 1 : y == null ? -1 : compareCount(x, y)) || compareCount(a.number, b.number);
      });
      const select = (pattern, block) => {
        const row = plots.get(block) ?? { block, patterns: [] };
        row.patterns.push(readInteger(pattern.number)); plots.set(block, row); selected++;
      };
      const end = Math.min(history.length, Math.max(0, Math.floor(claimableHeight) + 1));
      for (const pattern of ordered) {
        const pause = checkpoint(); if (pause) await pause;
        const excluded = taken[pattern.number] ?? new Set();
        const key = JSON.stringify([pattern.pat, pattern.fld, pattern.dt, pattern.amountMode ?? 'count']);
        let entry = cache.entry(key), amount;
        // Ascending cached matches have exactly the old block traversal order.
        if (entry) for (let i = 0; i < entry.size && selected < budget; i++) {
          const block = at(entry, i); if (block >= end) break;
          if (!excluded.has(block)) select(pattern, block);
          if ((++work & 255) === 0) { const pause = checkpoint(); if (pause) await pause; }
        }
        for (let block = entry?.scanned ?? 0; block < end && selected < budget; block++) {
          // Without caching, keep the old shortcut for excluded blocks.
          if (entry || !excluded.has(block)) {
            amount ??= compileClaimAmount(pattern);
            if (amount(history, block) !== '0') {
              if (entry && !cache.append(key, entry, block)) entry = undefined;
              if (!excluded.has(block)) select(pattern, block);
            }
          }
          if (entry) entry.scanned = block + 1;
          if ((++work & 255) === 0) { const pause = checkpoint(); if (pause) await pause; }
        }
        // An uncounted window is the sole allowed exception above the prefix.
        // Cache the usual adjacent tip too, even if taken. A distant window has
        // one separate memo; never mark the unexamined gap as scanned.
        if (selected < budget && Number.isInteger(window) && window >= end && window >= 0 && window < history.length && (entry || !excluded.has(window))) {
          const matches = entry && window < entry.scanned ? contains(entry, window)
            : entry?.window?.block === window ? entry.window.matches
            : (amount ??= compileClaimAmount(pattern))(history, window) !== '0';
          if (entry && window === entry.scanned) {
            if (matches && !cache.append(key, entry, window)) entry = undefined;
            if (entry) { entry.scanned = window + 1; entry.window = undefined; }
          } else if (entry && window >= entry.scanned) entry.window = { block: window, matches };
          if (matches && !excluded.has(window)) select(pattern, window);
        }
        if (selected >= budget) break;
      }
      return [...plots.values()].sort((a, b) => a.block - b.block)
        .map(row => ({ ...row, patterns: row.patterns.sort((a, b) => a - b) }));
    });
  };
}

export const chooseClaims = createClaimSelector();
