import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync, realpathSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validRequestId } from './mint-sender-keys.mjs';
import { check } from './util.mjs';
import { REFUND_STATES } from './mint-refund-view.mjs';
import { SENDER_STATES, BULK_SENDER_STATES } from './mint-sender-view.mjs';

export function senderJSON(path, value) {
  const temporary = path + '.tmp';
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  catch (error) { if (error.code === 'EEXIST') { unlinkSync(temporary); return senderJSON(path, value); } throw error; }
}
export class MintSenderJournal {
  constructor(directory, { keyId, network, now = Date.now } = {}) {
    this.directory = directory; this.now = now; this.keyId = keyId;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    check(realpathSync(directory) === resolve(directory) && !(lstatSync(directory).mode & 0o077), 'mint_sender_directory');
    mkdirSync(join(directory, 'status'), { recursive: true, mode: 0o700 });
    mkdirSync(join(directory, 'refunds'), { recursive: true, mode: 0o700 });
    check(realpathSync(join(directory, 'refunds')) === join(directory, 'refunds'), 'mint_sender_status_path');
    const filename = join(directory, 'sender.sqlite'), marker = join(directory, 'identity.json');
    check(!existsSync(marker) || existsSync(filename), 'mint_sender_journal_missing');
    check(!existsSync(filename) || !lstatSync(filename).isSymbolicLink(), 'mint_sender_journal_path');
    check(realpathSync(join(directory, 'status')) === join(directory, 'status'), 'mint_sender_status_path');
    this.db = new DatabaseSync(filename);
    try {
      // Only this process owns this database; the gateway reads atomic JSON projections.
      this.db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
      this.db.exec('CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata(id TEXT PRIMARY KEY, value TEXT NOT NULL);');
      this.db.exec(`CREATE TABLE IF NOT EXISTS bulk_orders(id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS bulk_due ON bulk_orders(COALESCE(json_extract(value,'$.nextAttempt'),0), id) WHERE json_extract(value,'$.state') NOT IN ('minted','returned');
        CREATE INDEX IF NOT EXISTS bulk_coin ON bulk_orders(json_extract(value,'$.coin.txid'), json_extract(value,'$.coin.vout'));`);
      this.db.exec("CREATE INDEX IF NOT EXISTS requests_due ON requests(CASE json_extract(value,'$.state') WHEN 'waiting_funding' THEN 1 ELSE 0 END, COALESCE(json_extract(value,'$.nextAttempt'),0), id) WHERE json_extract(value,'$.state') NOT IN ('minted','returned');");
      this.db.exec(`CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS refunds_due ON refunds(COALESCE(json_extract(value,'$.nextAttempt'),0), id) WHERE json_extract(value,'$.state') != 'refund_confirmed';
        CREATE INDEX IF NOT EXISTS refunds_confirmed_height ON refunds(json_extract(value,'$.evidence.height') DESC) WHERE json_extract(value,'$.state') = 'refund_confirmed';
        CREATE INDEX IF NOT EXISTS refunds_pending ON refunds(id) WHERE json_extract(value,'$.plan') IS NOT NULL AND json_extract(value,'$.state') != 'refund_confirmed';
        CREATE INDEX IF NOT EXISTS refunds_request ON refunds(json_extract(value,'$.record.id'));
        CREATE INDEX IF NOT EXISTS refunds_coin ON refunds(json_extract(value,'$.coin.txid'), json_extract(value,'$.coin.vout'));
        CREATE INDEX IF NOT EXISTS requests_coin ON requests(json_extract(value,'$.coin.txid'), json_extract(value,'$.coin.vout'));`);
      chmodSync(join(directory, 'sender.sqlite'), 0o600);
      const identity = { keyId, network }, prior = this.meta('identity');
      check(!prior || JSON.stringify(prior) === JSON.stringify(identity), 'mint_sender_journal_identity');
      this.meta('identity', identity);
      senderJSON(marker, identity);
    } catch (error) { this.db.close(); throw error; }
  }
  meta(id, value) {
    if (value === undefined) return JSON.parse(this.db.prepare('SELECT value FROM metadata WHERE id=?').get(id)?.value ?? 'null');
    this.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(id, JSON.stringify(value)); return value;
  }
  get(id) { return JSON.parse(this.db.prepare('SELECT value FROM requests WHERE id=?').get(id)?.value ?? 'null'); }
  rows() { return this.db.prepare('SELECT value FROM requests ORDER BY id').all().map(row => JSON.parse(row.value)); }
  due(limit) {
    return this.db.prepare("SELECT value FROM requests WHERE COALESCE(json_extract(value,'$.nextAttempt'),0)<=? AND json_extract(value,'$.state') NOT IN ('minted','returned') ORDER BY CASE json_extract(value,'$.state') WHEN 'waiting_funding' THEN 1 ELSE 0 END, COALESCE(json_extract(value,'$.nextAttempt'),0), id LIMIT ?")
      .all(this.now(), limit).map(r => JSON.parse(r.value));
  }
  health(stuckMs, limit) {
    const counts = Object.fromEntries(this.db.prepare("SELECT json_extract(value,'$.state') AS state, COUNT(*) AS n FROM requests GROUP BY state").all().map(r => [r.state, r.n]));
    const oldest = this.db.prepare("SELECT MIN(json_extract(value,'$.createdAt')) AS at FROM requests WHERE json_extract(value,'$.state') NOT IN ('minted','returned')").get().at;
    const stuck = this.db.prepare("SELECT value FROM requests WHERE json_extract(value,'$.coin') IS NOT NULL AND json_extract(value,'$.permitAt') IS NOT NULL AND json_extract(value,'$.revealAt') IS NULL AND json_extract(value,'$.returnReason') IS NULL AND MAX(json_extract(value,'$.permitAt'),json_extract(value,'$.fundedAt'))<=? ORDER BY id LIMIT ?")
      .all(this.now() - stuckMs, limit).map(r => JSON.parse(r.value));
    return { counts, oldestWaitingMs: oldest === null ? 0 : this.now() - oldest, stuck };
  }
  // Commits of sent ticker deploys from this funding address: their change keeps the rest of the set-aside there.
  deployCommits(address) {
    return this.db.prepare("SELECT json_extract(value,'$.plan.commitTxid') AS txid FROM requests WHERE json_extract(value,'$.tickerDeploy')=1 AND json_extract(value,'$.address')=? AND json_extract(value,'$.plan') IS NOT NULL ORDER BY id")
      .all(address).map(r => r.txid);
  }
  refund(id) { return JSON.parse(this.db.prepare('SELECT value FROM refunds WHERE id=?').get(id)?.value ?? 'null'); }
  refundDue(limit) {
    return this.db.prepare("SELECT value FROM refunds WHERE COALESCE(json_extract(value,'$.nextAttempt'),0)<=? AND json_extract(value,'$.state') != 'refund_confirmed' ORDER BY COALESCE(json_extract(value,'$.nextAttempt'),0), id LIMIT ?")
      .all(this.now(), limit).map(r => JSON.parse(r.value));
  }
  pendingRefund() {
    return JSON.parse(this.db.prepare("SELECT value FROM refunds WHERE json_extract(value,'$.plan') IS NOT NULL AND json_extract(value,'$.state') != 'refund_confirmed' ORDER BY id LIMIT 1").get()?.value ?? 'null');
  }
  lastRefundHeight() {
    return this.db.prepare("SELECT json_extract(value,'$.evidence.height') AS height FROM refunds WHERE json_extract(value,'$.state') = 'refund_confirmed' ORDER BY json_extract(value,'$.evidence.height') DESC LIMIT 1").get()?.height ?? 0;
  }
  refundCounts() {
    return Object.fromEntries(this.db.prepare("SELECT json_extract(value,'$.state') AS state, COUNT(*) AS n FROM refunds GROUP BY state").all().map(r => [r.state, r.n]));
  }
  coinOwner(coin) {
    if (!coin) return null;
    for (const [table, prefix, predicate] of [['requests', 'mint', "(json_extract(value,'$.plan') IS NOT NULL OR json_extract(value,'$.returnPlan') IS NOT NULL)"], ['refunds', 'refund', "json_extract(value,'$.plan') IS NOT NULL"], ['bulk_orders', 'bulk', "(json_extract(value,'$.plan') IS NOT NULL OR json_extract(value,'$.returnPlan') IS NOT NULL)"]]) {
      const row = this.db.prepare(`SELECT id FROM ${table} WHERE json_extract(value,'$.coin.txid')=? AND json_extract(value,'$.coin.vout')=? AND ${predicate} LIMIT 1`).get(coin.txid, coin.vout);
      if (row) return prefix + ':' + row.id;
    }
    return null;
  }
  bulk(id) { return JSON.parse(this.db.prepare('SELECT value FROM bulk_orders WHERE id=?').get(id)?.value ?? 'null'); }
  bulkDue(limit) {
    return this.db.prepare("SELECT value FROM bulk_orders WHERE COALESCE(json_extract(value,'$.nextAttempt'),0)<=? AND json_extract(value,'$.state') NOT IN ('minted','returned') ORDER BY COALESCE(json_extract(value,'$.nextAttempt'),0),id LIMIT ?")
      .all(this.now(), limit).map(row => JSON.parse(row.value));
  }
  saveBulk(row) {
    check(validRequestId(row.id) && validRequestId(row.termsHash) && BULK_SENDER_STATES.has(row.state), 'bulk_sender_record');
    const prior = this.bulk(row.id), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check(!prior || ['termsHash', 'payer', 'receiver', 'address', 'count', 'fundingSats'].every(k => prior[k] === row[k]), 'bulk_sender_binding_changed');
    check(!prior?.paymentId || prior.paymentId === row.paymentId, 'bulk_sender_receipt_changed');
    check(!prior?.permitRoot || prior.permitRoot === row.permitRoot, 'bulk_sender_permit_changed');
    check(!(row.plan && row.returnPlan), 'mint_sender_spend_conflict');
    check(!prior?.plan || same(prior.plan, row.plan), 'bulk_sender_plan_immutable');
    check(!prior?.returnPlan || same(prior.returnPlan, row.returnPlan), 'bulk_sender_return_immutable');
    check(!prior?.plan && !prior?.returnPlan || same(prior.coin, row.coin), 'bulk_sender_coin_immutable');
    if (row.plan) check(row.plan.orderId === row.id && row.plan.termsHash === row.termsHash && row.plan.permitRoot === row.permitRoot && row.plan.funding.paymentId === row.paymentId &&
      row.plan.funding.txid === row.coin?.txid && row.plan.funding.vout === row.coin?.vout && row.plan.funding.value === row.coin?.value && row.plan.reveals?.length === Math.ceil(row.count / 16), 'bulk_sender_plan_binding');
    const owner = this.coinOwner(row.coin);
    check(!(row.plan || row.returnPlan) || !owner || owner === 'bulk:' + row.id, 'mint_sender_spend_conflict');
    row = { ...row, updatedAt: this.now() };
    // SQLite synchronous=FULL commits the entire signed family to the WAL
    // before returning. No broadcast is reachable before this durable write.
    this.db.prepare('INSERT OR REPLACE INTO bulk_orders VALUES(?,?)').run(row.id, JSON.stringify(row));
    senderJSON(join(this.directory, 'status', 'bulk-' + row.id + '.json'), { keyId: this.keyId, orderId: row.id, termsHash: row.termsHash,
      mintSender: { state: row.state, sentBatches: row.sentBatches ?? 0, totalBatches: Math.ceil(row.count / 16),
        ...(row.reason ? { reason: row.reason } : {}), ...(row.plan ? { commitTxid: row.plan.commit.txid } : {}),
        ...(row.returnPlan ? { returnTxid: row.returnPlan.txid } : {}) } });
    return row;
  }
  saveRefund(row) {
    check(validRequestId(row.id) && row.id === row.record?.refundId && REFUND_STATES.has(row.state), 'mint_refund_record');
    const prior = this.refund(row.id);
    check(row.state !== 'refund_confirmed' || row.plan && Number.isSafeInteger(row.evidence?.height) && row.evidence.height >= 0, 'mint_refund_evidence');
    check(prior?.state !== 'refund_confirmed' || row.state === 'refund_confirmed' && JSON.stringify(row.evidence) === JSON.stringify(prior.evidence), 'mint_refund_evidence_immutable');
    check(!prior || JSON.stringify(prior.record) === JSON.stringify(row.record), 'mint_refund_record_changed');
    check(!prior?.plan || JSON.stringify([prior.coin, prior.plan, prior.payload, prior.amounts]) === JSON.stringify([row.coin, row.plan, row.payload, row.amounts]), 'mint_refund_plan_immutable');
    const owner = this.coinOwner(row.coin);
    check(!row.plan || !owner || owner === 'refund:' + row.id, 'mint_sender_spend_conflict');
    row = { ...row, updatedAt: this.now() };
    this.db.prepare('INSERT OR REPLACE INTO refunds VALUES(?,?)').run(row.id, JSON.stringify(row));
    senderJSON(join(this.directory, 'refunds', row.id + '.json'), { keyId: this.keyId, refundId: row.id, requestId: row.record.id, payer: row.record.tapAddress,
      delivery: { state: row.state, ...(row.message ? { message: row.message } : {}), ...(row.plan ? { revealTxid: row.evidence?.txid ?? row.plan.revealTxid, inscriptionId: row.evidence?.inscriptionId ?? row.plan.inscriptionId } : {}) } });
    return row;
  }
  save(row) {
    check(validRequestId(row.id) && SENDER_STATES.has(row.state), 'mint_sender_request');
    const prior = this.get(row.id);
    check(!prior || prior.refundReserveSats === row.refundReserveSats, 'mint_sender_refund_binding');
    check(!prior || prior.payer === row.payer && prior.receiver === row.receiver && prior.address === row.address, 'mint_sender_binding_changed');
    check(!prior?.plan && !prior?.returnPlan || JSON.stringify(prior.coin) === JSON.stringify(row.coin), 'mint_sender_coin_immutable');
    check(!prior?.plan || JSON.stringify(prior.plan) === JSON.stringify(row.plan), 'mint_sender_plan_immutable');
    check(!prior?.returnPlan || JSON.stringify(prior.returnPlan) === JSON.stringify(row.returnPlan), 'mint_sender_return_immutable');
    check(!(row.plan && row.returnPlan), 'mint_sender_spend_conflict');
    const owner = this.coinOwner(row.coin);
    check(!(row.plan || row.returnPlan) || !owner || owner === 'mint:' + row.id, 'mint_sender_spend_conflict');
    row = { ...row, updatedAt: this.now() };
    this.db.prepare('INSERT OR REPLACE INTO requests VALUES(?,?)').run(row.id, JSON.stringify(row));
    const mintSender = { state: row.state,
      ...(row.coin ? { fundingOutpoint: `${row.coin.txid}:${row.coin.vout}` } : {}),
      ...(row.plan ? { commitTxid: row.plan.commitTxid, revealTxid: row.plan.revealTxid, inscriptionId: row.plan.inscriptionId } : {}),
      ...(row.message ? { message: row.message } : {}) };
    senderJSON(join(this.directory, 'status', row.id + '.json'), { keyId: this.keyId, requestId: row.id, payer: row.payer, receiver: row.receiver, mintSender });
    return row;
  }
  close() { this.db.close(); }
}
