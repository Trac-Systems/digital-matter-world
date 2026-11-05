import { join } from 'node:path';
import { atomicWrite, check, hex32, integer, privateRead, sha256 } from './check.mjs';
import { nextCursor, patternId, readInteger } from './api-values.mjs';

export const MINING_READ_SETTINGS = Object.freeze({ maxRequests: 32, cacheBytes: 64 * 1024 * 1024 });
export function miningReadSettings(overrides = {}) {
  check(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'Invalid mining read settings');
  const value = { ...MINING_READ_SETTINGS, ...overrides };
  check(Object.keys(value).every(k => Object.hasOwn(MINING_READ_SETTINGS, k)) &&
    Object.values(value).every(n => Number.isSafeInteger(n) && n > 0), 'Invalid mining read settings');
  return value;
}
const assetId = value => typeof value === 'string' && /^p2:(0|[1-9][0-9]*)$/.test(value);
const empty = () => ({ revision: null, cursor: null, complete: false, slots: new Map() });
function revision(text) {
  check(typeof text === 'string' && text.length <= 8192 && /^[A-Za-z0-9_-]+$/.test(text), 'Invalid taken revision');
  const value = JSON.parse(Buffer.from(text, 'base64url'));
  check(Array.isArray(value) && value.length === 3 && hex32(value[0]) && typeof value[1] === 'string' && /^(0|[1-9][0-9]*)$/.test(value[1]) &&
    hex32(value[2]) && Buffer.from(JSON.stringify(value)).toString('base64url') === text, 'Invalid taken revision');
  return value;
}
function slot(asset, block) {
  check(assetId(asset) && typeof block === 'string', 'Invalid taken slot');
  return [asset, readInteger(block)];
}

