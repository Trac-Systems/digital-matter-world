import b4a from 'b4a';
import Wallet from 'trac-wallet';
import { secp256k1 } from '@noble/curves/secp256k1';
import { BitcoinBeacon, MAINNET_PARAMS, targetFromBits } from './beacon/bitcoin.js';
import { MAINNET_CHECKPOINT } from './launch.js';
import { batchDigest, requestDigest, signingDigest, sha256, bytesToHex, hexToBytes, utf8ToBytes, jsonBytes, NETWORK } from './signing.js';
import { parseJSON } from './json.js';
import { DEFAULT_SETTINGS, SETTING_BOUNDS, validSetting, ADMIN_DELAY, PAUSE_MAX, PAUSE_COOLDOWN, MAX_ASSETS, MAX_AMOUNT_DIGITS, MAX_WIRE_BYTES, MAX_BATCH_HORIZON } from './settings.js';

export const ADDRESS = /^[0-9a-f]{64}$/;
export const ASSET = /^[0-9a-z]{1,24}$/;
const SIG = /^[0-9a-f]{128}$/;
const INSCRIPTION = /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/;
const uint = n => Number.isSafeInteger(n) && n >= 0;
const matches = (r, v) => typeof v === 'string' && r.test(v);
export const exactKeys = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const amount = v => typeof v === 'string' && v.length <= MAX_AMOUNT_DIGITS && /^[1-9][0-9]*$/.test(v);
export const assets = v => Array.isArray(v) && v.length > 0 && v.length <= MAX_ASSETS &&
  v.every(x => Array.isArray(x) && x.length === 2 && matches(ASSET, x[0]) && amount(x[1])) && new Set(v.map(x => x[0])).size === v.length;
export function validKey(v) {
  if (typeof v !== 'string' || !/^(02|03)[0-9a-f]{64}$/.test(v)) return false;
  try { secp256k1.ProjectivePoint.fromHex(v); return true; } catch { return false; }
}
export const FUNCTIONS = Object.freeze(['tf', 'hl', 'hc', 'hr', 'rx', 'hd', 'bt', 'ad_key', 'ad_set', 'ad_admin', 'ad_apply', 'ad_accept', 'ad_pause']);
const pendingIds = ['key', 'admin', ...Object.keys(SETTING_BOUNDS).map(k => `set/${k}`)];

export function validateDeployment(options) {
  if (!options || !matches(NETWORK, options.network) || !matches(ADDRESS, options.admin) || !validKey(options.committee)) throw new Error('deployment_identity');
  const { checkpoint: c, params = MAINNET_PARAMS } = options.beacon ?? { checkpoint: MAINNET_CHECKPOINT };
  if (!c || !uint(c.height) || !matches(ADDRESS, c.hash) || !uint(c.time) || !targetFromBits(c.bits) || !/^[1-9][0-9]*$/.test(c.chainwork)) throw new Error('deployment_checkpoint');
  if (!Number.isSafeInteger(params.interval) || params.interval < 1 || c.height % params.interval !== 0 ||
      !Number.isSafeInteger(params.confirmations) || params.confirmations < 1 || !uint(params.branchDepth) ||
      !Number.isSafeInteger(params.timespan) || params.timespan < 4 || params.timespan % 4 !== 0 ||
      !targetFromBits(params.powLimitBits) || typeof params.retarget !== 'boolean') throw new Error('deployment_beacon');
  if (c.times !== undefined && (!Array.isArray(c.times) || c.times.length < 1 || c.times.length > 11 || c.times.some(t => !uint(t)) || c.times.at(-1) !== c.time)) throw new Error('deployment_median');
}

