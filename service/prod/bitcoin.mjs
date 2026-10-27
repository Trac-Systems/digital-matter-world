import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { HttpSource, requireValue as check } from './http.mjs';
import { tapEndpoint, privatePath } from './config.mjs';
import { readTapSourceURL } from '../src/source-url.mjs';
import { GENESIS, MAINNET_PARAMS, REGTEST_PARAMS, parseHeader, targetFromBits, retargetBits } from '../../contract/beacon/bitcoin.js';
import { serial } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';
const require = createRequire(new URL('../../local/package.json', import.meta.url));
const { RawTx, RawOldTx, CompactSize } = require('@scure/btc-signer/script');
const hash256 = bytes => createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();
const hash = value => { check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'bitcoin_hash'); return value; };
const height = value => { check(Number.isSafeInteger(value) && value >= 0 && value <= 4000000, 'bitcoin_height'); return value; };
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
  Buffer.from(hash(info.previous_block ?? (info.height === 0 ? '00'.repeat(32) : null)), 'hex').reverse().copy(raw, 4);
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
  async included(id, at, history) {
    check(typeof id === 'string' && /^[0-9a-f]{64}i(0|[1-9][0-9]{0,9})$/.test(id), 'inscription_id');
    let inscription;
    try { inscription = await this.source.request('/inscription/' + id); } catch (error) { if (error.status === 404) return null; throw error; }
    check(inscription?.id === id, 'bitcoin_inscription_binding');
    const n = height(inscription.height), tip = at ? { height: height(at.tip), hash: hash(at.tipHash) } : await this.tip();
    if (n > tip.height) return null;
    // A verified linked header view is mandatory, including direct launch reads.
    let owned;
    try {
      if (!history) { owned = new BitcoinViews(this, ':memory:'); history = await owned.view(tip.height, tip.hash); }
      check(history.hashAt(tip.height) === tip.hash && history.length === tip.height + 1, 'bitcoin_view');
      const blockHash = await this.blockHash(n);
      if (history.hashAt(n) !== blockHash) return null;
      const block = await this.block(blockHash, { withTransactions: true }), tx = await this.transaction(id.slice(0, 64));
      check(block.height === n && block.tx.includes(tx.txid), 'bitcoin_tx_inclusion');
      check(block.transactions[block.tx.indexOf(tx.txid)] === tx.hex, 'bitcoin_tx_witness_binding');
      if (await this.blockHash(n) !== blockHash || await this.blockHash(tip.height) !== tip.hash) return null;
      return { height: n, blockHash, confirmations: tip.height - n + 1, tx };
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
  constructor(client, filename, { maxHeadersPerView = 4096 } = {}) {
    this.client = client; this.params = client.params ?? MAINNET_PARAMS; this.genesis = client.genesis ?? GENESIS.hash; this.maxHeadersPerView = maxHeadersPerView; this.gate = serial();
    this.db = new DatabaseSync(filename); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA cache_size=-4096; CREATE TABLE IF NOT EXISTS headers(hash TEXT PRIMARY KEY,height INTEGER,parent TEXT,raw TEXT,periodTime INTEGER,times TEXT)');
    this.get = this.db.prepare('SELECT * FROM headers WHERE hash=?'); this.put = this.db.prepare('INSERT OR IGNORE INTO headers VALUES(?,?,?,?,?,?)');
  }
  insert(raw, n, parent) {
    const h = parseHeader(raw); check(h && targetFromBits(h.bits) && targetFromBits(h.bits) <= targetFromBits(this.params.powLimitBits) && BigInt('0x' + h.hash) <= targetFromBits(h.bits), 'bitcoin_pow');
    let times = [], periodTime = h.time;
    if (n === 0) check(h.hash === this.genesis, 'bitcoin_genesis');
    else {
      check(parent && parent.height + 1 === n && parent.hash === h.prev, 'bitcoin_link');
      const previous = parseHeader(parent.raw), boundary = n % this.params.interval === 0;
      check(h.bits === (boundary && this.params.retarget ? retargetBits(previous.bits, previous.time - parent.periodTime, this.params) : previous.bits), 'bitcoin_difficulty');
      times = JSON.parse(parent.times); const sorted = [...times].sort((a, b) => a - b); check(h.time > sorted[Math.floor(sorted.length / 2)], 'bitcoin_time');
      periodTime = boundary ? h.time : parent.periodTime;
    }
    this.put.run(h.hash, n, h.prev, raw, periodTime, JSON.stringify([...times, h.time].slice(-11))); return this.get.get(h.hash);
  }
  async seed(filename) {
    await privatePath(filename); let pending = Buffer.alloc(0), n = 0, parent, resume = true;
    for await (const bytes of createReadStream(filename, { highWaterMark: 80 * 4096 })) {
      pending = Buffer.concat([pending, bytes]); let used = 0;
      this.db.exec('BEGIN');
      try {
        while (pending.length - used >= 80) {
          const raw = pending.subarray(used, used + 80);
          // Only reuse the contiguous, hash-matched prefix of our validated
          // store. A matching tip alone would miss changes earlier in the file.
          const stored = resume ? this.get.get(hash256(raw).reverse().toString('hex')) : null;
          if (stored?.height === n && (n === 0 ? stored.hash === this.genesis : stored.parent === parent.hash)) parent = stored;
          else { resume = false; parent = this.insert(raw.toString('hex'), n, parent); }
          n++; used += 80;
        }
        this.db.exec('COMMIT');
      }
      catch (e) { this.db.exec('ROLLBACK'); throw e; }
      pending = pending.subarray(used);
    }
    check(pending.length === 0 && n > 0, 'bitcoin_seed');
  }
  view(tip, tipHash) { return this.gate(async () => {
    height(tip); hash(tipHash); let cursor = tipHash, n = tip; const missing = [];
    while (!this.get.get(cursor)) {
      check(missing.length < this.maxHeadersPerView, 'bitcoin_history_seed_required');
      const raw = await this.client.header(cursor); missing.push({ n, raw }); if (n === 0) break; cursor = parseHeader(raw).prev; n--;
    }
    let parent = this.get.get(cursor);
    this.db.exec('BEGIN');
    try { for (const r of missing.reverse()) parent = this.insert(r.raw, r.n, parent); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    check(this.get.get(tipHash)?.height === tip, 'bitcoin_header_height');
    const pages = new Map(), query = this.db.prepare('WITH RECURSIVE branch AS (SELECT * FROM headers WHERE hash=? UNION ALL SELECT h.* FROM headers h JOIN branch b ON h.hash=b.parent WHERE b.height>?) SELECT height,raw FROM branch WHERE height>=? AND height<?');
    const raw = h => {
      if (!Number.isSafeInteger(h) || h < 0 || h > tip) return null;
      const start = Math.floor(h / 1024) * 1024; let page = pages.get(start);
      if (!page) { page = new Map(query.all(tipHash, start, start, start + 1024).map(r => [r.height, r.raw])); if (pages.size >= 4) pages.delete(pages.keys().next().value); pages.set(start, page); }
      check(page.has(h), 'bitcoin_history_missing'); return page.get(h);
    };
    return { length: tip + 1, raw, get: h => rules.parseHeader(raw(h), h), hashAt: h => raw(h) ? parseHeader(raw(h)).hash : null,
      field: (h, f, dt = 'n') => (f === 4 ? h : f === 10 ? rules.parseHeader(raw(h)).nonce : rules.parseHeader(raw(h)).bits).toString(dt === 'h' ? 16 : 10) };
  }); }
  close() { this.db.close(); }
}
