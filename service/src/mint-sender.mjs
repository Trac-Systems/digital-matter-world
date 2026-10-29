import { mintSenderError } from './mint-sender-errors.mjs';
import { join } from 'node:path';
import { requestKey, btc, validRequestId, validDestination } from './mint-sender-keys.mjs';
import { senderJSON } from './mint-sender-journal.mjs';
import { senderKeyId, senderPolicy } from './mint-sender-view.mjs';
import { check } from './util.mjs';
import { mintContent, buildInscription, signCommit, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';

const returnStates = new Set(['expired', 'refunded', 'refundable', 'credited', 'someone_paid_first']);
function terminal(status) {
  if (returnStates.has(status.state)) return status.state;
  if (status.state === 'minted') return 'user_minted';
  if (!status.mintContent && status.publicMint && !status.winner && status.counted !== null && status.counted !== undefined &&
      BigInt(status.counted) > BigInt(status.payBy.untilBlock)) return 'expired';
  return null;
}
export function buildMintReturn({ coin, key, payer, network, feeRate, settings }) {
  check(Number.isFinite(feeRate) && feeRate >= 1 && feeRate <= settings.maxFeeRate, 'mint_sender_return_fee');
  const fee = Math.ceil(111 * feeRate), amount = BigInt(coin.value) - BigInt(fee);
  check(amount >= BigInt(settings.dustSats) && fee <= settings.maxFeeSats, 'mint_sender_return_fee');
  const tx = new btc.Transaction();
  tx.addInput({ txid: coin.txid, index: coin.vout, sequence: 0xfffffffd,
    witnessUtxo: { script: unhex(coin.script), amount: BigInt(coin.value) }, tapInternalKey: unhex(key.publicKey).slice(1) });
  tx.addOutputAddress(payer, amount, networkFor(network)); tx.sign(key.privateKey); tx.finalize();
  check(tx.fee >= BigInt(Math.ceil(tx.vsize * feeRate)), 'mint_sender_return_fee');
  return { txid: tx.id, hex: tx.hex, feeSats: String(fee) };
}
export class MintSender {
  constructor({ seed, network, settings, journal, gateway, bitcoin, now = Date.now, log = value => console.log(JSON.stringify(value)) }) {
    Object.assign(this, { seed, network, settings, journal, gateway, bitcoin, now, log });
    this.keyId = senderKeyId(seed, network); this.policy = senderPolicy(settings); this.active = new Map(); this.lastHealth = 0; this.lastDiscovery = 0;
    this.cursor = journal.meta('cursor') ?? ''; this.sourceReady = false; this.sourceVerified = false; this.lastSourceCheck = 0; this.stopped = false;
  }
  async discover() {
    const page = await this.gateway.list(this.cursor, this.settings.pageSize);
    check(page.keyId === this.keyId && (page.next === null || validRequestId(page.next)), 'mint_sender_gateway_identity');
    for (const status of page.rows) {
      const id = status.requestId;
      check(validRequestId(id) && status.payBy?.rail === 'tap' && validDestination(status.payer, this.network) && validDestination(status.receiver, this.network), 'mint_sender_gateway_binding');
      const key = requestKey(this.seed, id, this.network); let address;
      try { address = key.address; } finally { key.privateKey.fill(0); }
      check(status.fundingAddress === address, 'mint_sender_funding_binding');
      const old = this.journal.get(id);
      check(!old || old.payer === status.payer && old.receiver === status.receiver && old.address === address, 'mint_sender_request_changed');
      // Existing work is never rewritten by a concurrent discovery response.
      if (!old) this.journal.save({ id, payer: status.payer, receiver: status.receiver, address, state: 'waiting_funding', createdAt: this.now(), nextAttempt: 0, counted: status.counted });
      else if (!this.active.has(id) && status.counted !== old.counted) this.journal.save({ ...old, counted: status.counted });
    }
    this.cursor = page.next ?? ''; this.journal.meta('cursor', this.cursor); this.lastDiscovery = this.now();
  }
  save(row, change) { return this.journal.save({ ...row, ...change }); }
  async process(id) {
    let row = this.journal.get(id), status;
    try { status = { ...await this.gateway.status(id), counted: row.counted }; }
    catch (error) {
      // Once signed, the saved permit/transactions need no new gateway action.
      // Finish the reveal even if a gateway restart interrupts status reads.
      if (!row.plan && !row.returnPlan) throw error;
      this.log({ event: 'mint_sender_status_retry', requestId: id, code: mintSenderError(error) });
    }
    if (status) {
      check(status.requestId === id && status.receiver === row.receiver && status.payBy?.rail === 'tap', 'mint_sender_status_binding');
      row = this.save(row, { gatewayState: status.state, terminal: terminal(status) !== null });
      if (status.state === 'permit_issued' && !row.permitAt) row = this.save(row, { permitAt: this.now() });
    }
    if (row.returnPlan) {
      await this.bitcoin.broadcast(row.returnPlan.hex, row.returnPlan.txid);
      const seen = await this.bitcoin.transaction(row.returnPlan.txid);
      return this.save(row, { state: seen?.confirmed ? 'returned' : 'returning', message: seen?.confirmed ? 'Bitcoin set-aside returned to the payer.' : 'Returning Bitcoin set-aside to the payer.' });
    }
    if (row.plan) {
      if (status?.state === 'minted') return this.save(row, { state: 'minted', message: 'Mint accepted on Bitcoin.' });
      // A saved plan is irrevocable: every uncertain retry uses the same bytes.
      // Even after a lost commit reply, never create a conflicting return.
      await this.bitcoin.broadcast(row.plan.commitHex, row.plan.commitTxid);
      await this.bitcoin.broadcast(row.plan.revealHex, row.plan.revealTxid);
      row = this.save(row, { state: 'sent', revealAt: row.revealAt ?? this.now(), message: 'Mint sent; waiting for Bitcoin verification.' });
      await this.gateway.report(id, row.plan.inscriptionId);
      return row;
    }
    const coins = await this.bitcoin.utxos(row.address);
    const previous = row.coin && coins.find(c => c.txid === row.coin.txid && c.vout === row.coin.vout);
    // A wallet fee bump can replace its payment before the permit arrives.
    // No spend has been signed in this branch, so follow the available output
    // at the same derived address. Signed plans above never change inputs.
    const coin = previous ?? coins.filter(c => BigInt(c.value) >= BigInt(this.settings.dustSats))
      .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)) || `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`))[0];
    if (!coin) {
      if (row.coin) return this.save(row, { message: 'Funding output unavailable; retrying Bitcoin lookup.' });
      return row;
    }
    if (!row.coin || !previous) row = this.save(row, { coin, fundedAt: row.fundedAt ?? this.now(), state: row.returnReason ? row.state : 'funded' });
    else check(row.coin.value === coin.value && row.coin.script === coin.script, 'mint_sender_coin_changed');
    const reason = row.returnReason ?? terminal(status);
    if (reason) return this.returnFunding(row, reason);
    if (status.state !== 'permit_issued') return row;
    // The client may have broadcast its own inscription before discovering the
    // set-aside. Let the gateway verify it, then return the untouched set-aside.
    if (status.sentInscription) return this.save(row, { message: 'Waiting for the wallet-reported mint to be verified.' });
    let text;
    try { text = mintContent(status, row.receiver); }
    catch { return this.save(row, { state: 'needs_user', returnReason: 'invalid_permit', message: 'Use your wallet to inscribe this mint. Bitcoin set-aside will be returned.' }); }
    const feeRate = await this.bitcoin.feeRate();
    const key = requestKey(this.seed, row.id, this.network), reveal = requestKey(this.seed, row.id, this.network, 1);
    let plan;
    try {
      if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > this.settings.maxFeeRate) return this.feeWait(row);
      plan = signCommit(buildInscription({ text, receiver: row.receiver, publicKey: key.publicKey, network: this.network,
        utxos: [coin], feeRate, maxFeeSats: String(this.settings.maxFeeSats), postage: this.settings.postageSats,
        changeAddress: row.payer, allowUnconfirmed: true, allowNoChange: true, dustSats: this.settings.dustSats, secret: reveal.privateKey }), key.privateKey);
    } catch (error) {
      if (['bitcoin_funding_insufficient', 'bitcoin_fee_limit'].includes(error.code)) return this.feeWait(row);
      return this.save(row, { state: 'needs_user', returnReason: 'cannot_prepare', message: 'Use your wallet to inscribe this mint. Bitcoin set-aside will be returned.' });
    } finally { key.privateKey.fill(0); reveal.privateKey.fill(0); }
    // Recheck immediately before persisting a spend intent, after all slow reads.
    const fresh = await this.gateway.status(id);
    if (fresh.state !== 'permit_issued' || fresh.sentInscription) return row;
    check(mintContent(fresh, row.receiver) === text, 'mint_sender_permit_changed');
    row = this.save(row, { state: 'sending', plan, message: 'Sending your mint inscription.' });
    await this.bitcoin.broadcast(plan.commitHex, plan.commitTxid);
    await this.bitcoin.broadcast(plan.revealHex, plan.revealTxid);
    row = this.save(row, { state: 'sent', revealAt: this.now(), message: 'Mint sent; waiting for Bitcoin verification.' });
    await this.gateway.report(id, plan.inscriptionId);
    return row;
  }
  feeWait(row) {
    const feeSince = row.feeSince ?? this.now(), expired = this.now() - feeSince >= this.settings.feeWaitMs;
    return this.save(row, { feeSince, state: expired ? 'needs_user' : 'funded',
      ...(expired ? { returnReason: 'fee_spike' } : {}), message: expired ? 'Use your wallet to inscribe this mint. Bitcoin set-aside will be returned.' : 'Waiting for Bitcoin fees to fit the set-aside.' });
  }
  async returnFunding(row, reason) {
    const feeRate = await this.bitcoin.feeRate(), key = requestKey(this.seed, row.id, this.network);
    let plan;
    try { plan = buildMintReturn({ coin: row.coin, key, payer: row.payer, network: this.network, feeRate, settings: this.settings }); }
    catch (error) {
      if (error.message === 'mint_sender_return_fee') return this.save(row, { returnReason: reason, state: row.state === 'needs_user' ? 'needs_user' : 'returning', message: 'Waiting for Bitcoin fees to allow the set-aside return.' });
      throw error;
    } finally { key.privateKey.fill(0); }
    row = this.save(row, { returnReason: reason, state: 'returning', returnPlan: plan, message: 'Returning Bitcoin set-aside to the payer.' });
    await this.bitcoin.broadcast(plan.hex, plan.txid);
    return row;
  }
  async attempt(id) {
    try { await this.process(id); const row = this.journal.get(id); this.save(row, { failures: 0, nextAttempt: this.now() + (row.state === 'waiting_funding' ? row.terminal ? this.settings.terminalPollMs : this.settings.fundingPollMs : this.settings.pollMs) }); }
    catch (error) {
      const row = this.journal.get(id), failures = (row.failures ?? 0) + 1;
      this.save(row, { failures, nextAttempt: this.now() + Math.min(this.settings.maxRetryMs, this.settings.retryMs * 2 ** Math.min(failures - 1, 16)) });
      this.log({ event: 'mint_sender_retry', requestId: id, state: row.state, failures, code: mintSenderError(error) });
    }
  }
  health(force = false) {
    if (!force && this.now() - this.lastHealth < this.settings.healthMs) return;
    const { counts, oldestWaitingMs, stuck } = this.journal.health(this.settings.stuckMs, this.settings.pageSize);
    const ready = this.sourceReady && this.lastDiscovery > 0 && this.now() - this.lastDiscovery <= this.settings.heartbeatMaxAgeMs;
    senderJSON(join(this.settings.directory, 'health.json'), { keyId: this.keyId, policy: this.policy, at: this.now(), ready, counts, oldestWaitingMs });
    this.log({ event: 'mint_sender_health', ready, counts, oldestWaitingMs });
    for (const row of stuck)
      this.log({ event: 'mint_sender_stuck', requestId: row.id, state: row.state, waitingMs: this.now() - Math.max(row.permitAt, row.fundedAt) });
    this.lastHealth = this.now();
  }
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      // Discovery failure never prevents already-journaled requests progressing.
      if (!this.sourceReady || this.now() - this.lastSourceCheck >= this.settings.healthMs) {
        try { await this.bitcoin.verifyNetwork(); this.sourceReady = this.sourceVerified = true; }
        catch (error) {
          this.sourceReady = false;
          // A TAP outage must not prevent retrying a saved Bitcoin send on an
          // already verified network. A conflicting Bitcoin genesis does.
          this.sourceVerified = error.message === 'mint_sender_bitcoin_network' ? false : this.sourceVerified || this.bitcoin.networkVerified === true;
          this.log({ event: 'mint_sender_source_retry', code: mintSenderError(error) });
        } finally { this.lastSourceCheck = this.now(); }
      }
      try { await this.discover(); } catch (error) { this.log({ event: 'mint_sender_discovery_retry', code: mintSenderError(error) }); }
      if (this.sourceVerified) {
        const due = this.journal.due(this.settings.pageSize).filter(r => !this.active.has(r.id));
        for (const row of due) {
          if (this.active.size >= this.settings.concurrency) break;
          const job = this.attempt(row.id).catch(() => this.log({ event: 'mint_sender_journal_error', requestId: row.id }))
            .finally(() => this.active.delete(row.id));
          this.active.set(row.id, job);
        }
      }
      this.health();
    } finally { this.running = false; }
  }
  async drain() { await Promise.allSettled([...this.active.values()]); }
  async close() {
    this.stopped = true; await this.drain(); this.sourceReady = false;
    try { this.health(true); } finally { this.seed.fill(0); this.journal.close(); }
  }
}