export class StateTransition {
  constructor(read, options) {
    validateDeployment(options);
    this.read = read; this.options = { ...options, beacon: options.beacon ?? { checkpoint: MAINNET_CHECKPOINT, params: MAINNET_PARAMS } }; this.writes = new Map();
  }
  async get(key) { return this.writes.has(key) ? this.writes.get(key) : await this.read(key); }
  put(key, value) { this.writes.set(key, value); }
  del(key) { this.writes.set(key, undefined); }
  beacon() { return new BitcoinBeacon(this, this.options.beacon); }
  async head() {
    const b = this.beacon(), counted = await b.countedHeight(), tip = await b.tip();
    return { tip, counted, countedHash: await b.hashAt(counted), revision: await this.get('b/rev') ?? 0,
      confirmed: Math.max(this.options.beacon.checkpoint.height, tip.height - b.params.confirmations + 1) };
  }
  async settings() { return { ...DEFAULT_SETTINGS, ...await this.get('s/current') }; }
  async batchLast() { return await this.get('bt/last') ?? { n: 0, to: this.options.beacon.checkpoint.height }; }
  async admin() { return await this.get('ad/current') ?? this.options.admin; }
  async committee() { return await this.get('s/key') ?? this.options.committee; }
  async committeeEpoch() { return await this.get('s/epoch') ?? 0; }
  async paused() { return (await this.head()).counted < (await this.get('ad/pause'))?.until; }
  async pending() {
    const out = [];
    for (const id of pendingIds) { const v = await this.get(`ad/p/${id}`); if (v) out.push({ id, ...v }); }
    return out;
  }
  async agent(address, create = false) {
    if (!matches(ADDRESS, address)) return null;
    let n = await this.get(`a/${address}`);
    if (n || !create) return n ?? null;
    n = (await this.get('a/last') ?? 0) + 1;
    if (!Number.isSafeInteger(n)) throw new Error('agent_exhausted');
    this.put('a/last', n); this.put(`a/${address}`, n); this.put(`an/${n}`, address);
    return n;
  }
  async address(n) { return uint(n) && n > 0 ? await this.get(`an/${n}`) ?? null : null; }
  async balance(owner, asset) {
    if (!uint(owner) || owner < 1 || !matches(ASSET, asset)) return '0';
    const height = (await this.head()).counted;
    let value = BigInt(await this.get(`v/${owner}/${asset}`) ?? '0');
    for (const [expiry, amount] of await this.get(`e/${owner}/${asset}`) ?? []) if (height > expiry) value += BigInt(amount);
    return value.toString();
  }
  async mint(id) {
    if (!matches(ADDRESS, id)) return null;
    const m = await this.get(`m/${id}`);
    if (!m) return null;
    return m.s === 0 && !m.h && (await this.head()).counted > m.e ? { ...m, s: 2 } : m;
  }
  // At most pending_blocks.max + 1 live expiry heights exist per owner/asset.
  // Aggregation bounds reads without restricting the number of pending requests.
  async settle(owner, asset, height) {
    const key = `e/${owner}/${asset}`, old = await this.get(key) ?? [];
    let released = 0n;
    const live = [];
    for (const row of old) if (height > row[0]) released += BigInt(row[1]); else live.push(row);
    if (released) {
      this.put(`v/${owner}/${asset}`, (BigInt(await this.get(`v/${owner}/${asset}`) ?? '0') + released).toString());
      if (live.length) this.put(key, live); else this.del(key);
    }
  }
  async change(owner, asset, delta, height) {
    await this.settle(owner, asset, height);
    const key = `v/${owner}/${asset}`, next = BigInt(await this.get(key) ?? '0') + delta;
    if (next < 0n) return 'balance';
    if (next === 0n) this.del(key); else this.put(key, next.toString());
    return null;
  }
  async moveAmounts(owner, list, sign, height) {
    for (const [asset, quantity] of list) {
      const error = await this.change(owner, asset, BigInt(quantity) * sign, height);
      if (error) return error;
    }
    return null;
  }
  async escrow(owner, asset, expiry, delta) {
    const key = `e/${owner}/${asset}`, rows = (await this.get(key) ?? []).map(r => [...r]);
    const index = rows.findIndex(r => r[0] === expiry);
    const next = BigInt(index < 0 ? '0' : rows[index][1]) + delta;
    if (next < 0n) throw new Error('mint_escrow_inconsistent');
    if (index >= 0) rows.splice(index, 1);
    if (next) rows.push([expiry, next.toString()]);
    rows.sort((a, b) => a[0] - b[0]);
    if (rows.length) this.put(key, rows); else this.del(key);
  }
  async message(text, address) {
    const packet = parseJSON(text, MAX_WIRE_BYTES);
    if (!exactKeys(packet, ['network', 'op', 'value']) || packet.network !== this.options.network || !['hd', 'bt'].includes(packet.op)) return 'message';
    return this.transaction(packet.op, packet.value, address);
  }
  async transaction(type, value, address) {
    const before = new Map(this.writes);
    try {
      if (typeof type !== 'string') return 'transaction';
      if (!matches(ADDRESS, address)) return 'address';
      if (jsonBytes(value) > MAX_WIRE_BYTES) return 'size';
    } catch { return 'encoding'; }
    try {
      const error = await this.apply(type, value, address);
      if (error) this.writes = before;
      return error;
    } catch (e) { this.writes = before; throw e; }
  }
  async apply(type, value, address) {
    if (type === 'hd') {
      if (!exactKeys(value, ['headers'])) return 'headers';
      const result = await this.beacon().ingest(value.headers, address);
      return result.error ?? (result.accepted === 0 ? 'header_known' : null);
    }
    const height = (await this.head()).counted, settings = await this.settings();
    if (type === 'bt') return this.batch(value, settings, address);
    if (type.startsWith('ad_')) return this.administration(type, value, address, height);
    if (type === 'rx') return this.cancel(value, height, true);
    if (type === 'tf' || type === 'hl') {
      if (!exactKeys(value, type === 'tf' ? ['to', 'assets'] : ['to', 'assets', 'hash', 'refund']) || !matches(ADDRESS, value.to) || !assets(value.assets)) return type;
      if (type === 'hl' && (!matches(ADDRESS, value.hash) || !uint(value.refund) || value.refund < height + settings.lock_min || value.refund > height + settings.lock_max)) return 'refund_range';
      const owner = await this.agent(address);
      if (!owner) return 'balance';
      const error = await this.moveAmounts(owner, value.assets, -1n, height);
      if (error) return error;
      const to = await this.agent(value.to, true);
      if (type === 'tf') return this.moveAmounts(to, value.assets, 1n, height);
      const sequence = (await this.get('l/seq') ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) return 'lock_sequence';
      const lock = bytesToHex(signingDigest('dmw-lock-v1', this.options.network, { from: address, sequence, ...value }));
      this.put('l/seq', sequence);
      this.put(`l/${lock}`, { o: owner, to, assets: value.assets, hash: value.hash, refund: value.refund });
      return null;
    }
    if (type === 'hc' || type === 'hr') {
      if (!exactKeys(value, type === 'hc' ? ['lock', 'preimage'] : ['lock']) || !matches(ADDRESS, value.lock) || (type === 'hc' && !matches(ADDRESS, value.preimage))) return type;
      const lock = await this.get(`l/${value.lock}`);
      if (!lock) return 'lock_unknown';
      if (type === 'hc' && (height >= lock.refund || bytesToHex(sha256(hexToBytes(value.preimage))) !== lock.hash)) return 'claim';
      if (type === 'hr' && height < lock.refund) return 'refund_early';
      await this.moveAmounts(type === 'hc' ? lock.to : lock.o, lock.assets, 1n, height);
      this.del(`l/${value.lock}`); return null;
    }
    return 'transaction';
  }
  async request(type, request, sig, height) {
    const keys = type === 'xc' ? ['owner', 'in', 'out', 'nonce', 'until'] :
      ['owner', 'asset', 'amount', 'receive', 'nonce', 'until', 'expires', ...(request && Object.hasOwn(request, 'block') ? ['block'] : [])];
    if (!exactKeys(request, keys) || !matches(ADDRESS, request.owner) || !matches(ADDRESS, request.nonce) || !uint(request.until) || !matches(SIG, sig)) return 'request';
    if (height > request.until) return 'request_expired';
    if (type === 'xc' ? (!assets(request.in) || !assets(request.out)) :
      (!matches(ASSET, request.asset) || !amount(request.amount) || !matches(ADDRESS, request.receive) || (Object.hasOwn(request, 'block') && !uint(request.block)))) return 'request_assets';
    if (type === 'rq' && (!uint(request.expires) || request.expires - height < SETTING_BOUNDS.pending_blocks[0] ||
        request.expires - height > SETTING_BOUNDS.pending_blocks[1])) return 'request_expiry';
    const owner = await this.agent(request.owner);
    if (!owner) return 'request_owner';
    const nonce = `rq/n/${owner}/${request.nonce}`;
    if (await this.get(nonce)) return 'request_replay';
    if (!Wallet.verify(b4a.from(sig, 'hex'), b4a.from(requestDigest(this.options.network, type, request)), b4a.from(request.owner, 'hex'))) return 'request_signature';
    this.put(nonce, 1); return null;
  }
  async batch(batch, settings, address) {
    const keys = ['v', 'epoch', 'n', 'from', 'to', 'deadline', 'root', 'ops', 'sig', ...(batch && Object.hasOwn(batch, 'hx') ? ['hx'] : [])];
    if (!exactKeys(batch, keys) || batch.v !== 1 || !uint(batch.epoch) || !uint(batch.n) || !uint(batch.from) || !uint(batch.to) || !uint(batch.deadline) || !matches(ADDRESS, batch.root) || !matches(SIG, batch.sig) || !Array.isArray(batch.ops)) return 'batch';
    if (jsonBytes(batch) > settings.batch_bytes || batch.ops.length > settings.batch_ops) return 'batch_size';
    if (batch.epoch !== await this.committeeEpoch()) return 'batch_epoch';
    const last = await this.batchLast();
    if (batch.n !== last.n + 1 || batch.from !== last.to + 1 || batch.to < batch.from) return 'batch_sequence';
    if (!secp256k1.verify(batch.sig, batchDigest(this.options.network, batch), await this.committee(), { lowS: true, prehash: false })) return 'batch_signature';
    if (Object.hasOwn(batch, 'hx')) {
      const result = await this.beacon().ingest(batch.hx, address);
      if (result.error) return result.error;
    }
    // Combined dispatch is atomic. During a pause anyone can still use standalone hd.
    const height = (await this.head()).counted;
    if (height > batch.deadline || batch.deadline - height > MAX_BATCH_HORIZON) return 'batch_deadline';
    if (await this.paused()) return 'paused';
    if (batch.to > height) return 'batch_sequence';
    const budget = { assets: 0, kv: 0 };
    for (const op of batch.ops) { const error = await this.batchOp(op, height, settings, budget); if (error) return error; }
    this.put('bt/last', { n: batch.n, to: batch.to }); this.put(`bt/${batch.n}`, batch.root);
    return null;
  }
  async cancel(value, height, expiredOnly = false) {
    if (!exactKeys(value, ['id']) || !matches(ADDRESS, value.id)) return 'rx';
    const m = await this.get(`m/${value.id}`);
    if (!m || m.s !== 0) return 'mint_unknown';
    if (m.h) return 'mint_payment_seen';
    if (height <= m.e) return 'mint_live';
    await this.settle(m.o, m.asset, height);
    // Retain the signed request binding for late payments and rail credits.
    this.put(`m/${value.id}`, { ...m, s: 2 }); return null;
  }
  async batchOp(op, height, settings, budget) {
    if (!op || typeof op.op !== 'string') return 'operation';
    if (op.op === 'mk') {
      if (!exactKeys(op, ['op', 'to', 'asset', 'amount']) || !matches(ADDRESS, op.to) || !matches(ASSET, op.asset) || !amount(op.amount)) return 'mk';
      if (++budget.assets > settings.batch_assets) return 'batch_assets';
      await this.change(await this.agent(op.to, true), op.asset, BigInt(op.amount), height);
    } else if (op.op === 'ac') {
      if (!exactKeys(op, ['op', 'to', 'assets']) || !matches(ADDRESS, op.to) || !assets(op.assets)) return 'ac';
      budget.assets += op.assets.length;
      if (budget.assets > settings.batch_assets) return 'batch_assets';
      await this.moveAmounts(await this.agent(op.to, true), op.assets, 1n, height);
    } else if (op.op === 'xc' || op.op === 'rq') {
      if (!exactKeys(op, ['op', 'request', 'sig'])) return op.op;
      const error = await this.request(op.op, op.request, op.sig, height);
      if (error) return error;
      const r = op.request, owner = await this.agent(r.owner);
      budget.assets += op.op === 'xc' ? r.in.length + r.out.length : 1;
      if (budget.assets > settings.batch_assets) return 'batch_assets';
      const debited = await this.moveAmounts(owner, op.op === 'xc' ? r.in : [[r.asset, r.amount]], -1n, height);
      if (debited) return debited;
      if (op.op === 'xc') await this.moveAmounts(owner, r.out, 1n, height);
      else {
        const id = bytesToHex(requestDigest(this.options.network, 'rq', r)), e = r.expires;
        if (await this.get(`m/${id}`)) return 'mint_exists';
        this.put(`m/${id}`, { s: 0, o: owner, asset: r.asset, amount: r.amount, receive: r.receive, e,
          ...(Object.hasOwn(r, 'block') ? { block: r.block } : {}) });
        await this.escrow(owner, r.asset, e, BigInt(r.amount));
      }
    } else if (op.op === 'mp') {
      if (!exactKeys(op, ['op', 'id']) || !matches(ADDRESS, op.id)) return 'mp';
      const m = await this.get(`m/${op.id}`);
      if (!m || ![0, 2].includes(m.s)) return 'mint_unknown';
      if (m.h) return null;
      // A payment observed before expiry removes the timed return. A late
      // payment re-reserves from the current balance, including expired escrow.
      if (height > m.e) {
        const error = await this.moveAmounts(m.o, [[m.asset, m.amount]], -1n, height);
        if (error) return error;
      } else await this.escrow(m.o, m.asset, m.e, -BigInt(m.amount));
      await this.escrow(m.o, m.asset, Number.MAX_SAFE_INTEGER, BigInt(m.amount));
      this.put(`m/${op.id}`, { ...m, s: 0, h: true });
    } else if (op.op === 'mc') {
      if (!exactKeys(op, ['op', 'id', 'permitHash', 'payments']) || !matches(ADDRESS, op.id) || !matches(ADDRESS, op.permitHash) ||
          !Array.isArray(op.payments) || op.payments.length < 1 || op.payments.length > 64 ||
          new Set(op.payments.map(p => p?.key)).size !== op.payments.length || op.payments.some(p =>
            !exactKeys(p, ['key', 'amount', 'total']) || !matches(ADDRESS, p.key) || !amount(p.amount) || !amount(p.total) || BigInt(p.amount) > BigInt(p.total))) return 'mc';
      const m = await this.get(`m/${op.id}`);
      const paymentHash = bytesToHex(sha256(utf8ToBytes(JSON.stringify(op.payments.map(p => [p.key, p.amount, p.total])))));
      if (m?.s === 1) return m.permitHash === op.permitHash && m.paymentHash === paymentHash ? null : 'mint_consumed';
      if (!m || m.s !== 0 || !m.h) return 'mint_payment_missing';
      for (const p of op.payments) {
        const prior = await this.get(`pay/${p.key}`);
        if (prior && prior.total !== p.total) return 'payment_total_changed';
        const used = BigInt(prior?.used ?? '0') + BigInt(p.amount);
        if (used > BigInt(p.total)) return 'payment_reused';
        this.put(`pay/${p.key}`, { total: p.total, used: used.toString() });
      }
      await this.escrow(m.o, m.asset, Number.MAX_SAFE_INTEGER, -BigInt(m.amount));
      this.put(`m/${op.id}`, { ...m, s: 1, permitHash: op.permitHash, paymentHash, payments: op.payments });
    } else if (op.op === 'rl') {
      if (!exactKeys(op, ['op', 'id', 'inscription']) || !matches(ADDRESS, op.id) || !matches(INSCRIPTION, op.inscription)) return 'rl';
      const m = await this.get(`m/${op.id}`);
      if (!m || m.s !== 1 || !m.permitHash) return 'mint_not_consumed';
      if (m.inscription && m.inscription !== op.inscription) return 'mint_inscription_conflict';
      this.put(`m/${op.id}`, { ...m, inscription: op.inscription });
    } else if (op.op === 'rx') {
      if (!exactKeys(op, ['op', 'id'])) return 'rx';
      return this.cancel({ id: op.id }, height);
    } else if (op.op === 'kv') {
      if (!exactKeys(op, ['op', 'key', 'value']) || !matches(/^[a-z0-9/._-]{1,64}$/, op.key) || (op.value !== null && (typeof op.value !== 'string' || utf8ToBytes(op.value).length > 256))) return 'kv';
      if (/^(?:charter|open)(?:\/|$)/.test(op.key)) return 'kv_namespace';
      if (++budget.kv > settings.batch_kv) return 'batch_kv';
      if (op.value === null) this.del(`n/${op.key}`); else this.put(`n/${op.key}`, op.value);
    } else return 'operation';
    return null;
  }
  async administration(type, value, address, height) {
    if (!['ad_apply', 'ad_accept'].includes(type) && address !== await this.admin()) return 'admin';
    if (type === 'ad_pause') {
      if (!exactKeys(value, ['on']) || typeof value.on !== 'boolean') return 'pause';
      const pause = await this.get('ad/pause');
      if (value.on) {
        if (pause && height < pause.until) return 'pause_active';
        if (pause && height < pause.until + PAUSE_COOLDOWN) return 'pause_cooldown';
        this.put('ad/pause', { until: height + PAUSE_MAX });
      } else if (pause && height < pause.until) this.put('ad/pause', { until: height });
    } else if (type === 'ad_accept') {
      if (!exactKeys(value, ['id']) || value.id !== 'admin') return 'admin_action';
      const action = await this.get('ad/p/admin');
      if (!action) return 'admin_unknown';
      if (height < action.at) return 'admin_delay';
      if (address !== action.value) return 'admin_acceptor';
      this.put('ad/current', address);
      for (const id of pendingIds) this.del(`ad/p/${id}`);
    } else if (type === 'ad_apply') {
      if (!exactKeys(value, ['id']) || !pendingIds.includes(value.id)) return 'admin_action';
      const action = await this.get(`ad/p/${value.id}`);
      if (!action) return 'admin_unknown';
      if (height < action.at) return 'admin_delay';
      if (value.id === 'admin') return 'admin_accept_required';
      if (value.id === 'key') {
        const epoch = await this.committeeEpoch() + 1;
        if (!Number.isSafeInteger(epoch)) return 'committee_epoch_exhausted';
        this.put('s/key', action.value); this.put('s/epoch', epoch);
      } else this.put('s/current', { ...await this.get('s/current'), [value.id.slice(4)]: action.value });
      this.del(`ad/p/${value.id}`);
    } else {
      let id, proposed;
      if (type === 'ad_key' && exactKeys(value, ['key']) && validKey(value.key)) { id = 'key'; proposed = value.key; }
      else if (type === 'ad_admin' && exactKeys(value, ['address']) && matches(ADDRESS, value.address)) { id = 'admin'; proposed = value.address; }
      else if (type === 'ad_set' && exactKeys(value, ['key', 'value']) && validSetting(value.key, value.value)) { id = `set/${value.key}`; proposed = value.value; }
      else return 'admin_proposal';
      this.put(`ad/p/${id}`, { value: proposed, at: height + ADMIN_DELAY });
    }
    return null;
  }
}
