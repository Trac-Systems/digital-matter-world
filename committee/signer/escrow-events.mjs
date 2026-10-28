import { DatabaseSync } from 'node:sqlite';
import { check, equal } from './crypto.mjs';
import { keccak, ethAddress, bytes32, abiWord, TYPES } from './escrow.mjs';

const topic = signature => '0x' + keccak(Buffer.from(signature)).toString('hex');
export const ESCROW_EVENTS = Object.freeze({
  deposit: topic(`Deposited(bytes32,address,uint256,uint256,bytes32,(${TYPES.Split.map(f => f.type).join(',')}))`),
  release: topic('Released(bytes32,address,address,bytes32,uint256,address,uint256)'),
  refund: topic('Refunded(bytes32,address,address,uint256)')
});
const qty = value => '0x' + BigInt(value).toString(16);
const integer = value => { const n = Number(BigInt(value)); check(Number.isSafeInteger(n) && n >= 0, 'escrow_event_height'); return n; };
const payerWord = payer => '0x' + Buffer.from(abiWord('address', ethAddress(payer))).toString('hex');
export const ESCROW_EVENT_DEFAULTS = Object.freeze({ blockRange: 2000, pagesPerTick: 4, pageLogs: 10000, receiptLogs: 10000, receiptTransactions: 64 });
export function escrowEventSettings(input = {}) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'escrow_event_settings');
  const settings = { ...ESCROW_EVENT_DEFAULTS, ...input };
  for (const [key, value] of Object.entries(settings)) check(Object.hasOwn(ESCROW_EVENT_DEFAULTS, key) && Number.isSafeInteger(value) && value > 0, 'escrow_event_settings');
  return settings;
}

