import { check } from './util.mjs';
import { validRequestId } from './mint-sender-keys.mjs';

export class MintPayoutJournal {
  constructor(journal) {
    this.journal = journal; this.db = journal.db; this.now = journal.now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS payouts(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS payouts_coin ON payouts(json_extract(value,'$.coin.txid'),json_extract(value,'$.coin.vout'));
      CREATE TABLE IF NOT EXISTS payout_window(id TEXT PRIMARY KEY,at INTEGER NOT NULL,amount TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS payout_window_time ON payout_window(at);`);
  }
  get(id) { return JSON.parse(this.db.prepare('SELECT value FROM payouts WHERE id=?').get(id)?.value ?? 'null'); }
  pending() { const id = this.journal.meta('payoutPending'); return id ? this.get(id) : null; }
  coinUsed(coin) { return !!this.db.prepare("SELECT id FROM payouts WHERE json_extract(value,'$.coin.txid')=? AND json_extract(value,'$.coin.vout')=? LIMIT 1").get(coin.txid, coin.vout); }
  daily() {
    // A short rolling window plus a point total, never the payout history.
    const expired = this.db.prepare('SELECT id,amount FROM payout_window WHERE at<=?').all(this.now() - 86400000);
    let paid = BigInt(this.journal.meta('payoutDailyPaid') ?? '0');
    if (expired.length) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of expired) { paid -= BigInt(row.amount); this.db.prepare('DELETE FROM payout_window WHERE id=?').run(row.id); }
        this.journal.meta('payoutDailyPaid', String(paid)); this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    const pending = this.pending();
    return { paid: String(paid), reserved: pending && !pending.evidence ? pending.record.amount : '0' };
  }
  save(row) {
    const prior = this.get(row.id), pending = this.pending();
    check(validRequestId(row.id) && ['prepared', 'broadcast', 'confirmed', 'recorded'].includes(row.state) && row.plan && row.record?.reference, 'mint_payout_journal');
    check(!pending || pending.id === row.id, 'mint_payout_pending');
    check(!prior || JSON.stringify([prior.record, prior.coin, prior.plan, prior.payload, prior.amounts]) ===
      JSON.stringify([row.record, row.coin, row.plan, row.payload, row.amounts]), 'mint_payout_plan_immutable');
    check(!prior?.evidence || JSON.stringify(prior.evidence) === JSON.stringify(row.evidence), 'mint_payout_evidence_immutable');
    check(!prior || ['prepared', 'broadcast', 'confirmed', 'recorded'].indexOf(row.state) >= ['prepared', 'broadcast', 'confirmed', 'recorded'].indexOf(prior.state), 'mint_payout_state');
    check(!['confirmed', 'recorded'].includes(row.state) || row.evidence && /^[0-9a-f]{64}$/.test(row.evidence.txid) && Number.isSafeInteger(row.evidence.height) && row.evidence.height >= 0, 'mint_payout_evidence');
    check(prior || !this.coinUsed(row.coin), 'mint_sender_spend_conflict');
    row = { ...row, updatedAt: this.now() };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (row.evidence && !prior?.evidence) {
        this.db.prepare('INSERT INTO payout_window VALUES(?,?,?)').run(row.id, this.now(), row.record.amount);
        this.journal.meta('payoutDailyPaid', String(BigInt(this.journal.meta('payoutDailyPaid') ?? '0') + BigInt(row.record.amount)));
        this.journal.meta('payoutLastHeight', Math.max(this.journal.meta('payoutLastHeight') ?? 0, row.evidence.height));
      }
      this.db.prepare('INSERT OR REPLACE INTO payouts VALUES(?,?)').run(row.id, JSON.stringify(row));
      this.journal.meta('payoutPending', row.state === 'recorded' ? null : row.id);
      this.db.exec('COMMIT'); return row;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
