import { requestKey, refundFloatKey, validRequestId, btc } from './mint-sender-keys.mjs';
import { tokenAuth, refundAmounts, refundRedeem } from './mint-refund-protocol.mjs';
import { buildInscription, signCommit, unhex, hex, networkFor } from '../../kit/lib/inscription-core.mjs';
import { check, hash } from './util.mjs';
import { mintSenderError } from './mint-sender-errors.mjs';

export function buildAuthorityTap(plan, key, network, settings) {
  const commit = btc.Transaction.fromRaw(unhex(plan.commitHex)), reveal = btc.Transaction.fromRaw(unhex(plan.revealHex), { allowUnknownInputs: true });
  const script = btc.p2tr(unhex(key.publicKey).slice(1), undefined, networkFor(network)).script;
  check(commit.outputsLength === 2 && reveal.outputsLength === 1 && hex(commit.getOutput(1).script) === hex(script) && hex(reveal.getOutput(0).script) === hex(script), 'mint_refund_authority_outputs');
  const fee = BigInt(Math.ceil((12 + 2 * 58 + 43) * plan.feeRate)), amount = commit.getOutput(1).amount + reveal.getOutput(0).amount - fee;
  check(amount >= BigInt(settings.postageSats) && fee + BigInt(plan.feeSats) <= BigInt(settings.maxFeeSats), 'mint_refund_authority_funding');
  const tx = new btc.Transaction();
  // The inscription input is first, preserving its first sat in the self-send.
  for (const [txid, index, output] of [[plan.revealTxid, 0, reveal.getOutput(0)], [plan.commitTxid, 1, commit.getOutput(1)]])
    tx.addInput({ txid, index, sequence: 0xfffffffd, witnessUtxo: { script, amount: output.amount }, tapInternalKey: unhex(key.publicKey).slice(1) });
  tx.addOutputAddress(key.address, amount, networkFor(network)); tx.sign(key.privateKey); tx.finalize();
  check(tx.fee >= BigInt(Math.ceil(tx.vsize * plan.feeRate)), 'mint_refund_fee');
  return { txid: tx.id, hex: tx.hex, feeSats: String(fee) };
}