// This is an independently populated location index, never authorization. Each
// returned event is read again from its named successful receipt and canonical
// block. Its global discovery cursor survives both restarts and range budgets.
export class EscrowEvents {
  constructor({ rpc, chainId, address, fromBlock = '0x0', filename = ':memory:', blockRange = 2000, pagesPerTick = 4, pageLogs = 10000, receiptLogs = 10000, receiptTransactions = 64 }) {
    for (const n of [blockRange, pagesPerTick, pageLogs, receiptLogs, receiptTransactions]) check(Number.isSafeInteger(n) && n > 0, 'escrow_event_settings');
    Object.assign(this, { rpc, chainId, address: ethAddress(address), origin: integer(fromBlock), blockRange, pagesPerTick, pageLogs, receiptLogs, receiptTransactions });
    this.db = new DatabaseSync(filename); this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS event_domain(id INTEGER PRIMARY KEY,domain TEXT);
      CREATE TABLE IF NOT EXISTS event_checkpoints(height INTEGER PRIMARY KEY,hash TEXT);
      CREATE TABLE IF NOT EXISTS escrow_events(topic TEXT,request TEXT,payer TEXT,height INTEGER,tx TEXT,idx TEXT,log TEXT,PRIMARY KEY(tx,idx));
      CREATE INDEX IF NOT EXISTS escrow_event_key ON escrow_events(topic,request,payer);
      CREATE UNIQUE INDEX IF NOT EXISTS escrow_event_identity ON escrow_events(topic,request,payer);
      CREATE INDEX IF NOT EXISTS escrow_event_height ON escrow_events(height);`);
    const domain = JSON.stringify([chainId, this.address, this.origin]), saved = this.db.prepare('SELECT domain FROM event_domain WHERE id=1').get();
    check(!saved || saved.domain === domain, 'escrow_index_domain');
    this.db.prepare('INSERT OR IGNORE INTO event_domain VALUES(1,?)').run(domain);
    this.tail = Promise.resolve();
  }
  gate(fn) { const task = this.tail.then(fn); this.tail = task.catch(() => {}); return task; }
  log(log) {
    check(log && log.removed === false && ethAddress(log.address) === this.address && Array.isArray(log.topics) && log.topics.length >= 3 && Object.values(ESCROW_EVENTS).includes(log.topics[0]?.toLowerCase()), 'escrow_deposit_event');
    bytes32(log.topics[1]); bytes32(log.topics[2]); bytes32(log.transactionHash); bytes32(log.blockHash);
    check(/^0x[0-9a-f]+$/i.test(log.logIndex) && /^0x(?:[0-9a-f]{2})*$/i.test(log.data), 'escrow_deposit_event');
    return { ...log, topics: log.topics.map(t => t.toLowerCase()) };
  }
  put(log) {
    log = this.log(log);
    this.db.prepare('INSERT OR REPLACE INTO escrow_events VALUES(?,?,?,?,?,?,?)').run(log.topics[0], log.topics[1], log.topics[2], integer(log.blockNumber), log.transactionHash, log.logIndex, JSON.stringify(log));
  }
  async advance(toBlock) { return this.gate(async () => {
    const end = integer(toBlock); let pages = 0;
    let checkpoint = this.db.prepare('SELECT * FROM event_checkpoints ORDER BY height DESC LIMIT 1').get();
    // One rollback chunk consumes one work unit. There is no fixed reorg depth.
    while (checkpoint && (checkpoint.height > end || (await this.rpc('eth_getBlockByNumber', [qty(checkpoint.height), false]))?.hash !== checkpoint.hash)) {
      if (pages++ >= this.pagesPerTick) return false;
      const previous = this.db.prepare('SELECT * FROM event_checkpoints WHERE height<? ORDER BY height DESC LIMIT 1').get(checkpoint.height);
      this.db.exec('BEGIN');
      try {
        this.db.prepare('DELETE FROM escrow_events WHERE height>? AND height<=?').run(previous?.height ?? this.origin - 1, checkpoint.height);
        this.db.prepare('DELETE FROM event_checkpoints WHERE height=?').run(checkpoint.height); this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      checkpoint = previous;
    }
    let next = checkpoint ? checkpoint.height + 1 : this.origin;
    for (; next <= end && pages < this.pagesPerTick; pages++) {
      let stop = Math.min(end, next + this.blockRange - 1), logs, block;
      // Providers may reject a dense range. Subdivide it without moving the
      // cursor; an individually oversized block is an explicit resource error.
      for (;;) {
        block = await this.rpc('eth_getBlockByNumber', [qty(stop), false]); check(block?.hash, 'escrow_block');
        try { logs = await this.rpc('eth_getLogs', [{ address: this.address, fromBlock: qty(next), toBlock: qty(stop), topics: [Object.values(ESCROW_EVENTS)] }]); }
        catch (e) { if (stop === next) throw e; stop = next + Math.floor((stop - next) / 2); continue; }
        check(Array.isArray(logs), 'escrow_deposit_event');
        if (logs.length <= this.pageLogs) break;
        check(stop > next, 'escrow_event_page_budget'); stop = next + Math.floor((stop - next) / 2);
      }
      for (const log of logs) { this.log(log); check(integer(log.blockNumber) >= next && integer(log.blockNumber) <= stop, 'escrow_event_range'); }
      check((await this.rpc('eth_getBlockByNumber', [qty(stop), false]))?.hash === block.hash, 'escrow_event_reorg');
      if (checkpoint) check((await this.rpc('eth_getBlockByNumber', [qty(checkpoint.height), false]))?.hash === checkpoint.hash, 'escrow_event_reorg');
      this.db.exec('BEGIN');
      try { for (const log of logs) this.put(log); this.db.prepare('INSERT INTO event_checkpoints VALUES(?,?)').run(stop, block.hash); this.db.exec('COMMIT'); }
      catch (e) { this.db.exec('ROLLBACK'); throw e; }
      checkpoint = { height: stop, hash: block.hash }; next = stop + 1;
    }
    return next > end;
  }); }
  async receipt(txid, toBlock) {
    bytes32(txid);
    const receipt = await this.rpc('eth_getTransactionReceipt', [txid]);
    check(receipt?.transactionHash?.toLowerCase() === txid.toLowerCase() && BigInt(receipt.status) === 1n && Array.isArray(receipt.logs) && receipt.logs.length <= this.receiptLogs, 'escrow_event_receipt');
    check(integer(receipt.blockNumber) <= integer(toBlock) && (await this.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]))?.hash === receipt.blockHash, 'escrow_event_reorg');
    const logs = receipt.logs.filter(log => log.address?.toLowerCase() === this.address && Object.values(ESCROW_EVENTS).includes(log.topics?.[0]?.toLowerCase()));
    for (const log of logs) { this.log(log); check(log.transactionHash === receipt.transactionHash && log.blockHash === receipt.blockHash && BigInt(log.blockNumber) === BigInt(receipt.blockNumber), 'escrow_event_receipt'); }
    return logs;
  }
  async importTransactions(ids, toBlock) {
    check(Array.isArray(ids) && ids.length <= this.receiptTransactions, 'escrow_transaction_budget');
    for (const txid of new Set(ids)) for (const log of await this.receipt(txid, toBlock)) this.put(log);
  }
  async find(kind, payer, request, toBlock, txid) {
    const event = ESCROW_EVENTS[kind], id = bytes32(request), who = payerWord(payer);
    check(event, 'escrow_event_kind');
    if (txid) { const logs = await this.receipt(txid, toBlock); for (const log of logs) this.put(log); }
    const lookup = () => this.db.prepare('SELECT log FROM escrow_events WHERE topic=? AND request=? AND payer=? LIMIT 2').all(event, id, who);
    let found = lookup();
    if (!found.length) { const complete = await this.advance(toBlock); found = lookup(); check(found.length || complete, 'ethereum_index_catching_up'); }
    check(found.length === 1, 'escrow_deposit_event');
    const hint = JSON.parse(found[0].log);
    let logs;
    try { logs = await this.receipt(hint.transactionHash, toBlock); }
    catch (error) { this.db.prepare('DELETE FROM escrow_events WHERE tx=? AND idx=?').run(hint.transactionHash, hint.logIndex); throw error; }
    const matches = logs.filter(row => row.topics[0] === event && row.topics[1] === id && row.topics[2] === who);
    check(matches.length === 1, 'escrow_event_mismatch');
    const log = matches[0];
    // The identical transaction may be mined again at another height/index.
    // Replace its location only after checking that new canonical receipt.
    if (!equal(log, hint)) this.put(log);
    return log;
  }
  close() { this.db.close(); }
}
