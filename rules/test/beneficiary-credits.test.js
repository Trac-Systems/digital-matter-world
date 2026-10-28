import test from 'node:test';
import assert from 'node:assert/strict';
import { beneficiaryFeePlan, verifyBeneficiaryFunding } from '../src/beneficiary-credits.js';
import { hash } from '../src/core.js';
test('an absent beneficiary receives a funded claimable liability without a guessed payout address', () => {
  const input = { split: { finder: '30', treasury: '70' }, destinations: { treasury: 'treasury' }, beneficiaries: { finder: hash('finder') },
    requestId: hash('request'), payer: 'payer', rail: 'tap', bitcoinNetwork: 'regtest' };
  assert.throws(() => beneficiaryFeePlan(input), /beneficiary_custody_required/);
  const plan = beneficiaryFeePlan({ ...input, suspense: { tap: 'approved-custodian' } });
  assert.equal(plan.fees[0].to, 'approved-custodian'); assert.equal(plan.credits[0].owner, hash('finder'));
  const receipt = { ...plan.fees[0], key: hash('receipt'), origin: input.requestId, accepted: true, confirmations: 1 };
  assert.equal(verifyBeneficiaryFunding(plan.credits[0], receipt).state, 'claimable');
  for (const changed of [{ confirmations: 0 }, { amount: '29' }, { to: 'other' }, { origin: hash('other') }]) {
    assert.throws(() => verifyBeneficiaryFunding(plan.credits[0], { ...receipt, ...changed }), /beneficiary_unfunded/);
  }
});
