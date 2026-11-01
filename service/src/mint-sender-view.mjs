import { publicScanKey } from '../../contract/public-mint.js';
import { publicPlotId } from '../../rules/src/public-mint.js';
import { acceptedRefund, refundPage, decorateRefund } from './mint-refund-view.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { openSync, readFileSync, closeSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { requestKey, refundFloatKey, payoutFloatKey, fundingAmount, fundingQuote, refundReserve, deployBudget, validDestination, validRequestId } from './mint-sender-keys.mjs';
import { check, hash } from './util.mjs';

export const senderToken = (seed, network) => createHmac('sha256', seed).update('dmw-mint-sender-api-v1|' + network).digest('hex');
export const senderPolicy = settings => hash(JSON.stringify(Object.fromEntries(['feeRate', 'feeMargin', 'postageSats', 'dustSats', 'contentBytes', 'maxFundingSats', 'maxFeeSats', 'refundsEnabled', 'tickerDeploysEnabled', 'refundReserveSats', 'refundReserveMode', 'refundFeeHeadroom', 'refundReserveMinSats', 'refundReserveMaxSats', 'refundFeeRateMaxAgeMs', 'maxRefundFeeRate', 'refundContentBytes', 'refundTickers', 'payoutsEnabled', 'payoutDailyCapAtoms', 'payoutMaxAtoms'].map(k => [k, settings[k]]))));
export const senderKeyId = (seed, network) => {
  const k = requestKey(seed, '00'.repeat(32), network);
  try { return hash(k.address); } finally { k.privateKey.fill(0); }
};
export const SENDER_STATES = new Set(['waiting_funding', 'funded', 'sending', 'sent', 'minted', 'needs_user', 'returning', 'returned']);
export function readSenderJSON(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 8192) return null;
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export class MintSenderView {
  constructor({ seed, network, settings, now = Date.now }) {
    Object.assign(this, { seed, network, settings, now });
    this.keyId = senderKeyId(seed, network); this.policy = senderPolicy(settings);
    const float = refundFloatKey(seed, network); this.floatAddress = float.address; float.privateKey.fill(0);
    const payout = payoutFloatKey(seed, network); this.payoutAddress = payout.address; payout.privateKey.fill(0);
    this.token = senderToken(seed, network); this.satoshis = fundingAmount(settings); this.addresses = new Map();
  }
  authorized(header) {
    const expected = Buffer.from('Bearer ' + this.token), actual = Buffer.from(typeof header === 'string' ? header : '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  address(id) {
    check(validRequestId(id), 'mint_sender_request');
    if (!this.addresses.has(id)) {
      const key = requestKey(this.seed, id, this.network);
      this.addresses.set(id, key.address); key.privateKey.fill(0);
      if (this.addresses.size > 1000) this.addresses.delete(this.addresses.keys().next().value);
    }
    return this.addresses.get(id);
  }
  ready() {
    const h = readSenderJSON(join(this.settings.directory, 'health.json'));
    return h?.keyId === this.keyId && h.policy === this.policy && h.ready === true && Number.isSafeInteger(h.at) &&
      h.at <= this.now() && this.now() - h.at <= this.settings.heartbeatMaxAgeMs;
  }
  feeObservation() {
    const h = readSenderJSON(join(this.settings.directory, 'health.json'));
    return h?.keyId === this.keyId && h.policy === this.policy ? { feeRate: h.feeRate, feeRateAt: h.feeRateAt, now: this.now() } : {};
  }
  bind(row) {
    if (row.mintFunding || !this.settings.enabled || row.kind !== 'tap' ||
        !validDestination(row.payer, this.network) || !validDestination(row.receiver, this.network)) return row;
    return { ...row, mintFunding: fundingQuote(this.seed, row.id, this.network, this.settings, { payer: row.payer, ...this.feeObservation() }) };
  }
  refundFunding(id, payer) {
    const refundReserveSats = refundReserve(this.settings, { payer, ...this.feeObservation() });
    return { address: this.address(id), satoshis: refundReserveSats, refundReserveSats,
      feeRate: this.settings.maxRefundFeeRate, label: 'possible ticker fee refund' };
  }
  // One approval for an additional ticker: the fee payment also sets aside the deploy inscription's Bitcoin
  // (plus the refund reserve), bound to the request when it is created. Null keeps the two-step page flow.
  tickerDeployFunding(id, payer, contentBytes) {
    if (!this.settings.enabled || !this.settings.tickerDeploysEnabled || !validDestination(payer, this.network)) return null;
    const quote = { payer, ...this.feeObservation() };
    let refundReserveSats, deploySats;
    try { refundReserveSats = this.settings.refundsEnabled ? refundReserve(this.settings, quote) : 0; deploySats = deployBudget(this.settings, contentBytes, quote); }
    catch { return null; }
    const satoshis = deploySats + refundReserveSats;
    if (satoshis > this.settings.maxFundingSats) return null;
    return { address: this.address(id), satoshis, deploySats, refundReserveSats, feeRate: this.settings.feeRate, label: 'your ticker deploy inscription' };
  }
  // The minter's own projection of a ticker deploy it sends (status/<id>.json), as for mints.
  tickerDeploySender(job) {
    const snapshot = readSenderJSON(join(this.settings.directory, 'status', job.id + '.json'));
    return snapshot?.keyId === this.keyId && snapshot.requestId === job.id && snapshot.payer === job.receiver &&
      snapshot.receiver === job.receiver && SENDER_STATES.has(snapshot.mintSender?.state) ? snapshot.mintSender : null;
  }
  status() {
    const h = readSenderJSON(join(this.settings.directory, 'health.json'));
    const matching = h?.keyId === this.keyId && h.policy === this.policy;
    return { ready: this.ready(), payouts: matching && h.payouts ? h.payouts : { enabled: this.settings.payoutsEnabled, float: { address: this.payoutAddress, balances: null, btcSats: null, authority: { state: 'unknown' } }, paid24hAtoms: null, queuedCount: null, dailyCapAtoms: this.settings.payoutDailyCapAtoms, maxAtoms: this.settings.payoutMaxAtoms }, refundsEnabled: this.settings.refundsEnabled,
      float: matching && h.refundFloat ? h.refundFloat : { address: this.floatAddress, balances: null, authority: { state: 'unknown' } },
      refundCounts: matching ? h.refundCounts ?? {} : {}, refundAlarm: !this.ready() || (matching ? h.refundAlarm ?? false : true) };
  }
  refundPage(mints, params) { return refundPage(this, mints, params); }
  refundRecord(mints, id) { return { keyId: this.keyId, record: acceptedRefund(mints, id) }; }
  decorateRefund(record) { return decorateRefund(this, record); }
  estimate(status) {
    if (!this.settings.enabled || !this.ready() || !status.publicMint || status.kind !== 'tap' || status.state !== 'awaiting_payment' || status.requestId) return status;
    // A preview has no payable request/address. Expose only its Bitcoin budget;
    // the start response supplies the request-bound funding output separately.
    return { ...status, mintFundingEstimate: { satoshis: fundingAmount(this.settings, { payer: status.payer ?? status.receiver, ...this.feeObservation() }), feeRate: this.settings.feeRate } };
  }
  decorate(row, status) {
    if (row.kind !== 'tap' || !validDestination(row.payer, this.network) || !validDestination(row.receiver, this.network)) return status;
    const snapshot = readSenderJSON(join(this.settings.directory, 'status', row.id + '.json'));
    const sender = snapshot?.keyId === this.keyId && snapshot.requestId === row.id && snapshot.payer === row.payer &&
      snapshot.receiver === row.receiver && SENDER_STATES.has(snapshot.mintSender?.state) ? snapshot.mintSender : null;
    const offer = this.settings.enabled && status.payable && ['awaiting_payment', 'partly_paid'].includes(status.state) && this.ready() &&
      (!sender || sender.state === 'waiting_funding');
    return { ...status, ...(Array.isArray(status.refunds) ? { refunds: status.refunds.map(r => this.decorateRefund(r)) } : {}), ...(offer ? { mintFunding: row.mintFunding ?? { address: this.address(row.id), satoshis: this.satoshis, feeRate: this.settings.feeRate, label: 'your mint inscription' } } : {}),
      ...(sender || offer ? { mintSender: sender ?? { state: 'waiting_funding' } } : {}) };
  }
  page(mints, params) {
    const after = params.get('after') ?? '', limit = Number(params.get('limit') ?? this.settings.pageSize);
    check((after === '' || validRequestId(after)) && Number.isSafeInteger(limit) && limit > 0 && limit <= this.settings.pageSize, 'mint_sender_page');
    const page = mints.store.list('mints', { after, limit });
    const counted = mints.store.get('meta', 'ruleState')?.counted ?? null;
    return { keyId: this.keyId, rows: page.filter(r => validRequestId(r.id) && r.value.kind === 'tap' && validDestination(r.value.payer, this.network) && validDestination(r.value.receiver, this.network))
      .map(({ id, value }) => {
        const winner = value.publicMint ? mints.store.get('accountRecords', publicScanKey(publicPlotId(value.request.asset, value.request.block, value.intent?.supplyScope ?? value.request.supplyScope)))?.winner : null;
        return { requestId: id, receiver: value.receiver, payer: value.payer,
          ...(value.mintFunding ? { refundReserveSats: value.mintFunding.refundReserveSats } : {}),
          ...(winner?.id === id ? { fundingReference: winner.reference } : {}),
          payBy: { rail: value.kind, untilBlock: value.expiry ?? value.request.expires }, counted, fundingAddress: this.address(id) };
      }),
      next: page.length === limit ? page.at(-1).id : null };
  }
  close() { this.seed.fill(0); }
}
