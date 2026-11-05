import { assert, hash, stableJSON, hex, integer } from './core.js';
import { tapBurnAddress } from './tap-burn.js';
import { tapAtoms, formatTapAmount } from './fees.js';

// Amounts at every server/contract boundary are atomic TAP. Conversion to the
// wallet's decimal strings happens only when building its redeem items.
export function mintFeeItems(split, destinations, requestId = null, payer = null, rail = 'tap', bitcoinNetwork = 'mainnet') {
  // A quoted holder destination selects direct payment. Retained quotes keep
  // their deferred shares in the treasury item.
  const direct = typeof destinations.deployer === 'string';
  if (split.legacyDeploy || split.deployer && !direct) split = { ...split, treasury: String(BigInt(split.treasury) + BigInt(split.legacyDeploy ?? '0') + BigInt(direct ? '0' : split.deployer ?? '0')) };
  return ['finder', 'firstMaker', 'discoverer', 'landowner', 'treasury', 'burn', ...(direct ? ['deployer'] : [])]
    .filter(role => BigInt(split[role] ?? '0') > 0n).map(role => {
      const to = role === 'burn' ? (rail === 'tap' ? tapBurnAddress(bitcoinNetwork) : null) : destinations[role];
      assert(role === 'burn' || typeof to === 'string' && to.length > 0, (role === 'firstMaker' ? 'first_maker' : role) + '_address_missing');
      return { role, to, ticker: 'tap', amount: tapAtoms(split[role]).toString(), tt: role === 'burn' && rail === 'ethereum' ? 'b' : 'a',
        ...(requestId ? { dta: `dmw-pay-v2|${requestId}|${role}` } : {}) };
    }).filter(item => item.role === 'burn' || !payer || !samePayer(item.to, payer));
}
export const samePayer = (address, payer) => /^0x[0-9a-fA-F]{40}$/.test(payer) ? address?.toLowerCase() === payer.toLowerCase() : address === payer;
export function walletFeeItems(items, bitcoinNetwork = 'mainnet') {
  // TAP burns are exact address transfers to the burn address of the selected Bitcoin network.
  assert(items.every(item => item.tt === 'a' && (item.role !== 'burn' || item.to === tapBurnAddress(bitcoinNetwork))), 'tap_payment_item');
  return items.map(item => ({ tick: item.ticker, amt: formatTapAmount(item.amount), address: item.to, dta: item.dta }));
}
export const sameFee = (a, b) => ['role', 'to', 'ticker', 'tt'].every(k => a[k] === b[k]);
export const paymentItemKey = (rail, reference) => hash(stableJSON(['dmw-payment-item-v2', rail, reference]));

// Each receipt is independently read from the chain. Allocation amounts may
// be smaller than a receipt, allowing a late payment credit to fund a new quote.
// The Trac mc operation atomically accounts for every receipt's used amount.
export function paymentProgress(fees, receipts, { confirmations = 1 } = {}) {
  const remaining = fees.map(fee => ({ ...fee })), allocations = [], seen = new Set();
  let observed = false;
  for (const receipt of receipts) {
    assert(hex(receipt.key, 32) && !seen.has(receipt.key), 'payment_duplicate'); seen.add(receipt.key);
    assert(integer(receipt.confirmations) && receipt.confirmations >= 0 && typeof receipt.accepted === 'boolean', 'payment_evidence');
    const amount = tapAtoms(receipt.amount), used = tapAtoms(receipt.used ?? '0');
    assert(amount >= used, 'payment_used');
    const fee = remaining.find(item => sameFee(item, receipt));
    if (!fee || !receipt.accepted || amount === used) continue;
    observed = true;
    if (receipt.confirmations < confirmations) continue;
    const available = amount - used, wanted = BigInt(fee.amount);
    const allocated = available < wanted ? available : wanted;
    if (allocated === 0n) continue;
    fee.amount = (wanted - allocated).toString();
    allocations.push({ key: receipt.key, amount: allocated.toString(), total: receipt.amount });
  }
  const missing = remaining.filter(fee => fee.amount !== '0');
  return { seen: observed, missing, allocations, final: missing.length === 0,
    state: missing.length === 0 ? 'paid' : observed ? 'partly_paid' : 'awaiting_payment' };
}
export const paymentCommitment = allocations => hash(JSON.stringify(allocations.map(p => [p.key, p.amount, p.total])));
