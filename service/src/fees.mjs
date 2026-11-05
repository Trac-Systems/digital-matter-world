import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { rules } from './rules.mjs';
import { check, hash } from './util.mjs';

export const QUOTE_MILLISECONDS = 300000;
export const QUOTE_BLOCKS = 2016;
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,37}$/.test(value) && BigInt(value) <= rules.TAP_MAX_ATOMS;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bytes = (domain, value) => Buffer.from(domain + '|' + rules.stableJSON(value));
const settingsField = feeSettings => feeSettings === undefined ? {} : { feeSettings };
const withinQuote = (q, counted, until) => q.settingsHash ?
  rules.compareUint(rules.decimalV2(counted), q.validFrom) >= 0 && rules.compareUint(rules.decimalV2(until), rules.decimalV2(counted)) > 0 && rules.compareUint(rules.decimalV2(until), q.validUntil) <= 0 :
  integer(counted) && counted >= q.validFrom && integer(until) && until > counted && until <= q.validUntil;
// Omitted settings retain the original revision hash and the original defaults.
// Zero revisions record the operator's execution height, separately from wall time.
// This authenticates stored policy only; admission always checks the batch height.
const revisionHeight = executionHeight => executionHeight === undefined ? {} : { executionHeight };
const revisionId = (baseFee, activeFrom, feeSettings, executionHeight) => hash(bytes('dmw-fee-policy-v1', { baseFee, activeFrom, ...settingsField(feeSettings), ...revisionHeight(executionHeight) }));
export const LAUNCH_FEE_SETTINGS = Object.freeze({ ...rules.FEE_DEFAULTS, link: 3 });
export function validateFeeSettings(settings, executionHeight = '0') {
  const multiplier = n => Number.isSafeInteger(n) && n >= 1 && n <= 10000;
  check(settings && Object.keys(settings).sort().join(',') === 'compoundMinimum,link,tierMultipliers' &&
    Array.isArray(settings.tierMultipliers) && settings.tierMultipliers.length === 5 &&
    [...settings.tierMultipliers, settings.compoundMinimum].every(multiplier) &&
    (multiplier(settings.link) || settings.link === 0 && rules.freeLinkActive(executionHeight)), 'fee_settings');
  return settings;
}
export const feeSettingsField = settingsField;
export const mintFeeScope = (asset, block, kind) => rules.stableJSON(['mint', asset, block ?? null, kind]);
export function mintOwnershipMatches(quote, { bitmap, link, assetRevision }) {
  const old = { bitmap, link };
  return quote.mintOwnershipHash === hash(rules.stableJSON({ ...old, ...(assetRevision ? { assetRevision } : {}) })) ||
    !quote.settingsHash && quote.mintOwnershipHash === hash(rules.stableJSON(old));
}

export async function issueFeeTerms(reads, kind, id, until, counted) {
  const policy = (await reads.registry())[kind]; check(policy, kind + '_unconfigured');
  const scope = `${kind}/${id}`, quote = await reads.feeQuotes.issue(scope, counted);
  return { ...policy, baseFee: quote.baseFee, ...settingsField(quote.feeSettings),
    ...(quote.settingsHash ? { settingsHash: quote.settingsHash } : {}),
    feeAuthorization: await reads.feeQuotes.accept(quote, scope, id, until, counted) };
}
export async function validateQuotedTerms(reads, kind, row) {
  // An activated legacy link is pinned by the terminal notary. Registry
  // destination changes cannot replace the terms of its original lock.
  const imported = kind === 'link' && await reads.financialRecord?.('fi/source/' + row.id);
  if (imported?.legacy?.kind === 'link') {
    const original = imported.legacy.original;
    check(row.id === imported.requestId && ['request', 'sig', 'terms'].every(key =>
      rules.stableJSON(row[key]) === rules.stableJSON(original[key])), 'link_import_terms');
    return row.terms;
  }
  const configured = (await reads.registry())[kind]; check(configured, kind + '_unconfigured');
  const { payer, hash, feeAuthorization, ...policy } = row.terms;
  const fee = await reads.feeQuotes.accepted(feeAuthorization, `${kind}/${row.id}`, row.id, row.request.until);
  check(rules.stableJSON(policy) === rules.stableJSON({ ...configured, ...fee }), kind + '_policy');
  return row.terms;
}

export function createFeePolicy(baseFee, activeFrom = 0, feeSettings, executionHeight = '0') {
  check(positive(baseFee) && integer(activeFrom), 'fee_policy');
  if (feeSettings !== undefined) validateFeeSettings(feeSettings, executionHeight);
  const height = feeSettings?.link === 0 ? rules.decimalV2(executionHeight) : undefined;
  const revision = { id: revisionId(baseFee, activeFrom, feeSettings, height), baseFee, activeFrom, retiredAt: null, ...settingsField(feeSettings), ...revisionHeight(height) };
  return { current: revision.id, revisions: [revision] };
}

