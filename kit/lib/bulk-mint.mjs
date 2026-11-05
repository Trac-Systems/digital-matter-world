import { hashObject, stableJSON } from '../../rules/src/core.js';
import { tapAtoms, formatTapAmount } from '../../rules/src/fees.js';
import { reserveNonceDigest } from '../../contract/root-accounts.js';
import { check, nonce, sha256 } from './check.mjs';
import { signBytes } from './signing.mjs';

// Load the shared wire grammar only on this new path. The other tracks publish
// this module; no local interpretation of Terms or fee fields is permitted.
const rules = () => import('../../rules/src/bulk-mint.js');
const active = new WeakMap();
function once(agent, key, intent, run) {
  let work = active.get(agent);
  if (!work) { work = new Map(); active.set(agent, work); }
  const fingerprint = hashObject(intent), previous = work.get(key);
  if (previous) { check(previous.fingerprint === fingerprint, 'Conflicting bulk action ID'); return previous.task; }
  const task = Promise.resolve().then(run);
  work.set(key, { fingerprint, task });
  task.finally(() => work.delete(key)).catch(() => {});
  return task;
}
const actionKey = actionId => {
  check(typeof actionId === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(actionId), 'Invalid bulk action ID');
  return 'bulk/' + actionId;
};
const idCheck = id => check(typeof id === 'string' && /^[0-9a-f]{64}$/.test(id), 'Invalid bulk order ID');

export async function quoteBulkMint(agent, args) {
  const { actionId, ...intent } = args, key = actionKey(actionId) + '/quote';
  check(Object.keys(intent).every(k => ['asset', 'deployment', 'blocks', 'receiver', 'payer'].includes(k)), 'Invalid bulk quote arguments');
  const { BULK_LIMITS, validateBulkTerms, validateBulkFees, bulkOrderId, validateBulkQuoteInput } = await rules();
  check(Array.isArray(intent.blocks) && intent.blocks.length > 0 && intent.blocks.length <= BULK_LIMITS.members &&
    intent.blocks.every(b => typeof b === 'string' && /^(0|[1-9][0-9]*)$/.test(b)) && new Set(intent.blocks).size === intent.blocks.length, 'Invalid bulk blocks');
  return once(agent, key, intent, async () => {
    let saved = agent.journal.get(key);
    if (saved) check(saved.fingerprint === sha256(stableJSON(intent)), 'Conflicting bulk action ID');
    // Saving before the preview means a lost quote reply also keeps its nonce.
    if (!saved) {
      const input = validateBulkQuoteInput({ v: 1, owner: agent.owner, nonce: nonce(), ...intent });
      saved = agent.journal.reserve(key, intent, { input });
    }
    if (saved.body.quote) return structuredClone(saved.body.quote);
    const quote = structuredClone(await agent.service.bulkMintQuote(saved.body.input));
    check(quote?.v === 1 && Array.isArray(quote.feeManifest) && Array.isArray(quote.skipped) && Array.isArray(quote.deferred), 'Invalid bulk quote');
    if (quote.terms === null) {
      check(quote.quoteId === null && quote.orderId === null && quote.feeManifest.length === 0 && quote.payable === false, 'Invalid empty bulk quote');
    } else {
      const terms = validateBulkTerms(quote.terms); validateBulkFees(terms, quote.feeManifest);
      check(terms.network === agent.network && terms.bitcoinNetwork === agent.bitcoinNetwork &&
        ['owner', 'nonce', 'asset', 'deployment', 'receiver', 'payer'].every(k => terms[k] === saved.body.input[k]) &&
        terms.members.every(m => intent.blocks.includes(m.block)), 'Bulk quote intent mismatch');
      check(quote.quoteId === hashObject(terms) && quote.orderId === bulkOrderId(agent.network, agent.owner, terms.nonce), 'Bulk quote commitment mismatch');
      check(quote.deferred.every(m => BigInt(m.block) > BigInt(terms.members.at(-1).block)), 'Bulk quote deferred prefix mismatch');
    }
    const covered = [...(quote.terms?.members ?? []), ...quote.skipped, ...quote.deferred].map(m => m.block);
    check(covered.length === intent.blocks.length && new Set(covered).size === covered.length && covered.every(b => intent.blocks.includes(b)), 'Bulk quote member coverage mismatch');
    agent.journal.completePreparation(key, saved.body, { ...saved.body, quote });
    return structuredClone(quote);
  });
}

