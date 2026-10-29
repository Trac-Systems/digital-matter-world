import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync, realpathSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validRequestId } from './mint-sender-keys.mjs';
import { check } from './util.mjs';
import { SENDER_STATES } from './mint-sender-view.mjs';

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
    const filename = join(directory, 'sender.sqlite'), marker = join(directory, 'identity.json');
    check(!existsSync(marker) || existsSync(filename), 'mint_sender_journal_missing');
    check(!existsSync(filename) || !lstatSync(filename).isSymbolicLink(), 'mint_sender_journal_path');
    check(realpathSync(join(directory, 'status')) === join(directory, 'status'), 'mint_sender_status_path');
    this.db = new DatabaseSync(filename);
    try {
      // Only this process owns this database; the gateway reads atomic JSON projections.
      this.db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
      this.db.exec('CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata(id TEXT PRIMARY KEY, value TEXT NOT NULL);');
      this.db.exec("CREATE INDEX IF NOT EXISTS requests_due ON requests(CASE json_extract(value,'$.state') WHEN 'waiting_funding' THEN 1 ELSE 0 END, COALESCE(json_extract(value,'$.nextAttempt'),0), id) WHERE json_extract(value,'$.state') NOT IN ('minted','returned');");
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
  save(row) {
    check(validRequestId(row.id) && SENDER_STATES.has(row.state), 'mint_sender_request');
    const prior = this.get(row.id);
    check(!prior || prior.payer === row.payer && prior.receiver === row.receiver && prior.address === row.address, 'mint_sender_binding_changed');
    check(!prior?.plan && !prior?.returnPlan || JSON.stringify(prior.coin) === JSON.stringify(row.coin), 'mint_sender_coin_immutable');
    check(!prior?.plan || JSON.stringify(prior.plan) === JSON.stringify(row.plan), 'mint_sender_plan_immutable');
    check(!prior?.returnPlan || JSON.stringify(prior.returnPlan) === JSON.stringify(row.returnPlan), 'mint_sender_return_immutable');
    check(!(row.plan && row.returnPlan), 'mint_sender_spend_conflict');
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
