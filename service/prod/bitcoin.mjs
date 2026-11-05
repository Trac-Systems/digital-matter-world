import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { seedChunks } from './seed-chunks.mjs';
import { seedCheckpoint } from './seed-checkpoint.mjs';
import { resolve } from 'node:path';
import { HttpSource, requireValue as check } from './http.mjs';
import { tapEndpoint, privatePath } from './config.mjs';
import { readTapSourceURL } from '../src/source-url.mjs';
import { GENESIS, MAINNET_PARAMS, REGTEST_PARAMS, parseHeader, targetFromBits, retargetBits } from '../../contract/beacon/bitcoin.js';
import { serial } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';
import { lookupSettings } from './lookup-settings.mjs';
const require = createRequire(new URL('../../local/package.json', import.meta.url));
const { RawTx, RawOldTx, CompactSize } = require('@scure/btc-signer/script');
const hash256 = bytes => createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();
const hash = value => { check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'bitcoin_hash'); return value; };
const height = value => { rules.decimalV2(value); return value; };
const u32 = value => { check(Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff, 'bitcoin_word'); return value; };
const hexBytes = value => { check(typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value) && value.length <= 8000000, 'bitcoin_hex'); return Buffer.from(value, 'hex'); };
function merkle(nodes) {
  while (nodes.length > 1) { const next = []; for (let i = 0; i < nodes.length; i += 2) next.push(hash256(Buffer.concat([nodes[i], nodes[i + 1] ?? nodes[i]]))); nodes = next; }
  return nodes[0];
}
export const REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
export function verifyMerkle(txids, raw) {
  check(Array.isArray(txids) && txids.length > 0 && txids.length <= 100000 && new Set(txids).size === txids.length, 'bitcoin_merkle');
  check(merkle(txids.map(id => Buffer.from(hash(id), 'hex').reverse())).toString('hex') === raw.slice(72, 136), 'bitcoin_merkle');
}
export function ordHeader(info, id, params = MAINNET_PARAMS) {
  check(info && info.hash === hash(id), 'bitcoin_header_binding'); height(info.height);
  const raw = Buffer.alloc(80);
  raw.writeUInt32LE(u32(info.version), 0);
  Buffer.from(hash(info.previous_block ?? (String(info.height) === '0' ? '00'.repeat(32) : null)), 'hex').reverse().copy(raw, 4);
  Buffer.from(hash(info.merkle_root), 'hex').reverse().copy(raw, 36);
  raw.writeUInt32LE(u32(info.timestamp), 68); raw.writeUInt32LE(u32(info.bits), 72); raw.writeUInt32LE(u32(info.nonce), 76);
  const encoded = raw.toString('hex'), header = parseHeader(encoded), target = targetFromBits(header.bits);
  check(header.hash === id, 'bitcoin_header_binding');
  check(target && target <= targetFromBits(params.powLimitBits) && BigInt('0x' + id) <= target, 'bitcoin_pow');
  return encoded;
}
// rust-bitcoin's human-readable serde shape, as returned by ord's /block JSON.
// Derive txids ourselves; upstream confirmation flags are never evidence.
export function ordTransaction(value) {
  try {
    check(value && Number.isInteger(value.version) && value.version >= -2147483648 && value.version <= 2147483647, 'bitcoin_transaction');
    check(Array.isArray(value.input) && value.input.length > 0 && value.input.length <= 100000 && Array.isArray(value.output) && value.output.length > 0 && value.output.length <= 100000, 'bitcoin_transaction');
    const inputs = value.input.map(i => {
      check(typeof i.previous_output === 'string' && /^[0-9a-f]{64}:(0|[1-9][0-9]*)$/.test(i.previous_output), 'bitcoin_outpoint');
      const [txid, index] = i.previous_output.split(':');
      return { txid: Buffer.from(txid, 'hex'), index: u32(Number(index)), finalScriptSig: hexBytes(i.script_sig), sequence: u32(i.sequence) };
    });
    const outputs = value.output.map(o => { check(Number.isSafeInteger(o.value) && o.value >= 0 && o.value <= 2100000000000000, 'bitcoin_amount'); return { amount: BigInt(o.value), script: hexBytes(o.script_pubkey) }; });
    const witnesses = value.input.map(i => { check(Array.isArray(i.witness) && i.witness.length <= 100000, 'bitcoin_witness'); return i.witness.map(hexBytes); });
    const segwitFlag = witnesses.some(w => w.length > 0);
    const raw = RawTx.encode({ version: value.version, lockTime: u32(value.lock_time), inputs, outputs, segwitFlag, witnesses: segwitFlag ? witnesses : undefined });
    check(raw.length <= 4000000, 'bitcoin_transaction'); return Buffer.from(raw).toString('hex');
  } catch { throw Error('bitcoin_transaction_shape'); }
}
export class BitcoinSource {
  #inclusionBlocks = new Map(); #inclusionBytes = 0; #inclusionFlights = new Map();
  #inclusionProofs = new Map(); #proofBytes = 0;
  constructor({ kind = 'ord', source, network = 'mainnet' }) {
    check(kind === 'ord' && ['mainnet', 'regtest'].includes(network), 'bitcoin_source');
    Object.assign(this, { kind, source, network, params: network === 'mainnet' ? MAINNET_PARAMS : REGTEST_PARAMS, genesis: network === 'mainnet' ? GENESIS.hash : REGTEST_GENESIS });
  }
  async verifyNetwork() { check(await this.blockHash(0) === this.genesis, 'bitcoin_network'); await this.header(this.genesis); }
  async tip() {
    const n = height(await this.source.request('/r/blockheight')), id = await this.blockHash(n);
    const info = await this.headerInfo(id);
    check(info.height === n && await this.source.request('/r/blockheight') === n && await this.source.request('/r/blockhash') === id && await this.blockHash(n) === id, 'bitcoin_tip_changed');
    return { height: n, hash: id };
  }
  async blockHash(n) { return hash(await this.source.request('/r/blockhash/' + height(n))); }
  async headerInfo(id) {
    const info = await this.source.request('/r/blockinfo/' + hash(id));
    return { ...info, raw: ordHeader(info, id, this.params) };
  }
  async header(id) { return (await this.headerInfo(id)).raw; }
  async block(id, { withTransactions = false } = {}) {
    const info = await this.headerInfo(hash(id)), block = await this.source.request('/block/' + id);
    check(block?.hash === id && height(block.height) === info.height && Array.isArray(block.transactions) && block.transactions.length > 0 && block.transactions.length <= 100000 && block.transactions.length === info.transaction_count, 'bitcoin_block');
    let bytes = 80 + CompactSize.encode(block.transactions.length).length, weight = bytes * 4;
    const raws = block.transactions.map(value => {
      const raw = ordTransaction(value), decoded = RawTx.decode(Buffer.from(raw, 'hex'));
      bytes += raw.length / 2; weight += raw.length / 2 + 3 * RawOldTx.encode(decoded).length;
      check(bytes <= 4000000 && weight <= 4000000, 'bitcoin_raw_block'); return raw;
    });
    const tx = raws.map(raw => this.decode(raw).txid);
    verifyMerkle(tx, info.raw);
    const coinbase = block.transactions[0], commitment = coinbase.output.filter(o => /^6a24aa21a9ed[0-9a-f]{64}/.test(o.script_pubkey)).at(-1);
    if (commitment) {
      check(coinbase.input.length === 1 && coinbase.input[0].witness.length === 1 && /^[0-9a-f]{64}$/.test(coinbase.input[0].witness[0]), 'bitcoin_witness_commitment');
      const root = merkle(raws.map((raw, i) => i === 0 ? Buffer.alloc(32) : hash256(Buffer.from(raw, 'hex'))));
      check(hash256(Buffer.concat([root, Buffer.from(coinbase.input[0].witness[0], 'hex')])).toString('hex') === commitment.script_pubkey.slice(12, 76), 'bitcoin_witness_commitment');
    } else check(block.transactions.every(t => t.input.every(i => i.witness.length === 0)), 'bitcoin_witness_commitment');
    return { hash: id, height: info.height, tx, raw: info.raw, ...(withTransactions ? { transactions: raws } : {}) };
  }
  async rawBlock(id) {
    const block = await this.block(id, { withTransactions: true });
    return Buffer.concat([Buffer.from(block.raw, 'hex'), Buffer.from(CompactSize.encode(block.tx.length)), ...block.transactions.map(raw => Buffer.from(raw, 'hex'))]);
  }
  decode(raw) {
    try {
      const bytes = hexBytes(raw); check(bytes.length > 0, 'bitcoin_transaction');
      const tx = RawTx.decode(bytes); check(Buffer.from(RawTx.encode(tx)).equals(bytes), 'bitcoin_transaction');
      const txid = hash256(RawOldTx.encode(tx)).reverse().toString('hex');
      return { txid, vin: tx.inputs.map(i => ({ txid: Buffer.from(i.txid).toString('hex'), vout: i.index })), hex: raw };
    } catch { throw Error('bitcoin_transaction'); }
  }
  async transaction(id) {
    const tx = this.decode(await this.source.request('/r/tx/' + hash(id)));
    check(tx.txid === id, 'bitcoin_tx_binding'); return tx;
  }
  async inclusionBlock(id) {
    const cached = this.#inclusionBlocks.get(id);
    if (cached) {
      this.#inclusionBlocks.delete(id); this.#inclusionBlocks.set(id, cached);
      return cached.block;
    }
    let pending = this.#inclusionFlights.get(id);
    if (!pending) {
      // Membership and witness commitments are immutable under a block hash.
      // Keep only independently verified blocks, shared across financial scopes
      // and retries. Canonical membership is still checked on every inclusion.
      pending = this.block(id, { withTransactions: true }).then(value => {
        const block = Object.freeze({ ...value, tx: Object.freeze([...value.tx]), transactions: Object.freeze([...value.transactions]) });
        // Count UTF-16 string storage conservatively, plus per-transaction
        // overhead; bound both retained bytes and outstanding cache entries.
        const bytes = 2 * (block.raw.length + block.transactions.reduce((sum, raw) => sum + raw.length, 0)) + block.tx.length * 256;
        const limit = 16_000_000;
        if (bytes <= limit) {
          const previous = this.#inclusionBlocks.get(id);
          if (previous) { this.#inclusionBytes -= previous.bytes; this.#inclusionBlocks.delete(id); }
          while (this.#inclusionBlocks.size && (this.#inclusionBlocks.size >= 4 || this.#inclusionBytes + bytes > limit)) {
            const first = this.#inclusionBlocks.keys().next().value;
            this.#inclusionBytes -= this.#inclusionBlocks.get(first).bytes; this.#inclusionBlocks.delete(first);
          }
          this.#inclusionBlocks.set(id, { block, bytes }); this.#inclusionBytes += bytes;
        }
        return block;
      }).finally(() => { if (this.#inclusionFlights.get(id) === pending) this.#inclusionFlights.delete(id); });
      if (this.#inclusionFlights.size < 4) this.#inclusionFlights.set(id, pending);
    }
    return pending;
  }
  #rememberInclusion(key, value) {
    // Retain compact transaction membership after its full block is evicted.
    // A batch spanning many blocks must not download them all on every retry.
    const bytes = value.hex.length * 2 + 512, limit = 16_000_000;
    if (bytes > limit) return;
    const previous = this.#inclusionProofs.get(key);
    if (previous) { this.#proofBytes -= previous.bytes; this.#inclusionProofs.delete(key); }
    while (this.#inclusionProofs.size && (this.#inclusionProofs.size >= 512 || this.#proofBytes + bytes > limit)) {
      const first = this.#inclusionProofs.keys().next().value;
      this.#proofBytes -= this.#inclusionProofs.get(first).bytes; this.#inclusionProofs.delete(first);
    }
    this.#inclusionProofs.set(key, { value, bytes }); this.#proofBytes += bytes;
  }
  async included(id, at, history) {
    check(typeof id === 'string' && /^[0-9a-f]{64}i(0|[1-9][0-9]{0,9})$/.test(id), 'inscription_id');
    let inscription;
    try { inscription = await this.source.request('/inscription/' + id); } catch (error) { if (error.status === 404) return null; throw error; }
    check(inscription?.id === id, 'bitcoin_inscription_binding');
    const n = height(inscription.height), tip = at ? { height: height(at.tip), hash: hash(at.tipHash) } : await this.tip();
    if (rules.compareOrdinal(n, tip.height) > 0) return null;
    // A verified linked header view is mandatory, including direct launch reads.
    let owned;
    try {
      if (!history) { owned = new BitcoinViews(this, ':memory:'); history = await owned.view(tip.height, tip.hash); }
      check(history.hashAt(tip.height) === tip.hash && String(history.length) === rules.nextUint(rules.decimalV2(tip.height)), 'bitcoin_view');
      const blockHash = await this.blockHash(n);
      if (history.hashAt(n) !== blockHash) return null;
      const key = blockHash + '/' + id.slice(0, 64), proof = this.#inclusionProofs.get(key);
      let tx;
      if (proof) {
        tx = await this.transaction(id.slice(0, 64));
        check(proof.value.height === n, 'bitcoin_tx_inclusion');
        check(proof.value.hex === tx.hex, 'bitcoin_tx_witness_binding');
        // Other inclusions may have evicted this entry while the fresh raw
        // transaction was in flight. Reinsert through the accounting gate.
        this.#rememberInclusion(key, proof.value);
      } else {
        const block = await this.inclusionBlock(blockHash);
        tx = await this.transaction(id.slice(0, 64));
        check(block.height === n && block.tx.includes(tx.txid), 'bitcoin_tx_inclusion');
        check(block.transactions[block.tx.indexOf(tx.txid)] === tx.hex, 'bitcoin_tx_witness_binding');
        this.#rememberInclusion(key, { height: n, hex: tx.hex });
      }
      if (await this.blockHash(n) !== blockHash || await this.blockHash(tip.height) !== tip.hash) return null;
      return { height: n, blockHash, confirmations: typeof tip.height === 'string' || typeof n === 'string' ? String(BigInt(tip.height) - BigInt(n) + 1n) : tip.height - n + 1, tx };
    } finally { owned?.close(); }
  }
}
export async function createBitcoin(config, policy, { network = 'mainnet' } = {}) {
  check(config?.kind === 'ord' && typeof config.urlFile === 'string' && config.urlFile.length > 0 && !config.url && !config.authFile && !config.tokenFile, 'bitcoin_source');
  const endpoint = network === 'mainnet' ? await tapEndpoint(config) : { url: await readTapSourceURL(config.urlFile) };
  const fetchImpl = globalThis.fetch[Symbol.for('dmw.localFetch')] ?? globalThis.fetch;
  const client = new BitcoinSource({ source: new HttpSource({ ...policy, ...endpoint, fetchImpl, maxBytes: 16000000 }), network });
  await client.verifyNetwork(); return client;
}
// Branches are immutable by hash. Header verification includes PoW, mainnet
// difficulty transitions and median time, including the offline seed history.
export class BitcoinViews {
  constructor(client, filename, { maxHeadersPerView = 4096, settings, integerVersion = 1 } = {}) {
    check(Number.isSafeInteger(maxHeadersPerView) && maxHeadersPerView > 0, 'bitcoin_work_budget');
    this.decimal = integerVersion === 2; this.limits = lookupSettings(settings);
    this.filename = filename === ':memory:' ? null : resolve(filename);
    this.client = client; this.params = client.params ?? MAINNET_PARAMS; this.genesis = client.genesis ?? GENESIS.hash; this.maxHeadersPerView = maxHeadersPerView; this.gate = serial();
    this.db = new DatabaseSync(filename);
    if (this.decimal) {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA cache_size=-${this.limits.headerCacheKiB};
        CREATE TABLE IF NOT EXISTS decimal_headers(hash TEXT PRIMARY KEY,height TEXT NOT NULL,parent TEXT NOT NULL,raw TEXT NOT NULL,periodTime INTEGER NOT NULL,times TEXT NOT NULL,jumps TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS decimal_catchup(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decimal_pending(position TEXT PRIMARY KEY,height TEXT NOT NULL,hash TEXT NOT NULL,raw TEXT NOT NULL) WITHOUT ROWID;`);
      this.get = this.db.prepare('SELECT * FROM decimal_headers WHERE hash=?'); this.put = this.db.prepare('INSERT OR IGNORE INTO decimal_headers VALUES(?,?,?,?,?,?,?)');
    } else { this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA cache_size=-${this.limits.headerCacheKiB};
      CREATE TABLE IF NOT EXISTS headers(hash TEXT PRIMARY KEY,height INTEGER,parent TEXT,raw TEXT,periodTime INTEGER,times TEXT);
      CREATE TABLE IF NOT EXISTS catchup(id INTEGER PRIMARY KEY CHECK(id=1),target TEXT,height INTEGER,cursor TEXT,nextHeight INTEGER,phase TEXT);
      CREATE TABLE IF NOT EXISTS catchup_headers(height INTEGER PRIMARY KEY,hash TEXT,raw TEXT);`);
    this.get = this.db.prepare('SELECT * FROM headers WHERE hash=?'); this.put = this.db.prepare('INSERT OR IGNORE INTO headers VALUES(?,?,?,?,?,?)'); }
  }
  seedKey(path) { return this.decimal ? 'integer2:' + path : path; }
  ordinal(value) { const n = rules.decimalV2(value); if (this.decimal) return n; const valueNumber = Number(n); check(Number.isSafeInteger(valueNumber), 'bitcoin_height'); return valueNumber; }
  job() { return this.decimal ? JSON.parse(this.db.prepare('SELECT value FROM decimal_catchup WHERE id=1').get()?.value ?? 'null') : this.db.prepare('SELECT * FROM catchup WHERE id=1').get(); }
  saveJob(job) {
    if (this.decimal) this.db.prepare('INSERT OR REPLACE INTO decimal_catchup VALUES(1,?)').run(JSON.stringify(job));
    else this.db.prepare('INSERT OR REPLACE INTO catchup VALUES(1,?,?,?,?,?)').run(job.target, job.height, job.cursor, job.nextHeight, job.phase);
  }
  clearJob() { this.db.exec('DELETE FROM ' + (this.decimal ? 'decimal_catchup' : 'catchup')); }
  insert(raw, n, parent) {
    n = this.ordinal(n);
    const h = parseHeader(raw); check(h && targetFromBits(h.bits) && targetFromBits(h.bits) <= targetFromBits(this.params.powLimitBits) && BigInt('0x' + h.hash) <= targetFromBits(h.bits), 'bitcoin_pow');
    let times = [], periodTime = h.time, jumps = [];
    if (String(n) === '0') check(h.hash === this.genesis, 'bitcoin_genesis');
    else {
      check(parent && BigInt(parent.height) + 1n === BigInt(n) && parent.hash === h.prev, 'bitcoin_link');
      const previous = parseHeader(parent.raw), boundary = BigInt(n) % BigInt(this.params.interval) === 0n;
      check(h.bits === (boundary && this.params.retarget ? retargetBits(previous.bits, previous.time - parent.periodTime, this.params) : previous.bits), 'bitcoin_difficulty');
      times = JSON.parse(parent.times); const sorted = [...times].sort((a, b) => a - b); check(h.time > sorted[Math.floor(sorted.length / 2)], 'bitcoin_time');
      periodTime = boundary ? h.time : parent.periodTime;
    }
    if (this.decimal && parent) {
      jumps.push(parent.hash);
      for (let level = 0; ; level++) {
        const ancestor = this.get.get(jumps[level]); check(ancestor, 'bitcoin_history_missing');
        const older = JSON.parse(ancestor.jumps)[level]; if (!older) break; jumps.push(older);
      }
    }
    const old = this.get.get(h.hash); check(!old || old.height === n && old.raw === raw, 'bitcoin_header_height');
    this.put.run(h.hash, n, h.prev, raw, periodTime, JSON.stringify([...times, h.time].slice(-11)), ...(this.decimal ? [JSON.stringify(jumps)] : [])); return this.get.get(h.hash);
  }
  async seed(filename, options) {
    await privatePath(filename); return this.gate(() => seedCheckpoint(this, filename, options));
  }
  async seedChunks(options) {
    await privatePath(options.manifestFile); await privatePath(options.directory, { directory: true });
    return this.gate(() => seedChunks(this, options));
  }
  // A long missing branch first spools backwards on disk, then verifies forwards
  // from the known ancestor. Neither phase loses its cursor on a budget yield or
  // restart. Only fully linked/PoW/difficulty/time-verified rows enter headers.
  async catchUp(tip, tipHash) {
    let job = this.job();
    if (job && job.target !== tipHash && job.phase !== 'discard' && this.client.blockHash) {
      let canonical;
      try { canonical = await this.client.blockHash(job.height); }
      catch (error) { if (error.status !== 404) throw error; }
      if (canonical !== job.target) {
        job.phase = 'discard'; this.saveJob(job);
      }
    }
    if (job?.phase === 'discard') {
      const table = this.decimal ? 'decimal_pending' : 'catchup_headers', key = this.decimal ? 'position' : 'height';
      this.db.prepare(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} LIMIT ?)`).run(this.maxHeadersPerView);
      if (!this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) this.clearJob();
      return false;
    }
    if (!job) {
      job = { target: tipHash, height: tip, cursor: tipHash, nextHeight: tip, phase: 'fetch' }; this.saveJob(job);
    }
    const save = () => this.saveJob(job);
    let work = 0;
    while (job.phase === 'fetch') {
      const known = this.get.get(job.cursor);
      if (known || BigInt(job.nextHeight) < 0n) {
        check(!known || known.height === job.nextHeight, 'bitcoin_header_height');
        job.phase = 'verify'; job.nextHeight = this.ordinal(String(BigInt(job.nextHeight) + 1n)); save(); break;
      }
      if (work++ >= this.maxHeadersPerView) return false;
      const info = this.client.headerInfo ? await this.client.headerInfo(job.cursor) : null;
      check(!info || rules.decimalV2(info.height) === rules.decimalV2(job.nextHeight), 'bitcoin_header_height');
      const raw = info?.raw ?? await this.client.header(job.cursor), h = parseHeader(raw), target = h && targetFromBits(h.bits);
      check(target && target <= targetFromBits(this.params.powLimitBits) && BigInt('0x' + h.hash) <= target, 'bitcoin_pow');
      check(h?.hash === job.cursor, 'bitcoin_header_binding');
      this.db.exec('BEGIN');
      try {
        if (this.decimal) this.db.prepare('INSERT OR REPLACE INTO decimal_pending VALUES(?,?,?,?)').run(rules.uintKeyV2(job.nextHeight), job.nextHeight, h.hash, raw);
        else this.db.prepare('INSERT INTO catchup_headers VALUES(?,?,?)').run(job.nextHeight, h.hash, raw);
        job.cursor = h.prev; job.nextHeight = this.decimal ? String(BigInt(job.nextHeight) - 1n) : job.nextHeight - 1; save(); this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    if (work >= this.maxHeadersPerView) return false;
    const rows = this.decimal ? this.db.prepare('SELECT * FROM decimal_pending WHERE position>=? ORDER BY position LIMIT ?').all(rules.uintKeyV2(job.nextHeight), this.maxHeadersPerView - work) : this.db.prepare('SELECT * FROM catchup_headers WHERE height>=? ORDER BY height LIMIT ?').all(job.nextHeight, this.maxHeadersPerView - work);
    let parent = this.get.get(job.cursor);
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        check(row.height === job.nextHeight, 'bitcoin_history_missing');
        parent = this.insert(row.raw, row.height, parent);
        job.cursor = parent.hash; job.nextHeight = this.ordinal(String(BigInt(job.nextHeight) + 1n));
        if (this.decimal) this.db.prepare('DELETE FROM decimal_pending WHERE position=?').run(row.position);
        else this.db.prepare('DELETE FROM catchup_headers WHERE height=?').run(row.height);
      }
      if (BigInt(job.nextHeight) > BigInt(job.height)) {
        check(parent?.hash === job.target, 'bitcoin_header_binding');
        this.clearJob();
      } else save();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return BigInt(job.nextHeight) > BigInt(job.height);
  }
  view(tip, tipHash) { return this.gate(async () => {
    tip = this.ordinal(tip); hash(tipHash);
    if (!this.get.get(tipHash)) {
      let complete;
      try { complete = await this.catchUp(tip, tipHash); }
      catch (error) {
        if (['bitcoin_pow', 'bitcoin_header_binding', 'bitcoin_header_height', 'bitcoin_genesis', 'bitcoin_link', 'bitcoin_difficulty', 'bitcoin_time', 'bitcoin_history_missing'].includes(error.message))
          { const job = this.job(); if (job) { job.phase = 'discard'; this.saveJob(job); } }
        throw error;
      }
      // Finishing an older target is useful even when the observed tip advanced.
      // The next tick starts its suffix; never exceed this call's work budget.
      check(complete && this.get.get(tipHash), 'bitcoin_history_catching_up');
    }
    check(this.get.get(tipHash)?.height === tip, 'bitcoin_header_height');
    if (this.decimal) {
    const cache = new Map(), raw = height => {
      height = rules.decimalV2(height); if (rules.compareUint(height, tip) > 0) return null;
      if (cache.has(height)) return cache.get(height);
      let row = this.get.get(tipHash);
      while (row.height !== height) {
        const distance = BigInt(row.height) - BigInt(height), jumps = JSON.parse(row.jumps);
        const level = Math.min(distance.toString(2).length - 1, jumps.length - 1); check(level >= 0, 'bitcoin_history_missing');
        const ancestor = this.get.get(jumps[level]);
        check(ancestor && BigInt(row.height) - BigInt(ancestor.height) === 1n << BigInt(level), 'bitcoin_ancestry'); row = ancestor;
      }
      if (cache.size >= this.limits.headerCachePages * this.limits.headerPageRows) cache.delete(cache.keys().next().value);
      cache.set(height, row.raw); return row.raw;
    };
    return { length: rules.nextUint(tip), raw, get: h => rules.parseHeader(raw(h), rules.decimalV2(h)), hashAt: h => raw(h) ? parseHeader(raw(h)).hash : null,
      field: (h, f, dt = 'n') => f === 4 ? rules.decimalV2(h) : (f === 10 ? rules.parseHeader(raw(h)).nonce : rules.parseHeader(raw(h)).bits).toString(dt === 'h' ? 16 : 10) };
    }
    const pages = new Map(), query = this.db.prepare('WITH RECURSIVE branch AS (SELECT * FROM headers WHERE hash=? UNION ALL SELECT h.* FROM headers h JOIN branch b ON h.hash=b.parent WHERE b.height>?) SELECT height,raw FROM branch WHERE height>=? AND height<?');
    const raw = h => {
      if (!Number.isSafeInteger(h) || h < 0 || h > tip) return null;
      const start = Math.floor(h / this.limits.headerPageRows) * this.limits.headerPageRows; let page = pages.get(start);
      if (!page) { page = new Map(query.all(tipHash, start, start, start + this.limits.headerPageRows).map(r => [r.height, r.raw])); if (pages.size >= this.limits.headerCachePages) pages.delete(pages.keys().next().value); pages.set(start, page); }
      check(page.has(h), 'bitcoin_history_missing'); return page.get(h);
    };
    // Offline migration hashes the complete archive. Walk the verified branch
    // once; repeated named lookups would retraverse ancestry for every page.
    const branch = this.db.prepare('WITH RECURSIVE branch AS (SELECT height,parent,raw FROM headers WHERE hash=? UNION ALL SELECT h.height,h.parent,h.raw FROM headers h JOIN branch b ON h.hash=b.parent WHERE b.height>0) SELECT height,raw FROM branch WHERE height<=? ORDER BY height');
    const rawRange = function* (through = tip) {
      check(Number.isSafeInteger(through) && through >= 0 && through <= tip, 'bitcoin_header_height');
      let next = 0;
      for (const row of branch.iterate(tipHash, through)) { check(row.height === next++, 'bitcoin_history_missing'); yield row.raw; }
      check(next === through + 1, 'bitcoin_history_missing');
    };
    return { ...(this.filename ? { replaySource: { filename: this.filename, tip, tipHash } } : {}),
      length: tip + 1, raw, rawRange, get: h => rules.parseHeader(raw(h), h), hashAt: h => raw(h) ? parseHeader(raw(h)).hash : null,
      field: (h, f, dt = 'n') => (f === 4 ? h : f === 10 ? rules.parseHeader(raw(h)).nonce : rules.parseHeader(raw(h)).bits).toString(dt === 'h' ? 16 : 10) };
  }); }
  close() { this.db.close(); }
}
