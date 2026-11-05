import { check } from './util.mjs';
import { rules } from './rules.mjs';

// Reader policy is shared by gateway and independent signer processes. The
// accepted settings schema cannot add keys without a contract parser release.
export const FINANCIAL_CHAIN_DEFAULTS = Object.freeze({ shallowReorgLimit: 6, rebaseBatchLimit: 1024 });
export function financialChainSettings(settings = {}) {
  check(settings && !Array.isArray(settings) && Object.keys(settings).every(k => Object.hasOwn(FINANCIAL_CHAIN_DEFAULTS, k)), 'financial_chain_settings');
  const result = { ...FINANCIAL_CHAIN_DEFAULTS, ...settings };
  check(Object.values(result).every(n => Number.isSafeInteger(n) && n >= 0), 'financial_chain_settings');
  return result;
}

const moneyFields = new Set(['payment', 'payments', 'receipt', 'receipts', 'refund', 'escrow', 'surplus', 'ethereumAnchor', 'confirmations', 'fundingRoot']);
const custodyKeys = ['amount', 'custodian', 'id', 'owner', 'rail', 'requestId', 'role'];
function custodyTerms(items, requestId) {
  return requestId && Array.isArray(items) && items.every(item => item &&
    rules.stableJSON(Object.keys(item).sort()) === rules.stableJSON(custodyKeys) && item.requestId === requestId &&
    ['finder', 'firstMaker', 'discoverer', 'landowner'].includes(item.role) &&
    item.id === rules.hashObject(['dmw-beneficiary-credit-v2', requestId, item.role]) && rules.hex(item.owner, 32) &&
    ['tap', 'ethereum'].includes(item.rail) && typeof item.custodian === 'string' && item.custodian.length > 0 &&
    typeof item.amount === 'string' && /^[1-9][0-9]*$/.test(item.amount));
}
function moneyEvidence(value, requestId) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    (moneyFields.has(key) || key === 'custody' && !custodyTerms(item, requestId)) && item != null && item !== false &&
      (!Array.isArray(item) || item.length > 0) || moneyEvidence(item));
}

// Fail closed for new transition/operation types. Reservations contain fee
// terms, not settled money. A credit expiry carries only the expiry decision;
// any earlier payment that backs it must pass the same suffix inspection.
export function moneyFreeFinancialInput(input, canonicalDeployment) {
  const t = input?.transition;
  if (!t || !input.evidence || !Array.isArray(input.operations) || !input.operations.length) return false;
  if (t.type === 'lifecycle' && ['deployment-open', 'deployment-add'].includes(t.action?.type)) {
    const { type, id, ...deployment } = t.action, e = input.evidence;
    // The accepted confirmation count is historical. Only an independently
    // verified canonical reveal permits this otherwise money-free registration.
    return canonicalDeployment === deployment.deployment && typeof canonicalDeployment === 'string' &&
      /^[0-9a-f]{64}i(0|[1-9][0-9]{0,9})$/.test(canonicalDeployment) && id === t.id &&
      rules.exactKeys(deployment, ['asset', 'deployment', 'maximum', 'limit', ...(type === 'deployment-open' ? ['generation', 'previous'] : ['official'])]) &&
      rules.exactKeys(e, ['requestId', 'state', 'confirmations', 'deployment', 'minted', 'outstanding', 'remaining']) &&
      e.requestId === id && e.state === 'deployed' && Number.isSafeInteger(e.confirmations) && e.confirmations >= 1 &&
      rules.stableJSON(e.deployment) === rules.stableJSON(deployment) && e.minted === '0' && e.outstanding === '0' && e.remaining === deployment.maximum &&
      input.operations.filter(op => op.type === 'lifecycle').length === 1 && input.operations.every(op => op.op === 'fp' &&
        (op.type === 'checkpoint' || op.type === 'lifecycle' && rules.stableJSON(op.action) === rules.stableJSON(t.action) && op.evidence === rules.hashObject(e)));
  }
  const reserve = t.type === 'reserve' || t.type === 'reserve-many';
  const expiry = t.type === 'refund' && t.reason === 'credit' && input.evidence.state === 'credit';
  const lifecycle = t.type === 'lifecycle' && ['capacity-reserve', 'capacity-release', 'link-reserve'].includes(t.action?.type);
  if (!reserve && !expiry && !lifecycle) return false;
  // The reservation's exact beneficiary fee plan promises future custody; it
  // proves no payment. Funded/claimable custody adds fields and stays refused.
  if (moneyEvidence(input.evidence, reserve || lifecycle && t.action.type === 'link-reserve' ? t.id : null)) return false;
  return input.operations.every(op => {
    if (op.op === 'ar') return Array.isArray(op.actions) && op.actions.every(a =>
      reserve ? ['reserve', 'reserve-n', 'snapshot-supply'].includes(a.type) : expiry && a.type === 'refund');
    if (op.op !== 'fp') return false;
    if (op.type === 'checkpoint') return true;
    if (op.type === 'open' || op.type === 'bulk-open') return reserve || lifecycle && t.action.type === 'link-reserve';
    if (op.type === 'credit') return expiry;
    return op.type === 'lifecycle' && (reserve && op.action?.type === 'capacity-reserve' ||
      expiry && op.action?.type === 'capacity-release' || lifecycle && op.action?.type === t.action.type);
  });
}

// A candidate still needs a fresh inclusion proof before the verifier can use
// it. This helper never treats the accepted confirmation count as that proof.
export function financialRebaseDeployment(input) {
  const id = input?.transition?.action?.deployment;
  return input?.transition?.type === 'lifecycle' && ['deployment-open', 'deployment-add'].includes(input.transition.action?.type) &&
    moneyFreeFinancialInput(input, id) ? id : null;
}
