import crypto from 'crypto';
import b4a from 'b4a';

export const MAINNET_PARAMS = Object.freeze({ powLimitBits: 0x1d00ffff, interval: 2016, timespan: 1209600, retarget: true, confirmations: 1, branchDepth: 12 });
export const REGTEST_PARAMS = Object.freeze({ ...MAINNET_PARAMS, powLimitBits: 0x207fffff, retarget: false });
export const GENESIS = Object.freeze({ height: 0, hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', bits: 0x1d00ffff, time: 1231006505, chainwork: '4295032833' });
export function targetFromBits(bits) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) return null;
  const size = bits >>> 24;
  const word = bits & 0x007fffff;
  if (!word || (bits & 0x00800000) || size > 34 || (word > 0xff && size > 33) || (word > 0xffff && size > 32)) return null;
  const target = size <= 3 ? BigInt(word) >> BigInt(8 * (3 - size)) : BigInt(word) << BigInt(8 * (size - 3));
  return target > 0n && target < 1n << 256n ? target : null;
}
export function bitsFromTarget(target) {
  let size = Math.ceil(target.toString(16).length / 2);
  let word = size <= 3 ? Number(target << BigInt(8 * (3 - size))) : Number(target >> BigInt(8 * (size - 3)));
  if (word & 0x00800000) { word >>= 8; size++; }
  return (size * 0x1000000 + word) >>> 0;
}
export const workFor = bits => (1n << 256n) / (targetFromBits(bits) + 1n);
export function retargetBits(bits, elapsed, params = MAINNET_PARAMS) {
  const span = Math.max(params.timespan / 4, Math.min(params.timespan * 4, elapsed));
  const target = targetFromBits(bits) * BigInt(span) / BigInt(params.timespan);
  const limit = targetFromBits(params.powLimitBits);
  return bitsFromTarget(target > limit ? limit : target);
}
export function parseHeader(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{160}$/.test(hex)) return null;
  const raw = b4a.from(hex, 'hex');
  const digest = crypto.createHash('sha256').update(crypto.createHash('sha256').update(raw).digest()).digest();
  return { hash: b4a.toString(b4a.from(digest).reverse(), 'hex'), prev: b4a.toString(b4a.from(raw.subarray(4, 36)).reverse(), 'hex'),
    time: raw.readUInt32LE(68), bits: raw.readUInt32LE(72), raw: hex };
}

const pack = r => [r.height, r.prev, r.time, r.bits, r.periodTime, r.times, r.chainwork, r.poster];
const unpack = (hash, a) => a && ({ hash, height: a[0], prev: a[1], time: a[2], bits: a[3], periodTime: a[4], times: a[5], chainwork: a[6], poster: a[7] });
export const PRUNE_STEPS = 64;

