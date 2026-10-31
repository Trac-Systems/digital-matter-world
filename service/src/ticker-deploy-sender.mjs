import { requestKey, validRequestId, validDestination, boundRefundReserve } from './mint-sender-keys.mjs';
import { mintSenderError } from './mint-sender-errors.mjs';
import { check } from './util.mjs';
import { buildInscription, signCommit, deploymentContent } from '../../kit/lib/inscription-core.mjs';
import { validateChosenTicker } from '../../rules/src/ticker-grammar.js';

const HANDED_BACK = 'Use your wallet to deploy this ticker. The Bitcoin set-aside is returned to you.';
// One approval for an additional ticker: the deploy fee payment set aside this deploy's Bitcoin at the request's
// own address. Once the fee counts, the minter inscribes the exact registered deploy content to the requester and
// reports it through the same public paths the page uses. The commit's change stays at the request address, so the
// refund reserve still pays a fee refund and the ticker return gives the rest back after registration.
export class TickerDeploySender {
  constructor(sender) {
    this.sender = sender;
    for (const name of ['seed', 'network', 'settings', 'journal', 'gateway', 'bitcoin', 'now', 'log', 'keyId']) this[name] = sender[name];
  }
  async discover() {
    if (!this.settings.tickerDeploysEnabled || !this.gateway.tickerDeploys) return;
    const page = await this.gateway.tickerDeploys(this.journal.meta('tickerDeployCursor') ?? '', this.settings.pageSize);
    check(page.keyId === this.keyId && (page.next === null || validRequestId(page.next)), 'mint_sender_gateway_identity');
    for (const status of page.rows) {
      const id = status.requestId, old = this.journal.get(id);
      this.binding(status, old);
      // Only a request still waiting for its deploy starts new work; finished ones are settled elsewhere.
      if (!old && status.state === 'awaiting_player_deploy')
        this.journal.save({ id, tickerDeploy: true, asset: status.asset, payer: status.payer, receiver: status.receiver, address: status.fundingAddress,
          deploySats: status.deploySats, refundReserveSats: status.refundReserveSats, state: 'waiting_funding', createdAt: this.now(), nextAttempt: 0, counted: status.counted });
    }
    this.journal.meta('tickerDeployCursor', page.next ?? '');
  }
  binding(status, old) {
    const id = status?.requestId;
    check(validRequestId(id) && status.tickerDeploy === true && status.payBy?.rail === 'tap' && status.payer === status.receiver &&
      validDestination(status.receiver, this.network) && Array.isArray(status.fundingReferences) &&
      Number.isSafeInteger(status.deploySats) && status.deploySats >= this.settings.postageSats + this.settings.dustSats &&
      status.deploySats + (status.refundReserveSats ?? 0) <= this.settings.maxFundingSats, 'ticker_deploy_binding');
    boundRefundReserve(status, this.settings);
    const key = requestKey(this.seed, id, this.network); let address;
    try { address = key.address; } finally { key.privateKey.fill(0); }
    check(status.fundingAddress === address, 'mint_sender_funding_binding');
    check(!old || old.tickerDeploy === true && old.payer === status.payer && old.receiver === status.receiver && old.address === address &&
      old.deploySats === status.deploySats && old.refundReserveSats === status.refundReserveSats && old.asset === status.asset, 'mint_sender_request_changed');
  }
  save(row, change) { return this.journal.save({ ...row, ...change }); }
  async process(id) {
    let row = this.journal.get(id), status;
    try { status = await this.gateway.tickerDeployStatus(id); check(status?.requestId === id, 'ticker_deploy_binding'); this.binding(status, row); }
    catch (error) {
      // A signed deploy is irrevocable: finish broadcasting it even while the gateway is unavailable.
      if (!row.plan) throw error;
      status = null; this.log({ event: 'mint_sender_status_retry', requestId: id, code: mintSenderError(error) });
    }
    if (status) row = this.save(row, { gatewayState: status.state, counted: status.counted });
    if (row.plan) {
      if (status?.state === 'registered') return this.save(row, { state: 'minted', message: 'Ticker deploy registered.' });
      // Every retry uses the same saved bytes; a lost reply never creates a second deploy.
      await this.bitcoin.broadcast(row.plan.commitHex, row.plan.commitTxid);
      await this.bitcoin.broadcast(row.plan.revealHex, row.plan.revealTxid);
      row = this.save(row, { state: 'sent', revealAt: row.revealAt ?? this.now(), message: status && status.state !== 'awaiting_player_deploy' ?
        'Ticker request stopped after the deploy was sent.' : 'Deploy sent; waiting for Bitcoin to confirm it.' });
      if (status?.state === 'awaiting_player_deploy') await this.report(row, status);
      return row;
    }
    if (status.state !== 'awaiting_player_deploy') {
      // Registered from the wallet, or stopped: the ticker return or the fee refund settles the untouched set-aside.
      return this.save(row, { state: 'returned', message: 'Bitcoin set-aside settled with the ticker request.' });
    }
    if (row.state === 'needs_user') return row;
    // The player's own wallet deploy was reported first: let the gateway register it.
    if (status.inflight) return this.save(row, { message: 'Waiting for the wallet-sent deploy to be registered.' });
    const coins = (await this.sender.setAside(row.address, status.fundingReferences)).filter(c => !this.journal.coinOwner(c));
    const previous = row.coin && coins.find(c => c.txid === row.coin.txid && c.vout === row.coin.vout);
    const coin = previous ?? coins.filter(c => BigInt(c.value) >= BigInt(this.settings.dustSats))
      .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)) || `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`))[0];
    if (!coin) {
      // The fee is already counted, so a payment that set Bitcoin aside shows it; an older wallet's payment never will.
      if (this.now() - row.createdAt >= this.settings.feeWaitMs) return this.save(row, { state: 'needs_user', message: HANDED_BACK });
      return this.save(row, { message: 'Looking for the Bitcoin set-aside of the fee payment.' });
    }
    if (!previous) row = this.save(row, { coin, fundedAt: row.fundedAt ?? this.now(), state: 'funded' });
    let text;
    try { text = deploymentContent(status.deploy, { validateTicker: validateChosenTicker }).text; check(status.deploy.receiver === row.receiver, 'ticker_deploy_binding'); }
    catch (error) { this.log({ event: 'ticker_deploy_handed_back', requestId: id, code: mintSenderError(error) }); return this.save(row, { state: 'needs_user', message: HANDED_BACK }); }
    const feeRate = await this.bitcoin.feeRate();
    const key = requestKey(this.seed, row.id, this.network), reveal = requestKey(this.seed, row.id, this.network, 1);
    let plan;
    try {
      if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > this.settings.maxFeeRate) return this.feeWait(row);
      // Fees stay inside the deploy budget, so the change keeps the refund reserve at the request address.
      plan = signCommit(buildInscription({ text, receiver: row.receiver, publicKey: key.publicKey, network: this.network,
        utxos: [coin], feeRate, maxFeeSats: String(Math.min(this.settings.maxFeeSats, row.deploySats - this.settings.postageSats - this.settings.dustSats)),
        postage: this.settings.postageSats, allowUnconfirmed: true, allowNoChange: !row.refundReserveSats, dustSats: this.settings.dustSats, secret: reveal.privateKey }), key.privateKey);
    } catch (error) {
      if (['bitcoin_funding_insufficient', 'bitcoin_fee_limit'].includes(error.code)) return this.feeWait(row);
      this.log({ event: 'ticker_deploy_handed_back', requestId: id, code: mintSenderError(error) });
      return this.save(row, { state: 'needs_user', message: HANDED_BACK });
    } finally { key.privateKey.fill(0); reveal.privateKey.fill(0); }
    // Recheck immediately before persisting the spend intent, after all slow reads.
    const fresh = await this.gateway.tickerDeployStatus(id);
    this.binding(fresh, row);
    if (fresh.state !== 'awaiting_player_deploy' || fresh.inflight) return row;
    check(deploymentContent(fresh.deploy, { validateTicker: validateChosenTicker }).text === text, 'mint_sender_permit_changed');
    row = this.save(row, { state: 'sending', plan, message: 'Sending your ticker deploy inscription.' });
    await this.bitcoin.broadcast(plan.commitHex, plan.commitTxid);
    await this.bitcoin.broadcast(plan.revealHex, plan.revealTxid);
    row = this.save(row, { state: 'sent', revealAt: this.now(), message: 'Deploy sent; waiting for Bitcoin to confirm it.' });
    await this.report(row, fresh);
    return row;
  }
  async report(row, status) {
    if (status.inflight?.revealTxid !== row.plan.revealTxid)
      try { await this.gateway.reportTickerDeploy(row.id, row.plan); } catch (error) { this.log({ event: 'ticker_deploy_report_retry', requestId: row.id, code: mintSenderError(error) }); }
    // Registration verifies the deploy on Bitcoin and TAP exactly as for a wallet-sent one; it waits for confirmations.
    try { await this.gateway.registerTickerDeploy(row.asset, row.id, row.plan.inscriptionId); }
    catch (error) { this.log({ event: 'ticker_deploy_register_retry', requestId: row.id, code: mintSenderError(error) }); }
  }
  feeWait(row) {
    const feeSince = row.feeSince ?? this.now(), expired = this.now() - feeSince >= this.settings.feeWaitMs;
    return this.save(row, { feeSince, state: expired ? 'needs_user' : 'funded', message: expired ? HANDED_BACK : 'Waiting for Bitcoin fees to fit the set-aside.' });
  }
}
