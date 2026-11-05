import { rules } from './rules.mjs';
import { check } from './util.mjs';

// The signed quote pins the payment mode and holder. Accepted reservations
// retain this destination even if the deployment inscription moves later.
export async function directHolderTerms(reads, deployment, document, { rail = 'tap', at, bitcoinNetwork = reads.bindings?.bitcoinNetwork ?? 'mainnet' } = {}) {
  if (!document?.values.deployerShareBps) return { version: 1, to: null };
  // The Ethereum escrow pays a fixed set of recipients, so an Ethereum quote
  // names no holder and the deployer share stays in the burn.
  if (rail !== 'tap') return { version: 1, to: null };
  check(typeof reads.deploymentHolders === 'function', 'deployer_holder_reader', 503);
  const holders = await reads.deploymentHolders([deployment.id], at);
  check(holders.length === 1 && holders[0].id === deployment.id, 'deployer_holder');
  return { version: 1, to: rules.legacyDeployHolderAddress(holders[0].address, bitcoinNetwork) };
}

export async function verifyDirectHolder(reads, quote, deployment, document, options = {}) {
  if (!quote.holderFees) return null;
  const current = await directHolderTerms(reads, deployment, document, options);
  check(rules.stableJSON(current) === rules.stableJSON(quote.holderFees), options.changed ?? 'quote_recipient_changed', 409);
  return current;
}

export const bulkHolderHash = (ownership, holderFees) => rules.hashObject(['dmw-bulk-direct-holder-v1', ownership, holderFees]);
export const bulkDeployerData = id => `dmw-bulk-deployer-v1|${id}`;
export const sideWalletItem = side => ({ address: side.to, tick: 'tap', amt: rules.formatTapAmount(side.amount), dta: side.dta });

export function validateDeployerPayment(side, terms, orderId) {
  check(rules.exactKeys(side, ['to', 'amount', 'dta']) && side.dta === bulkDeployerData(orderId) &&
    rules.tapAtoms(side.amount) > 0n && !rules.samePayer(side.to, terms.payer), 'bulk_deployer_payment');
  rules.legacyDeployHolderAddress(side.to, terms.bitcoinNetwork);
  return side;
}