export function validateFeePolicy(registry) {
  if (typeof registry.currentFee === 'function') return { current: registry.metadata.feeCurrent, revisions: [registry.currentFee()] };
  const p = registry.feePolicy;
  check(p, 'feePolicy is required in the operator registry');
  check(Object.keys(p).every(k => ['current', 'revisions'].includes(k)) && Array.isArray(p.revisions) && p.revisions.length > 0, 'fee_policy');
  const ids = new Set();
  for (const [i, r] of p.revisions.entries()) {
    const next = p.revisions[i + 1];
    if (r?.feeSettings !== undefined) validateFeeSettings(r.feeSettings, r.executionHeight ?? '0');
    check(r && positive(r.baseFee) && integer(r.activeFrom) && r.id === revisionId(r.baseFee, r.activeFrom, r.feeSettings, r.executionHeight) && !ids.has(r.id) &&
      (next ? integer(r.retiredAt) && r.retiredAt > r.activeFrom && r.retiredAt === next.activeFrom : r.retiredAt === null && r.id === p.current), 'fee_policy');
    for (const kind of ['find', 'compound', 'link']) for (let tier = 1; tier <= 5; tier++) rules.feeFor(kind, r.baseFee, tier, r.feeSettings, r.executionHeight ?? '0');
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

// A live policy may extend its launch pin but may never rewrite old terms.
export function validateFeeHistory(policy, pinned) {
  validateFeePolicy({ feePolicy: policy }); validateFeePolicy({ feePolicy: pinned });
  check(policy.revisions.length >= pinned.revisions.length, 'fee_policy_history');
  for (const [i, old] of pinned.revisions.entries()) {
    const next = policy.revisions[i];
    check(rules.stableJSON({ ...next, retiredAt: old.retiredAt }) === rules.stableJSON(old) &&
      (old.retiredAt === null || next.retiredAt === old.retiredAt), 'fee_policy_history');
  }
}

// Retain every revision so admitted requests can be verified after live changes.
export function changeBaseFee(registry, baseFee, now = Date.now()) {
  return changeFeePolicy(registry, { baseFee }, now);
}
export function changeFeePolicy(registry, changes, now = Date.now(), executionHeight = '0') {
  check(changes && Object.keys(changes).length > 0 && Object.keys(changes).every(k => ['baseFee', 'link', 'tierMultipliers', 'compoundMinimum'].includes(k)), 'fee_changes');
  const previous = currentFee(registry);
  const { baseFee = previous.baseFee, ...multipliers } = changes;
  check(positive(baseFee) && integer(now) && now > 0, 'base_fee');
  const feeSettings = Object.keys(multipliers).length ? validateFeeSettings({ ...rules.FEE_DEFAULTS, ...previous.feeSettings, ...multipliers }, executionHeight) : previous.feeSettings;
  if (previous.baseFee === baseFee && rules.stableJSON(settingsField(previous.feeSettings)) === rules.stableJSON(settingsField(feeSettings))) return registry;
  check(now > previous.activeFrom, 'fee_change_clock');
  const next = createFeePolicy(baseFee, now, feeSettings, executionHeight).revisions[0];
  const revisions = registry.feePolicy.revisions.map(r => r.id === previous.id ? { ...r, retiredAt: now } : r);
  const updated = { ...registry, feePolicy: { current: next.id, revisions: [...revisions, next] } };
  validateFeePolicy(updated); return updated;
}

export class FeeQuotes {
  constructor({ network, gateway, secret, registry, now = Date.now, settings, settingsHistory }) {
    Object.assign(this, { network, registry, now, settings, settingsHistory });
    if (secret) this.privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secret)]), format: 'der', type: 'pkcs8' });
    this.publicKey = gateway ? createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(gateway, 'hex')]), format: 'der', type: 'spki' }) : this.privateKey ? createPublicKey(this.privateKey) : null;
  }
  sign(domain, payload) { check(this.privateKey, 'fee_quote_issuer'); return { ...payload, signature: sign(null, bytes(domain, payload), this.privateKey).toString('hex') }; }
  verify(domain, signed) {
    check(signed && this.publicKey && typeof signed.signature === 'string' && /^[0-9a-f]{128}$/.test(signed.signature), 'fee_quote_signature');
    const { signature, ...payload } = signed;
    check(verify(null, bytes(domain, payload), this.publicKey, Buffer.from(signature, 'hex')), 'fee_quote_signature'); return payload;
  }
  async issue(scope, counted, payouts, deploymentId, mintOwnershipHash, holderFees) {
    const started = this.now(), registry = await this.registry(), revision = currentFee(registry);
    const document = await this.settings?.() ?? this.document, policy = document?.values;
    if (revision.feeSettings) validateFeeSettings(revision.feeSettings, counted);
    if (document) {
      rules.validateSettingsDocument(document, counted);
      check(document.network === this.network && policy.feePolicyRevision === revision.id &&
        policy.linkMultiplier === (revision.feeSettings ?? rules.FEE_DEFAULTS).link, 'fee_settings_pin');
    }
    const blocks = policy?.quoteLifetimeTips ?? QUOTE_BLOCKS, milliseconds = policy?.quoteLifetimeMs ?? QUOTE_MILLISECONDS;
    // A replacement may land while the registry read is in flight. Either
    // snapshot has a valid issuance instant without delaying the new rate.
    const issuedAt = Math.max(started, revision.activeFrom);
    const validFrom = document ? rules.decimalV2(counted) : counted, validUntil = document ? rules.addUint(validFrom, String(blocks)) : counted + blocks;
    check(integer(issuedAt) && issuedAt <= this.now() && integer(issuedAt + milliseconds) &&
      (document || integer(validFrom) && integer(validUntil)), 'fee_quote_clock');
    return this.sign('dmw-fee-quote-v1', { network: this.network, scope, revision: revision.id, baseFee: revision.baseFee, unit: rules.TAP_UNIT,
      ...settingsField(revision.feeSettings),
      ...(document ? { settingsHash: rules.hashObject(document) } : {}),
      ...(holderFees ? { holderFees } : {}),
      issuedAt, expiresAt: issuedAt + milliseconds, validFrom, validUntil, ...(payouts ? { payouts } : {}), ...(deploymentId ? { deploymentId } : {}), ...(mintOwnershipHash ? { mintOwnershipHash } : {}) });
  }
  async validate(quote, scope) {
    const q = this.verify('dmw-fee-quote-v1', quote), registry = await this.registry();
    const revision = typeof registry.feeRevision === 'function' ? registry.feeRevision(q.revision) : validateFeePolicy(registry).revisions.find(r => r.id === q.revision);
    let policy;
    if (q.settingsHash !== undefined) {
      const document = await this.settingsHistory?.get(q.settingsHash) ?? this.document;
      check(document && rules.hashObject(document) === q.settingsHash && document.network === this.network, 'fee_settings_history');
      rules.validateSettingsDocument(document); policy = document.values;
      check(policy.feePolicyRevision === q.revision && policy.linkMultiplier === (q.feeSettings ?? rules.FEE_DEFAULTS).link, 'fee_settings_pin');
    }
    check(q.network === this.network && q.scope === scope && rules.stableJSON(q.unit) === rules.stableJSON(rules.TAP_UNIT) && positive(q.baseFee) && revision && revision.id === q.revision && revision.baseFee === q.baseFee &&
      revision.id === revisionId(revision.baseFee, revision.activeFrom, revision.feeSettings, revision.executionHeight) &&
      rules.stableJSON(settingsField(q.feeSettings)) === rules.stableJSON(settingsField(revision.feeSettings)), 'fee_quote_policy');
    const heightWindow = policy ? rules.uintV2(q.validUntil) === rules.addUint(rules.uintV2(q.validFrom), String(policy.quoteLifetimeTips)) :
      integer(q.validFrom) && integer(q.validUntil) && q.validUntil === q.validFrom + QUOTE_BLOCKS;
    check(integer(q.issuedAt) && q.issuedAt >= revision.activeFrom && (revision.retiredAt === null || q.issuedAt <= revision.retiredAt) &&
      integer(q.expiresAt) && q.expiresAt === q.issuedAt + (policy?.quoteLifetimeMs ?? QUOTE_MILLISECONDS) && heightWindow, 'fee_quote_window');
    return q;
  }
  async accept(quote, scope, id, until, counted) {
    const q = await this.validate(quote, scope), at = this.now();
    if (q.feeSettings) validateFeeSettings(q.feeSettings, counted);
    if (q.settingsHash) { counted = rules.decimalV2(counted); until = rules.decimalV2(until); }
    check(at >= q.issuedAt && at <= q.expiresAt && withinQuote(q, counted, until), 'fee_quote_expired', 409);
    return this.sign('dmw-fee-acceptance-v1', { network: this.network, quote, id, until, counted, at });
  }
  async accepted(authorization, scope, id, until) {
    const a = this.verify('dmw-fee-acceptance-v1', authorization), q = await this.validate(a.quote, scope);
    if (q.settingsHash) until = rules.decimalV2(until);
    check(a.network === this.network && a.id === id && a.until === until && withinQuote(q, a.counted, until) &&
      integer(a.at) && a.at >= q.issuedAt && a.at <= q.expiresAt, 'fee_quote_binding');
    return { baseFee: q.baseFee, ...settingsField(q.feeSettings), ...(q.settingsHash ? { settingsHash: q.settingsHash } : {}) };
  }
}