// The transition owns atomicity. Headers and indexes are independent records;
// cleanup never scans all forks; branch validation is bounded by the retained window.
export class BitcoinBeacon {
  constructor(store, { checkpoint = GENESIS, params = MAINNET_PARAMS } = {}) {
    this.store = store; this.checkpoint = checkpoint; this.params = params;
  }
  async init() {
    if (await this.store.get('b/best')) return;
    const r = { ...this.checkpoint, prev: null, poster: null, periodTime: this.checkpoint.time,
      times: this.checkpoint.times ?? [this.checkpoint.time] };
    await this.save(r);
    this.store.put('b/best', r.hash); this.store.put('b/cnt', r.height);
    this.store.put(`b/h/${r.height}`, r.hash);
    this.store.put('b/gc', r.height);
  }
  async raw(hash) { return unpack(hash, await this.store.get(`b/r/${hash}`)); }
  async tip() {
    const r = await this.raw(await this.store.get('b/best')) ?? this.checkpoint;
    return { height: r.height, hash: r.hash };
  }
  async countedHeight() { return await this.store.get('b/cnt') ?? this.checkpoint.height; }
  async hashAt(height) {
    return await this.store.get(`b/h/${height}`) ?? await this.store.get(`b/u/${height}`) ?? (height === this.checkpoint.height ? this.checkpoint.hash : null);
  }
  window() { return Math.max(this.params.interval, this.params.branchDepth, this.params.confirmations); }
  async floor() { return Math.max(this.checkpoint.height, await this.countedHeight() - this.window()); }
  async record(hash) {
    const r = await this.raw(hash);
    return r && r.height >= await this.floor() ? r : null;
  }
  async save(r) {
    const head = `b/xh/${r.height}`;
    this.store.put(`b/r/${r.hash}`, pack(r));
    this.store.put(`b/x/${r.height}/${r.hash}`, await this.store.get(head) ?? null);
    this.store.put(head, r.hash);
  }
  async ingest(headers, poster) {
    if (!Array.isArray(headers) || headers.length < 1 || headers.length > 20) return { error: 'header_batch' };
    await this.init();
    let previous = null, accepted = 0;
    const counted = [];
    // As in RESET, pruning takes effect only after the complete header message.
    this.ingestFloor = await this.floor();
    for (const hex of headers) {
      const h = parseHeader(hex);
      if (!h || (previous !== null && h.prev !== previous)) return { error: 'header_link' };
      previous = h.hash;
      if (await this.ingestRecord(h.hash)) continue;
      const result = await this.add(h, poster);
      if (result.error) return result;
      accepted++; counted.push(...result.counted);
    }
    await this.prune(headers.length);
    return { accepted, counted };
  }
  async ingestRecord(hash) {
    const r = await this.raw(hash);
    return r && r.height >= this.ingestFloor ? r : null;
  }
  async add(h, poster) {
    // Cheap rejection precedes ancestry reads; direct-parent metadata covers bits/MTP.
    const target = targetFromBits(h.bits);
    if (!target || target > targetFromBits(this.params.powLimitBits) || BigInt(`0x${h.hash}`) > target) return { error: 'header_pow' };
    const parent = await this.ingestRecord(h.prev);
    if (!parent) return { error: 'header_parent' };
    const boundary = (parent.height + 1) % this.params.interval === 0;
    const expected = boundary && this.params.retarget ? retargetBits(parent.bits, parent.time - parent.periodTime, this.params) : parent.bits;
    if (h.bits !== expected) return { error: 'header_bits' };
    const times = [...parent.times].sort((a, b) => a - b);
    if (h.time <= times[Math.floor(times.length / 2)]) return { error: 'header_time' };
    const height = parent.height + 1, final = await this.countedHeight();
    const floor = await this.floor();
    let ancestor = parent;
    const path = [];
    while (ancestor && ancestor.height >= floor && ancestor.hash !== await this.hashAt(ancestor.height)) {
      path.push(ancestor); ancestor = await this.ingestRecord(ancestor.prev);
    }
    if (!ancestor || ancestor.height < floor) return { error: 'header_reorg_window' };
    const record = { ...h, height, poster, periodTime: boundary ? h.time : parent.periodTime,
      times: [...parent.times, h.time].slice(-11), chainwork: (BigInt(parent.chainwork) + workFor(h.bits)).toString() };
    await this.save(record);
    const best = await this.raw(await this.store.get('b/best'));
    const counted = [];
    if (BigInt(record.chainwork) > BigInt(best.chainwork)) {
      const next = Math.max(final, height - this.params.confirmations + 1);
      this.store.put('b/best', h.hash);
      // Rewrite the changed canonical suffix, including already counted hashes.
      // Previous batches and the monotone deadline clock are never rolled back.
      for (const r of [record, ...path]) {
        const key = `b/${r.height <= next ? 'h' : 'u'}/${r.height}`;
        if (await this.store.get(key) !== r.hash) this.store.put(key, r.hash);
        const other = `b/${r.height <= next ? 'u' : 'h'}/${r.height}`;
        if (await this.store.get(other) !== null && await this.store.get(other) !== undefined) this.store.del(other);
      }
      for (let i = height + 1; i <= best.height; i++) {
        this.store.del(`b/u/${i}`);
        if (i <= final) this.store.del(`b/h/${i}`);
      }
      for (let i = final + 1; i <= next; i++) {
        const hash = await this.hashAt(i);
        this.store.put(`b/h/${i}`, hash); this.store.del(`b/u/${i}`);
        counted.push(await this.raw(hash));
      }
      if (next !== final) this.store.put('b/cnt', next);
      if (ancestor.height < final) this.store.put('b/rev', (await this.store.get('b/rev') ?? 0) + 1);
    }
    return { counted };
  }
  async prune(headers = 1) {
    let height = await this.store.get('b/gc');
    const floor = await this.floor();
    let budget = PRUNE_STEPS * headers;
    while (height < floor && budget-- > 0) {
      const key = `b/xh/${height}`, hash = await this.store.get(key);
      if (!hash) { height++; continue; }
      const index = `b/x/${height}/${hash}`, next = await this.store.get(index);
      this.store.del(index); this.store.del(`b/r/${hash}`);
      if (next) this.store.put(key, next); else { this.store.del(key); height++; }
    }
    if (height !== await this.store.get('b/gc')) this.store.put('b/gc', height);
  }
}