export class MintRefundSender {
  constructor(sender) {
    this.sender = sender;
    for (const name of ['seed', 'network', 'settings', 'journal', 'gateway', 'bitcoin', 'now', 'log', 'keyId']) this[name] = sender[name];
    this.tap = this.bitcoin.tap;
    const key = refundFloatKey(this.seed, this.network);
    this.address = key.address; key.privateKey.fill(0);
    this.float = { address: this.address, balances: null, authority: { state: 'unknown' } };
    this.cursor = this.journal.meta('refundCursor') ?? '';
    this.lastFloat = 0; this.lastDiscovery = 0;
  }
  save(row, change) {
    const saved = this.journal.saveRefund({ ...row, ...change });
    if (row.state !== saved.state) this.log({ event: 'mint_refund_state', refundId: row.id, requestId: row.record.id, state: saved.state, message: saved.message });
    return saved;
  }
  async discover() {
    if (!this.settings.refundsEnabled) return;
    const page = await this.gateway.refunds(this.cursor, this.settings.pageSize);
    check(page.keyId === this.keyId && page.rows.length <= this.settings.pageSize && (page.next === null || validRequestId(page.next)), 'mint_sender_gateway_identity');
    for (const record of page.rows) {
      refundAmounts(record, this.network, this.settings);
      const old = this.journal.refund(record.refundId);
      check(!old || JSON.stringify(old.record) === JSON.stringify(record), 'mint_refund_record_changed');
      if (!old) this.journal.saveRefund({ id: record.refundId, record, state: 'refund_pending', createdAt: this.now(), nextAttempt: 0 });
    }
    this.cursor = page.next ?? ''; this.journal.meta('refundCursor', this.cursor); this.lastDiscovery = this.now();
  }
  async refreshFloat() {
    const result = await this.tap.float(this.address, this.journal.meta('refundAuthority'));
    this.float = { ...result.value, snapshot: result.snapshot, checkedAt: this.now() };
    this.lastFloat = this.now(); return this.float;
  }
  async createAuthority() {
    await this.bitcoin.verifyNetwork();
    let authority = this.journal.meta('refundAuthority');
    if (!authority) {
      const key = refundFloatKey(this.seed, this.network);
      try {
        const payload = tokenAuth(this.settings.refundTickers, 'auth', key.privateKey, hash('dmw-refund-authority-v1|' + this.network + '|' + this.address));
        const coins = await this.tap.cardinal(await this.bitcoin.utxos(this.address));
        const feeRate = await this.bitcoin.feeRate();
        check(feeRate >= 1 && feeRate <= this.settings.maxRefundFeeRate, 'mint_refund_fee');
        const plan = signCommit(buildInscription({ text: JSON.stringify(payload), receiver: this.address, publicKey: key.publicKey, network: this.network,
          utxos: coins, feeRate, maxFeeSats: String(this.settings.maxFeeSats), postage: this.settings.postageSats, dustSats: this.settings.dustSats }), key.privateKey);
        authority = { payload, plan, tapPlan: buildAuthorityTap(plan, key, this.network, this.settings) };
        // This intent is written before either transaction can leave the process.
        this.journal.meta('refundAuthority', authority);
      } finally { key.privateKey.fill(0); }
    }
    if (!authority.tapPlan) {
      const key = refundFloatKey(this.seed, this.network);
      try { authority = { ...authority, tapPlan: buildAuthorityTap(authority.plan, key, this.network, this.settings) }; this.journal.meta('refundAuthority', authority); }
      finally { key.privateKey.fill(0); }
    }
    await this.bitcoin.broadcast(authority.plan.commitHex, authority.plan.commitTxid);
    await this.bitcoin.broadcast(authority.plan.revealHex, authority.plan.revealTxid);
    const revealed = await this.bitcoin.transaction(authority.plan.revealTxid);
    // Authority setup follows the wallet's explicit two-stage flow. Do not
    // tap an inscription until its creation is confirmed and indexed.
    await this.refreshFloat();
    const canTap = revealed?.confirmed && Number.isSafeInteger(revealed.height) && BigInt(this.float.snapshot.height) >= BigInt(revealed.height);
    if (canTap) await this.bitcoin.broadcast(authority.tapPlan.hex, authority.tapPlan.txid);
    return { address: this.address, inscriptionId: authority.plan.inscriptionId, txid: authority.plan.revealTxid, activationTxid: authority.tapPlan.txid, activation: canTap ? 'sent' : 'waiting_reveal_confirmation', authority: this.float.authority };
  }
  async process(id) {
    let row = this.journal.refund(id);
    if (row.state === 'refund_confirmed') return row;
    if (row.plan) {
      let evidence;
      try { evidence = await this.tap.confirmed(row, this.address); }
      catch (error) {
        // TAP unavailability cannot strand a saved commit/reveal. Replaying
        // identical Bitcoin bytes cannot execute a second token transfer.
        this.log({ event: 'mint_refund_evidence_retry', refundId: id, code: mintSenderError(error) });
      }
      if (evidence) return this.save(row, { state: 'refund_confirmed', evidence, message: 'Refund sent and confirmed by TAP.' });
      await this.bitcoin.broadcast(row.plan.commitHex, row.plan.commitTxid);
      await this.bitcoin.broadcast(row.plan.revealHex, row.plan.revealTxid);
      return this.save(row, { state: 'refund_sent', message: 'Refund sent; waiting for TAP confirmation.' });
    }
    if (!this.settings.refundsEnabled) return row;
    // Only one unsettled float debit is allowed. This avoids overcommitting a
    // balance while the preceding Bitcoin transaction is awaiting TAP indexing.
    if (this.journal.pendingRefund()) return row;
    const record = row.record, key = requestKey(this.seed, record.id, this.network);
    let plan, redeem, coin;
    try {
      const coins = await this.bitcoin.paymentFunding(key.address, record.reference);
      coin = coins.filter(c => !this.journal.coinOwner(c) && BigInt(c.value) >= BigInt(this.settings.dustSats))
        .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)) || `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`))[0];
      if (!coin) return this.save(row, { state: 'refund_needs_operator', message: 'Payer Bitcoin set-aside missing or already spent. Operator action required; float Bitcoin cannot pay refund fees.' });
      const float = await this.refreshFloat(), authority = this.journal.meta('refundAuthority');
      check(BigInt(float.snapshot.height) >= BigInt(this.journal.lastRefundHeight()), 'mint_refund_tap_behind');
      if (float.authority.state !== 'active') return this.save(row, { state: 'refund_needs_operator', message: 'Refund float authority is not active. Operator must create and confirm the refund authority.' });
      const amounts = refundAmounts(record, this.network, this.settings);
      if (Object.entries(amounts).some(([tick, amount]) => BigInt(float.balances[tick]) < BigInt(amount)))
        return this.save(row, { state: 'refund_waiting_funds', message: 'Refund waiting for operator funds.' });
      const feeRate = await this.bitcoin.feeRate();
      if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > this.settings.maxRefundFeeRate)
        return this.save(row, { state: 'refund_pending', message: 'Refund pending; waiting for Bitcoin fees to fit the payer reserve.' });
      const floatKey = refundFloatKey(this.seed, this.network);
      try { redeem = refundRedeem(record, authority.plan.inscriptionId, floatKey.privateKey, this.network, this.settings); }
      finally { floatKey.privateKey.fill(0); }
      try {
        plan = signCommit(buildInscription({ text: redeem.text, receiver: record.tapAddress, publicKey: key.publicKey, network: this.network,
          utxos: [coin], feeRate, maxFeeSats: String(Math.min(this.settings.maxFeeSats, this.settings.refundReserveSats)), postage: this.settings.postageSats,
          changeAddress: record.tapAddress, allowUnconfirmed: true, dustSats: this.settings.dustSats }), key.privateKey);
      } catch (error) {
        if (['bitcoin_funding_insufficient', 'bitcoin_fee_limit'].includes(error.code))
          return this.save(row, { state: 'refund_needs_operator', message: 'Payer Bitcoin set-aside is insufficient for the refund. Operator action required; float Bitcoin cannot pay refund fees.' });
        throw error;
      }
      // Re-read accepted consensus evidence immediately before committing a
      // local spend. No contract state or signer decision is changed here.
      const fresh = await this.gateway.refund(id);
      check(fresh.keyId === this.keyId && JSON.stringify(fresh.record) === JSON.stringify(record), 'mint_refund_record_changed');
      row = this.save(row, { state: 'refund_sending', coin, plan, payload: redeem.payload, amounts: redeem.amounts, message: 'Refund pending.' });
    } finally { key.privateKey.fill(0); }
    await this.bitcoin.broadcast(plan.commitHex, plan.commitTxid);
    await this.bitcoin.broadcast(plan.revealHex, plan.revealTxid);
    return this.save(row, { state: 'refund_sent', message: 'Refund sent; waiting for TAP confirmation.' });
  }
  async attempt(id) {
    try {
      await this.process(id);
      const row = this.journal.refund(id);
      this.save(row, { failures: 0, nextAttempt: this.now() + (row.state === 'refund_needs_operator' ? this.settings.terminalPollMs : this.settings.fundingPollMs) });
    } catch (error) {
      const row = this.journal.refund(id), failures = (row.failures ?? 0) + 1;
      this.save(row, { failures, nextAttempt: this.now() + Math.min(this.settings.maxRetryMs, this.settings.retryMs * 2 ** Math.min(failures - 1, 16)) });
      this.log({ event: 'mint_refund_retry', refundId: id, requestId: row.record.id, state: row.state, failures, code: mintSenderError(error) });
    }
  }
}