// The disposable file contains public exclusions only, never action state.
// Each pass reloads it so CLI/dashboard agents sharing a signer can resume each
// other's progress. Atomic replace keeps interruption from exposing half a page.
export class TakenCache {
  constructor({ directory, scope, settings, service }) {
    this.scope = scope; this.settings = miningReadSettings(settings); this.service = service;
    this.path = directory && join(directory, 'taken-slots-' + sha256(scope) + '.json');
    this.memory = empty(); this.tail = Promise.resolve();
  }
  async load() {
    if (!this.path) return this.memory;
    let bytes;
    try { bytes = await privateRead(this.path, this.settings.cacheBytes); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    try {
      const { data, hash } = JSON.parse(bytes);
      check(data?.v === 1 && data.scope === this.scope && hash === sha256(JSON.stringify(data)), 'Invalid taken cache');
      check(typeof data.complete === 'boolean' && (data.cursor === null || typeof data.cursor === 'string' && data.cursor.length <= 8192) &&
        Array.isArray(data.slots), 'Invalid taken cache');
      if (data.revision !== null) revision(data.revision);
      check(data.revision !== null || !data.complete && !data.cursor && !data.slots.length, 'Invalid taken cache');
      check(!data.cursor || !data.complete, 'Invalid taken cache');
      const state = { revision: data.revision, cursor: data.cursor, complete: data.complete, slots: new Map() };
      for (const [asset, blocks] of data.slots) {
        check(assetId(asset) && Array.isArray(blocks) && blocks.every(integer) && !state.slots.has(asset), 'Invalid taken cache');
        const set = new Set(blocks); check(set.size === blocks.length, 'Invalid taken cache'); state.slots.set(asset, set);
      }
      return state;
    } catch { return empty(); } // A corrupt/unrecognized cache cannot establish a revision chain.
  }
  async save(state) {
    if (!this.path) { this.memory = state; return; }
    const data = { v: 1, scope: this.scope, revision: state.revision, cursor: state.cursor, complete: state.complete,
      slots: [...state.slots].map(([asset, blocks]) => [asset, [...blocks]]) };
    const bytes = JSON.stringify({ data, hash: sha256(JSON.stringify(data)) });
    check(Buffer.byteLength(bytes) <= this.settings.cacheBytes, 'Taken cache exceeds configured cacheBytes');
    await atomicWrite(this.path, bytes);
  }
  sync(patterns) {
    const result = this.tail.then(() => this.update(patterns));
    this.tail = result.catch(() => {}); return result;
  }
  async update(patterns) {
    check(typeof this.service.takenSlotsPage === 'function', 'Incremental mining reads require an updated gateway client');
    let state = await this.load(), dirty = false, resets = 0;
    try {
      for (let requests = 0; requests < this.settings.maxRequests; requests++) {
        let page;
        try { page = await this.service.takenSlotsPage(state.cursor ? { cursor: state.cursor } : state.revision ? { since: state.revision } : {}); }
        catch (error) {
          if (error.status === 409 && ['taken_revision_gone', 'taken_snapshot_stale'].includes(error.code)) {
            state = empty(); dirty = true;
            if (++resets > 1) break;
            continue;
          }
          if (error.status === 404) throw Object.assign(Error('Incremental mining reads require a gateway update; retry after the gateway is updated'), { code: 'taken_reads_unavailable' });
          throw error;
        }
        check(page?.v === 1, 'Invalid taken page');
        const to = revision(page.revision);
        // A snapshot that spans new batches keeps its starting revision and names the newer
        // head; replaying the changes since then brings it to the head before any choice.
        const behind = (!state.revision || !!state.cursor) && typeof page.head === 'string' && page.head !== page.revision;
        if (!state.revision || state.cursor) {
          check(page.mode === 'snapshot' && Array.isArray(page.slots) && (!state.cursor || state.revision === page.revision), 'Invalid taken snapshot');
          const next = nextCursor(page), rows = [], seen = new Map();
          check(!next || typeof next === 'string' && next.length <= 8192 && next !== state.cursor, 'Repeated taken snapshot cursor');
          for (const group of page.slots) {
            check(Array.isArray(group) && group.length === 2 && Array.isArray(group[1]), 'Invalid taken snapshot group');
            for (const height of group[1]) {
              const [asset, block] = slot(group[0], height), blocks = seen.get(asset) ?? new Set();
              check(!blocks.has(block) && !state.slots.get(asset)?.has(block), 'Repeated taken snapshot slot');
              blocks.add(block); seen.set(asset, blocks); rows.push([asset, block]);
            }
          }
          for (const [asset, block] of rows) {
            const blocks = state.slots.get(asset) ?? new Set(); blocks.add(block); state.slots.set(asset, blocks);
          }
          state.revision = page.revision; state.cursor = next; state.complete = next === null; dirty = true;
        } else {
          check(page.mode === 'delta' && page.from === state.revision && Array.isArray(page.changes) && typeof page.more === 'boolean', 'Invalid taken delta');
          const from = revision(state.revision), rows = []; let sequence = BigInt(from[1]), hash = from[2];
          for (const change of page.changes) {
            check(Array.isArray(change) && change.length === 3 && typeof change[2] === 'boolean', 'Invalid taken change');
            const [asset, block] = slot(change[0], change[1]);
            hash = sha256(JSON.stringify([hash, String(++sequence), ...change])); rows.push([asset, block, change[2]]);
          }
          check(to[0] === from[0] && to[1] === String(sequence) && to[2] === hash && (!page.more || rows.length > 0), 'Broken taken revision chain');
          // Do not mutate any exclusions until the whole page's chain checks out.
          for (const [asset, block, found] of rows) {
            const blocks = state.slots.get(asset) ?? new Set();
            if (found) blocks.add(block); else blocks.delete(block);
            state.slots.set(asset, blocks);
          }
          dirty ||= page.revision !== state.revision || state.complete !== !page.more;
          state.revision = page.revision; state.complete = !page.more;
        }
        if (state.complete && !behind) return Object.fromEntries(patterns.map(pattern => [pattern.number, new Set(state.slots.get(patternId(pattern)) ?? [])]));
      }
      return null; // Catch up on the next pass; never choose from a partial set.
    } finally { if (dirty) await this.save(state); }
  }
}