export async function makeBulkMint(agent, args) {
  const { actionId, quoteId, maxPayableFeeAtoms, maxSetAsideSats, dryRun = false } = args;
  check(Object.keys(args).every(k => ['actionId', 'quoteId', 'maxPayableFeeAtoms', 'maxSetAsideSats', 'dryRun'].includes(k)), 'Invalid bulk request arguments');
  const key = actionKey(actionId), { validateBulkTerms, validateBulkFees, bulkReserveAction } = await rules();
  return once(agent, key, args, async () => {
    const quote = agent.journal.get(key + '/quote')?.body.quote;
    check(quote?.terms && quote.quoteId === quoteId, 'Saved bulk quote required');
    const terms = validateBulkTerms(quote.terms); validateBulkFees(terms, quote.feeManifest);
    check(hashObject(terms) === quoteId && terms.network === agent.network && terms.owner === agent.owner && terms.bitcoinNetwork === agent.bitcoinNetwork, 'Bulk quote commitment mismatch');
    tapAtoms(maxPayableFeeAtoms);
    check(BigInt(terms.payableFeeAtoms) <= BigInt(maxPayableFeeAtoms), 'Bulk TAP fee ceiling exceeded');
    check(Number.isSafeInteger(maxSetAsideSats) && maxSetAsideSats >= 0 && terms.mintFunding.satoshis <= maxSetAsideSats, 'Bulk Bitcoin set-aside ceiling exceeded');
    if (agent.dryRun || dryRun) return { state: 'dry-run', orderId: quote.orderId, quoteId, terms, feeManifest: quote.feeManifest, signed: false, sent: false };
    let saved = agent.journal.get(key);
    if (!saved) {
      const reserve = bulkReserveAction(terms);
      saved = agent.journal.reserve(key, { quoteId }, { version: 1, terms, feeManifest: quote.feeManifest,
        reserve: { ...reserve, sig: signBytes(agent.wallet, reserveNonceDigest(agent.network, reserve)) } });
    }
    check(saved.fingerprint === sha256(stableJSON({ quoteId })) && hashObject(saved.body.terms) === quoteId, 'Conflicting bulk action ID');
    agent.journal.mark(key, 'sending');
    try {
      const status = await agent.service.requestBulkMint(saved.body);
      check(status.orderId === quote.orderId && status.termsHash === quoteId, 'Bulk request commitment mismatch');
      const result = { ...status, paymentLink: bulkPaymentLink(agent, quote.orderId) };
      agent.journal.mark(key, 'submitted', result); return result;
    } catch (error) { agent.journal.mark(key, 'unknown'); throw error; }
  });
}

export async function pollBulkMint(agent, { orderId, offset = 0, limit = 64 }) {
  idCheck(orderId);
  const [status, members] = await Promise.all([agent.service.bulkMintStatus(orderId), agent.service.bulkMintMembers(orderId, { offset, limit })]);
  check(status.orderId === orderId && members.orderId === orderId, 'Bulk order ID mismatch');
  return { ...status, memberPage: members };
}

export function bulkPaymentLink(agent, id) {
  idCheck(id);
  return agent.service.paymentLink(id, agent.paymentOrigin, 'mint/bulk');
}

// A payment tool returns a human approval page and exact plan. It never spends.
export async function payBulkMint(agent, { orderId }) {
  idCheck(orderId);
  const { validateBulkTerms, validateBulkFees, bulkWalletItems, bulkOrderId } = await rules();
  const [status, response] = await Promise.all([agent.service.bulkMintStatus(orderId), agent.service.bulkMintTerms(orderId)]);
  const terms = validateBulkTerms(response.terms); validateBulkFees(terms, response.feeManifest);
  check(status.orderId === orderId && response.orderId === orderId && hashObject(terms) === status.termsHash &&
    bulkOrderId(terms.network, terms.owner, terms.nonce) === orderId && terms.network === agent.network && terms.bitcoinNetwork === agent.bitcoinNetwork, 'Bulk payment terms mismatch');
  // The ticker deployer is paid by one more transfer in the same approval, next to the fee groups.
  const side = response.deployerPayment, items = bulkWalletItems(terms);
  if (side) {
    check(side.dta === `dmw-bulk-deployer-v1|${orderId}` && typeof side.to === 'string' && side.to !== terms.payer && tapAtoms(side.amount) > 0n &&
      stableJSON(side) === stableJSON(status.deployerPayment ?? null), 'Bulk deployer payment mismatch');
    items.push({ address: side.to, tick: 'tap', amt: formatTapAmount(side.amount), dta: side.dta });
  }
  return { orderId, status, paymentLink: bulkPaymentLink(agent, orderId), items,
    extraOutputs: [{ address: terms.mintFunding.address, satoshis: terms.mintFunding.satoshis, label: terms.mintFunding.label }], sent: false };
}
