import { createHmac, timingSafeEqual } from 'node:crypto';
import { openSync, readFileSync, closeSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { requestKey, fundingAmount, validDestination, validRequestId } from './mint-sender-keys.mjs';
import { check, hash } from './util.mjs';

export const senderToken = (seed, network) => createHmac('sha256', seed).update('dmw-mint-sender-api-v1|' + network).digest('hex');
export const senderPolicy = settings => hash(JSON.stringify(Object.fromEntries(['feeRate', 'feeMargin', 'postageSats', 'dustSats', 'contentBytes', 'maxFundingSats', 'maxFeeSats'].map(k => [k, settings[k]]))));
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
  decorate(row, status) {
    if (row.kind !== 'tap' || !validDestination(row.payer, this.network) || !validDestination(row.receiver, this.network)) return status;
    const snapshot = readSenderJSON(join(this.settings.directory, 'status', row.id + '.json'));
    const sender = snapshot?.keyId === this.keyId && snapshot.requestId === row.id && snapshot.payer === row.payer &&
      snapshot.receiver === row.receiver && SENDER_STATES.has(snapshot.mintSender?.state) ? snapshot.mintSender : null;
    const offer = this.settings.enabled && status.payable && ['awaiting_payment', 'partly_paid'].includes(status.state) && this.ready() &&
      (!sender || sender.state === 'waiting_funding');
    return { ...status, ...(offer ? { mintFunding: { address: this.address(row.id), satoshis: this.satoshis, feeRate: this.settings.feeRate, label: 'your mint inscription' } } : {}),
      ...(sender || offer ? { mintSender: sender ?? { state: 'waiting_funding' } } : {}) };
  }
  page(mints, params) {
    const after = params.get('after') ?? '', limit = Number(params.get('limit') ?? this.settings.pageSize);
    check((after === '' || validRequestId(after)) && Number.isSafeInteger(limit) && limit > 0 && limit <= this.settings.pageSize, 'mint_sender_page');
    const page = mints.store.list('mints', { after, limit });
    const counted = mints.store.get('meta', 'ruleState')?.counted ?? null;
    return { keyId: this.keyId, rows: page.filter(r => validRequestId(r.id) && r.value.kind === 'tap' && validDestination(r.value.payer, this.network) && validDestination(r.value.receiver, this.network))
      .map(({ id, value }) => ({ requestId: id, receiver: value.receiver, payer: value.payer,
        payBy: { rail: value.kind, untilBlock: value.expiry ?? value.request.expires }, counted, fundingAddress: this.address(id) })),
      next: page.length === limit ? page.at(-1).id : null };
  }
  close() { this.seed.fill(0); }
}
