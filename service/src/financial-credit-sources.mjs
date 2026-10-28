import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { paymentCreditDigest } from '../../contract/payment-pages.js';
import { rules } from './rules.mjs';
import { check } from './util.mjs';

// Credit authority comes from the accepted notary record. Neither the request
// nor the gateway's journal can supply an owner, balance or accepted revision.
export function installCreditSources(reads, { network }) {
  reads.financialCreditEvidence = async (action, at) => {
    const op = action.operation, credit = op && await reads.financialRecord('fc/' + op.credit, at);
    check(['credit-use', 'credit-transfer'].includes(action.type) && op?.op === 'fp' && op.v === 2 && op.id === action.id &&
      op.type === (action.type === 'credit-use' ? 'use' : 'transfer') && credit && credit.revision === op.revision &&
      rules.compareOrdinal(at.counted, op.until) <= 0 && typeof op.sig === 'string' && /^[0-9a-f]{128}$/.test(op.sig) &&
      ed25519.verify(op.sig, paymentCreditDigest(network, op), credit.owner, { zip215: false }), 'financial_credit_authorization');
    if (op.type === 'use') {
      const target = await reads.financialRecord('fp/' + op.id, at);
      check(target?.state === 'open' && target.owner === credit.owner && Array.isArray(op.items) && op.items.length > 0 &&
        new Set(op.items.map(i => i.fee)).size === op.items.length, 'financial_credit_target');
      for (const item of op.items) {
        const source = credit.fees.find(f => f.key === item.fee), index = target.fees.findIndex(f => f.key === item.fee);
        check(source && index >= 0 && /^[1-9][0-9]*$/.test(item.amount) && BigInt(source.amount) >= BigInt(item.amount) &&
          BigInt(target.paid[index]) + BigInt(item.amount) <= BigInt(target.fees[index].amount), 'financial_credit_amount');
      }
      const link = await reads.financialRecord('fl/' + op.id, at);
      check(!link || rules.compareOrdinal(at.counted, link.until) <= 0, 'financial_link_payment_late');
    } else check(op.id === op.credit && rules.hex(op.to, 32), 'financial_credit_owner');
    return { requestId: action.id, state: 'authorized', operation: rules.hashObject(op), owner: credit.owner,
      revision: credit.revision, credit: rules.hashObject(credit) };
  };
}
