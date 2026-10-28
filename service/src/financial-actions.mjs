import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { buildFinancialExecution } from './financial-execution.mjs';

// Only typed owner actions enter through HTTP. Internal settlement/recovery
// actions remain coordinator work reconstructed from independent sources.
export class FinancialActions {
  constructor({ financial, reads, store }) { Object.assign(this, { financial, reads, store }); }
  async submit(action) {
    check(action && ['credit-use', 'credit-transfer', 'custody-claim'].includes(action.type), 'financial_owner_action');
    const transition = { type: 'lifecycle', id: action.id, action }, id = rules.hashObject(['dmw-financial-transition-v2', transition]);
    if (this.store.get('financialAccepted', id) || this.store.get('financialQueue', id)) return this.status(id);
    const at = await this.reads.batchStamp();
    await buildFinancialExecution({ store: this.store, reads: this.reads, transitions: [transition], document: this.financial.document, height: at.counted, at });
    await this.financial.submit(transition); return this.status(id);
  }
  status(id) {
    check(rules.hex(id, 32), 'financial_action_id');
    const accepted = this.store.get('financialAccepted', id), queued = this.store.get('financialQueue', id);
    check(accepted || queued, 'financial_action_unknown', 404);
    return { id, state: accepted ? 'accepted' : 'queued', ...(accepted ? { accepted } : {}), reason: this.store.get('financialDeferred', id)?.reason ?? null };
  }
}
