import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { rules } from './rules.mjs';
import { check, hash } from './util.mjs';

export const QUOTE_MILLISECONDS = 300000;
export const QUOTE_BLOCKS = 2016;
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,37}$/.test(value) && BigInt(value) <= rules.TAP_MAX_ATOMS;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bytes = (domain, value) => Buffer.from(domain + '|' + rules.stableJSON(value));
const revisionId = (baseFee, activeFrom) => hash(bytes('dmw-fee-policy-v1', { baseFee, activeFrom }));
export const mintFeeScope = (asset, block, kind) => rules.stableJSON(['mint', asset, block ?? null, kind]);

export function createFeePolicy(baseFee, activeFrom = 0) {
  check(positive(baseFee) && integer(activeFrom), 'fee_policy');
  const revision = { id: revisionId(baseFee, activeFrom), baseFee, activeFrom, retiredAt: null };
  return { current: revision.id, revisions: [revision] };
}

export function validateFeePolicy(registry) {
  const p = registry.feePolicy;
  check(p, 'feePolicy is required in the operator registry');
  check(Object.keys(p).every(k => ['current', 'revisions'].includes(k)) && Array.isArray(p.revisions) && p.revisions.length > 0, 'fee_policy');
  const ids = new Set();
  for (const [i, r] of p.revisions.entries()) {
    const next = p.revisions[i + 1];
    check(r && positive(r.baseFee) && integer(r.activeFrom) && r.id === revisionId(r.baseFee, r.activeFrom) && !ids.has(r.id) &&
      (next ? integer(r.retiredAt) && r.retiredAt > r.activeFrom && r.retiredAt === next.activeFrom : r.retiredAt === null && r.id === p.current), 'fee_policy');
    ids.add(r.id);
  }
  for (const configured of [registry.link, ...Object.values(registry.assets ?? {})]) {
    check(!configured || !Object.hasOwn(configured, 'baseFee'), 'base_fee_must_be_in_feePolicy_only');
  }
  return p;
}

export function currentFee(registry) {
  return validateFeePolicy(registry).revisions.at(-1);
}

// Retain every revision so admitted requests can be verified after live changes.
export function changeBaseFee(registry, baseFee, now = Date.now()) {
  check(positive(baseFee) && integer(now) && now > 0, 'base_fee');
  const previous = currentFee(registry);
  if (previous.baseFee === baseFee) return registry;
  check(now > previous.activeFrom, 'fee_change_clock');
  const next = { id: revisionId(baseFee, now), baseFee, activeFrom: now, retiredAt: null };
  const revisions = registry.feePolicy.revisions.map(r => r.id === previous.id ? { ...r, retiredAt: now } : r);
  return { ...registry, feePolicy: { current: next.id, revisions: [...revisions, next] } };
}

export class FeeQuotes {
  constructor({ network, gateway, secret, registry, now = Date.now }) {
    Object.assign(this, { network, registry, now });
    if (secret) this.privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secret)]), format: 'der', type: 'pkcs8' });
    this.publicKey = gateway ? createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(gateway, 'hex')]), format: 'der', type: 'spki' }) : this.privateKey ? createPublicKey(this.privateKey) : null;
  }
  sign(domain, payload) { check(this.privateKey, 'fee_quote_issuer'); return { ...payload, signature: sign(null, bytes(domain, payload), this.privateKey).toString('hex') }; }
  verify(domain, signed) {
    check(signed && this.publicKey && typeof signed.signature === 'string' && /^[0-9a-f]{128}$/.test(signed.signature), 'fee_quote_signature');
    const { signature, ...payload } = signed;
    check(verify(null, bytes(domain, payload), this.publicKey, Buffer.from(signature, 'hex')), 'fee_quote_signature'); return payload;
  }
  async issue(scope, counted, payouts, deploymentId, mintOwnershipHash) {
    const started = this.now(), registry = await this.registry(), revision = currentFee(registry);
    // A replacement may land while the registry read is in flight. Either
    // snapshot has a valid issuance instant without delaying the new rate.
    const issuedAt = Math.max(started, revision.activeFrom);
    check(integer(issuedAt) && issuedAt <= this.now() && integer(counted) && integer(counted + QUOTE_BLOCKS), 'fee_quote_clock');
    return this.sign('dmw-fee-quote-v1', { network: this.network, scope, revision: revision.id, baseFee: revision.baseFee, unit: rules.TAP_UNIT,
      issuedAt, expiresAt: issuedAt + QUOTE_MILLISECONDS, validFrom: counted, validUntil: counted + QUOTE_BLOCKS, ...(payouts ? { payouts } : {}), ...(deploymentId ? { deploymentId } : {}), ...(mintOwnershipHash ? { mintOwnershipHash } : {}) });
  }
  async validate(quote, scope) {
    const q = this.verify('dmw-fee-quote-v1', quote), registry = await this.registry();
    const revision = validateFeePolicy(registry).revisions.find(r => r.id === q.revision);
    check(q.network === this.network && q.scope === scope && rules.stableJSON(q.unit) === rules.stableJSON(rules.TAP_UNIT) && positive(q.baseFee) && revision && revision.id === q.revision && revision.baseFee === q.baseFee &&
      revision.id === revisionId(revision.baseFee, revision.activeFrom), 'fee_quote_policy');
    check(integer(q.issuedAt) && q.issuedAt >= revision.activeFrom && (revision.retiredAt === null || q.issuedAt <= revision.retiredAt) &&
      q.expiresAt === q.issuedAt + QUOTE_MILLISECONDS && integer(q.validFrom) && integer(q.validUntil) && q.validUntil === q.validFrom + QUOTE_BLOCKS, 'fee_quote_window');
    return q;
  }
  async accept(quote, scope, id, until, counted) {
    const q = await this.validate(quote, scope), at = this.now();
    check(at >= q.issuedAt && at <= q.expiresAt && integer(counted) && counted >= q.validFrom && integer(until) && until > counted && until <= q.validUntil, 'fee_quote_expired', 409);
    return this.sign('dmw-fee-acceptance-v1', { network: this.network, quote, id, until, counted, at });
  }
  async accepted(authorization, scope, id, until) {
    const a = this.verify('dmw-fee-acceptance-v1', authorization), q = await this.validate(a.quote, scope);
    check(a.network === this.network && a.id === id && a.until === until && integer(a.counted) && a.counted >= q.validFrom && integer(until) && until > a.counted && until <= q.validUntil &&
      integer(a.at) && a.at >= q.issuedAt && a.at <= q.expiresAt, 'fee_quote_binding');
    return { baseFee: q.baseFee };
  }
}
