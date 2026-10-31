import { payoutFloatKey, validDestination, validRequestId } from './mint-sender-keys.mjs';
import { tokenAuth, atomicAmount } from './mint-refund-protocol.mjs';
import { buildAuthorityTap } from './mint-refund-sender.mjs';
import { MintPayoutJournal } from './mint-payout-journal.mjs';
import { buildInscription, signCommit } from '../../kit/lib/inscription-core.mjs';
import { check, hash } from './util.mjs';
import { mintSenderError } from './mint-sender-errors.mjs';
import { rules } from './rules.mjs';

export class MintPayoutSender {
  constructor(sender) {
    for (const name of ['seed', 'network', 'settings', 'journal', 'gateway', 'bitcoin', 'now', 'log', 'keyId']) this[name] = sender[name];
    this.tap = this.bitcoin.tap; this.payments = new MintPayoutJournal(this.journal);
    const key = payoutFloatKey(this.seed, this.network); this.address = key.address; key.privateKey.fill(0);
    this.float = { address: this.address, balances: null, btcSats: null, authority: { state: 'unknown' } };
    this.lastFloat = 0; this.lastDiscovery = 0;
    this.queuedCount = this.journal.meta('payoutQueuedCount') ?? null;
    this.waiting = this.journal.meta('payoutWaiting');
  }
  wait(code, message, beneficiary) {
    this.waiting = { code, message, ...(beneficiary ? { beneficiary } : {}), at: this.now() };
    this.journal.meta('payoutWaiting', this.waiting);
    this.log({ event: 'mint_payout_waiting', ...this.waiting });
  }
  clearWait() { this.waiting = null; this.journal.meta('payoutWaiting', null); }
  async refreshFloat() {
    const result = await this.tap.float(this.address, this.journal.meta('payoutAuthority'));
    const coins = await this.bitcoin.utxos(this.address);
    this.float = { ...result.value, btcSats: String(coins.reduce((n, c) => n + BigInt(c.value), 0n)), snapshot: result.snapshot, checkedAt: this.now() };
    this.lastFloat = this.now(); return this.float;
  }
  status() {
    const daily = this.payments.daily(), pending = this.payments.pending();
    return { enabled: this.settings.payoutsEnabled, float: this.float, paid24hAtoms: daily.paid, reservedAtoms: daily.reserved,
      dailyCapAtoms: this.settings.payoutDailyCapAtoms, maxAtoms: this.settings.payoutMaxAtoms,
      queuedCount: this.queuedCount, queueMeaning: 'outstanding_beneficiaries_including_below_minimum',
      discoveryAt: this.lastDiscovery || null, waiting: this.waiting,
      alarm: !!this.waiting || !!pending && this.now() - pending.createdAt >= this.settings.stuckMs || this.settings.payoutsEnabled &&
        (this.float.authority.state !== 'active' || !this.lastFloat || this.now() - this.lastFloat > this.settings.heartbeatMaxAgeMs),
      pending: pending ? { reference: pending.record.reference, beneficiary: pending.record.beneficiary, amount: pending.record.amount,
        state: pending.state, txid: pending.evidence?.txid ?? pending.plan.revealTxid } : null };
  }
  async createAuthority() {
    await this.bitcoin.verifyNetwork();
    let authority = this.journal.meta('payoutAuthority');
    if (!authority) {
      const key = payoutFloatKey(this.seed, this.network);
      try {
        const payload = tokenAuth(['tap'], 'auth', key.privateKey, hash('dmw-payout-authority-v1|' + this.network + '|' + this.address));
        const coins = await this.tap.cardinal(await this.bitcoin.utxos(this.address)), feeRate = await this.bitcoin.feeRate();
        check(Number.isFinite(feeRate) && feeRate >= 1 && feeRate <= this.settings.maxRefundFeeRate, 'mint_payout_fee');
        const plan = signCommit(buildInscription({ text: JSON.stringify(payload), receiver: this.address, publicKey: key.publicKey, network: this.network,
          utxos: coins, feeRate, maxFeeSats: String(this.settings.maxFeeSats), postage: this.settings.postageSats, dustSats: this.settings.dustSats }), key.privateKey);
        authority = { payload, plan, tapPlan: buildAuthorityTap(plan, key, this.network, this.settings) };
        this.journal.meta('payoutAuthority', authority);
      } finally { key.privateKey.fill(0); }
    }
    await this.bitcoin.broadcast(authority.plan.commitHex, authority.plan.commitTxid);
    await this.bitcoin.broadcast(authority.plan.revealHex, authority.plan.revealTxid);
    const revealed = await this.bitcoin.transaction(authority.plan.revealTxid);
    await this.refreshFloat();
    const canTap = revealed?.confirmed && Number.isSafeInteger(revealed.height) && BigInt(this.float.snapshot.height) >= BigInt(revealed.height);
    if (canTap) await this.bitcoin.broadcast(authority.tapPlan.hex, authority.tapPlan.txid);
    return { address: this.address, inscriptionId: authority.plan.inscriptionId, txid: authority.plan.revealTxid,
      activationTxid: authority.tapPlan.txid, activation: canTap ? 'sent' : 'waiting_reveal_confirmation', authority: this.float.authority };
  }
  async resume(row) {
    if (row.state === 'recorded') return;
    if (!row.evidence) {
      let evidence;
      try { evidence = await this.tap.confirmed(row, this.address); }
      catch (error) { this.log({ event: 'mint_payout_evidence_retry', reference: row.record.reference, code: mintSenderError(error) }); }
      if (evidence) row = this.payments.save({ ...row, state: 'confirmed', evidence });
      else {
        // Both txids and signed bytes are durable even if either response is lost.
        await this.bitcoin.broadcast(row.plan.commitHex, row.plan.commitTxid);
        await this.bitcoin.broadcast(row.plan.revealHex, row.plan.revealTxid);
        this.payments.save({ ...row, state: 'broadcast' });
        return;
      }
    }
    const result = await this.gateway.recordPayout({ beneficiary: row.record.beneficiary, amount: row.record.amount,
      reference: row.record.reference, txid: row.evidence.txid });
    check(result?.keyId === this.keyId && result.recorded === true, 'mint_sender_gateway_identity');
    this.payments.save({ ...row, state: 'recorded' }); this.clearWait();
    this.log({ event: 'mint_payout_recorded', reference: row.record.reference, amount: row.record.amount, txid: row.evidence.txid });
  }
  async prepare(record) {
    if (!this.settings.payoutsEnabled || this.payments.pending()) return;
    if (record.blocked || !validDestination(record.beneficiary, this.network))
      return this.wait('destination', 'Payout destination is not a valid Bitcoin address for this network.', record.beneficiary);
    check(atomicAmount(record.amount) && BigInt(record.amount) > 0n && /^automatic\/[0-9a-f]{64}$/.test(record.reference), 'mint_payout_record');
    const amount = BigInt(record.amount), daily = this.payments.daily();
    if (amount > BigInt(this.settings.payoutMaxAtoms))
      return this.wait('max', 'Owed amount exceeds payoutMaxAtoms; waiting without splitting.', record.beneficiary);
    if (amount + BigInt(daily.paid) + BigInt(daily.reserved) > BigInt(this.settings.payoutDailyCapAtoms))
      return this.wait('daily_cap', 'Payout is waiting for the rolling 24-hour TAP cap.', record.beneficiary);
    const float = await this.refreshFloat(), authority = this.journal.meta('payoutAuthority');
    check(BigInt(float.snapshot.height) >= BigInt(this.journal.meta('payoutLastHeight') ?? 0), 'mint_payout_tap_behind');
    if (float.authority.state !== 'active' || !authority)
      return this.wait('authority', 'Create and confirm the separate payout wallet authority.', record.beneficiary);
    if (BigInt(float.balances.tap) < amount) return this.wait('tap_funds', 'Payout wallet needs more TAP.', record.beneficiary);
    const feeRate = await this.bitcoin.feeRate();
    if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > this.settings.maxRefundFeeRate)
      return this.wait('fee_rate', 'Payout is waiting for Bitcoin fees to fit the configured caps.', record.beneficiary);
    const coins = (await this.tap.cardinal(await this.bitcoin.utxos(this.address))).filter(c => !this.payments.coinUsed(c));
    const coin = coins.sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)) || `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`))[0];
    if (!coin) return this.wait('btc_funds', 'Payout wallet needs confirmed cardinal BTC for fees.', record.beneficiary);
    const key = payoutFloatKey(this.seed, this.network);
    let plan, payload;
    try {
      const data = 'dmw-payout-v1|' + record.reference;
      payload = tokenAuth({ auth: authority.plan.inscriptionId, items: [{ tick: 'tap', amt: rules.formatTapAmount(record.amount), address: record.beneficiary, dta: data }], data },
        'redeem', key.privateKey, hash(data + '|' + authority.plan.inscriptionId));
      const text = JSON.stringify(payload);
      check(Buffer.byteLength(text) <= this.settings.refundContentBytes, 'mint_payout_content');
      plan = signCommit(buildInscription({ text, receiver: record.beneficiary, publicKey: key.publicKey, network: this.network,
        utxos: [coin], feeRate, maxFeeSats: String(this.settings.maxFeeSats), postage: this.settings.postageSats, dustSats: this.settings.dustSats }), key.privateKey);
    } catch (error) {
      if (['bitcoin_funding_insufficient', 'bitcoin_fee_limit'].includes(error.code) || error.code === 'player_mint_invalid' && error.requiredSats)
        return this.wait('btc_funds', 'Payout wallet BTC is insufficient for the transfer within the fee cap.', record.beneficiary);
      throw error;
    } finally { key.privateKey.fill(0); }
    // Freeze the exact current owed amount before these bytes can leave the process.
    const reserved = await this.gateway.preparePayout({ beneficiary: record.beneficiary, amount: record.amount, reference: record.reference });
    check(reserved?.keyId === this.keyId && ['beneficiary', 'amount', 'reference'].every(k => reserved.record?.[k] === record[k]), 'mint_payout_changed');
    const id = hash(record.reference);
    check(!this.payments.get(id), 'mint_payout_already_paid');
    const row = this.payments.save({ id, record: reserved.record, state: 'prepared', coin, plan, payload, amounts: { tap: record.amount }, createdAt: this.now() });
    this.clearWait();
    this.log({ event: 'mint_payout_prepared', reference: record.reference, amount: record.amount, txid: plan.revealTxid });
    await this.resume(row);
  }
  async tick() {
    const pending = this.payments.pending();
    if (this.now() - this.lastFloat >= this.settings.healthMs && (this.gateway.payouts || pending)) {
      try { await this.refreshFloat(); }
      catch (error) { this.log({ event: 'mint_payout_float_retry', code: mintSenderError(error) }); }
    }
    if (pending) return this.resume(pending); // Finish irrevocable work even when disabled.
    if (!this.gateway.payouts) return;
    const page = await this.gateway.payouts(this.journal.meta('payoutCursor') ?? '', this.settings.pageSize);
    check(page?.keyId === this.keyId && Array.isArray(page.rows) && page.rows.length <= this.settings.pageSize &&
      (page.next === null || validRequestId(page.next)) && atomicAmount(page.queuedCount), 'mint_sender_gateway_identity');
    this.queuedCount = page.queuedCount; this.journal.meta('payoutQueuedCount', this.queuedCount); this.lastDiscovery = this.now();
    // Keep the page cursor until all its candidates have been considered. A
    // process restart may revisit it, but the gateway reference prevents repeats.
    for (const record of page.rows) { await this.prepare(record); if (this.payments.pending()) return; }
    this.journal.meta('payoutCursor', page.next ?? '');
    if (this.settings.payoutsEnabled && this.now() - this.lastFloat >= this.settings.healthMs) await this.refreshFloat();
    if (page.queuedCount === '0') this.clearWait();
  }
  async attempt() {
    if (this.now() < (this.journal.meta('payoutNextAttempt') ?? 0)) return;
    try { await this.tick(); this.journal.meta('payoutNextAttempt', this.now() + this.settings.fundingPollMs); }
    catch (error) {
      this.journal.meta('payoutNextAttempt', this.now() + this.settings.retryMs);
      this.wait('retry', 'Payout source or ledger unavailable; the saved transaction and reference will be retried.');
      this.log({ event: 'mint_payout_retry', code: mintSenderError(error) });
    }
  }
}
