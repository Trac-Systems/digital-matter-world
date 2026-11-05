import { TapWalletBulkMint as BaseBulkMint, bulkPaymentPlan as basePaymentPlan } from './tap-wallet-bulk-mint.mjs';
import { bulkAddress } from '../../rules/src/bulk-mint.js';
import { exactKeys, stableJSON } from '../../rules/src/core.js';
import { formatTapAmount, tapAtoms } from '../../rules/src/fees.js';
import { ensure } from './inscription-core.mjs';

// The site serves this adapter to existing dashboards. The signed five-role
// bulk manifest and the installed kit's validation remain unchanged.
export function bulkPaymentPlan(orderId, status, response, network) {
  const plan = basePaymentPlan(orderId, status, response, network);
  const side = response.deployerPayment;
  ensure(stableJSON(side ?? null) === stableJSON(status.deployerPayment ?? null), 'Bulk deployer payment changed');
  if (!side) return plan;
  ensure(exactKeys(side, ['to', 'amount', 'dta']) && side.dta === `dmw-bulk-deployer-v1|${orderId}` &&
    tapAtoms(side.amount) > 0n && side.to !== plan.terms.payer, 'Invalid bulk deployer payment');
  bulkAddress(side.to, network);
  return { ...plan, items: [...plan.items, { address: side.to, tick: 'tap', amt: formatTapAmount(side.amount), dta: side.dta }] };
}

export class TapWalletBulkMint extends BaseBulkMint {
  async plan(id) {
    const [status, response] = await Promise.all([this.readStatus(id), this.readTerms(id)]);
    return { status, ...bulkPaymentPlan(id, status, response, this.network) };
  }
}
