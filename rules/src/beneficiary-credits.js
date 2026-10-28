import { assert, hash, stableJSON, hex } from './core.js';
import { mintFeeItems } from './mint-payments.js';

// Suspense custody is an explicit activated rail setting, never an invented
// address. The payer's terms pin both custody and the beneficiary liability.
export function beneficiaryFeePlan({ split, destinations, beneficiaries, requestId, payer, rail, bitcoinNetwork, suspense }) {
  const resolved = { ...destinations }, credits = [];
  for (const role of ['finder', 'firstMaker', 'discoverer', 'landowner']) {
    if (BigInt(split[role] ?? '0') === 0n || resolved[role]) continue;
    assert(hex(beneficiaries[role], 32), 'beneficiary_identity');
    assert(typeof suspense?.[rail] === 'string' && suspense[rail].length > 0, 'beneficiary_custody_required');
    assert(suspense[rail] !== payer, 'beneficiary_custody_payer');
    resolved[role] = suspense[rail];
    credits.push({ id: hash(stableJSON(['dmw-beneficiary-credit-v2', requestId, role])), requestId, role,
      owner: beneficiaries[role], rail, custodian: suspense[rail], amount: split[role] });
  }
  return { fees: mintFeeItems(split, resolved, requestId, payer, rail, bitcoinNetwork), credits };
}

export function verifyBeneficiaryFunding(credit, receipt) {
  assert(receipt?.accepted === true && receipt.confirmations >= 1 && receipt.origin === credit.requestId && receipt.role === credit.role &&
    receipt.to === credit.custodian && receipt.amount === credit.amount && hex(receipt.key, 32), 'beneficiary_unfunded');
  return { ...credit, paymentKey: receipt.key, state: 'claimable' };
}
