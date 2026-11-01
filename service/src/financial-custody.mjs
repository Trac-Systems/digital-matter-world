import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { custodyReceipt, custodyPaymentData, custodyEthereumData } from './financial-custody-sources.mjs';
import { financialFeeKey } from './financial-fee-identity.mjs';

export class FinancialCustody {
  constructor({ store, reads, financial, network }) { Object.assign(this, { store, reads, financial, network }); }
  async tick() {
    const space = 'financialCustodyPending', after = this.store.get('financialCursors', space) ?? '';
    let rows = this.store.list(space, { after, limit: this.financial.resources.workPage });
    if (!rows.length && after) rows = this.store.list(space, { limit: this.financial.resources.workPage });
    for (const { id } of rows) {
      try {
        const at = await this.reads.batchStamp(), actions = await this.reads.financialCustodyAccruals(id, at); let done = true;
        for (const action of actions) {
          if (await this.reads.financialRecord('bc/' + action.id, at)) continue;
          done = false;
          const transition = { type: 'lifecycle', id: action.id, action };
          await this.reads.financialEvidence(transition, at); await this.financial.submit(transition);
        }
        if (done) await this.store.transact([{ space, id }, { space: 'financialCustodyFailures', id }]);
      } catch (error) {
        await this.store.put('financialCustodyFailures', id, /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_custody_unavailable');
      }
    }
    await this.store.put('financialCursors', space, rows.at(-1)?.id ?? '');
  }
  async status(id) {
    check(rules.hex(id, 32), 'financial_custody_id');
    const at = await this.reads.batchStamp(), row = await this.reads.financialRecord('bc/' + id, at);
    check(row, 'financial_custody_missing', 404);
    const mint = this.store.get('mints', row.request), fee = mint?.context?.kind === 'bulk-v1' ?
      (await this.reads.bulkCustodyOriginal(row, at)).fee : mint?.reservationEvidence?.feeItems.find(f => financialFeeKey(f) === row.fee);
    check(fee, 'financial_custody_terms');
    const blocked = this.store.get('meta', 'financialRecoveryActive') || await this.reads.financialRecord('fr/active', at) ? 'financial_recovery_active' :
      await this.reads.financialRecord('fq/bc/' + id, at) || await this.reads.financialRecord('fq/fp/' + row.request, at) ? 'financial_quarantined' : null;
    const payout = blocked || row.state !== 'paying' ? null : row.rail === 'tap' ? { rail: 'tap', from: row.custodian,
      items: [{ address: row.destination, tick: fee?.ticker ?? 'tap', amt: rules.formatTapAmount(row.amount), dta: custodyPaymentData(row.claim) }] } :
      { rail: 'ethereum', from: row.custodian, chainId: fee?.financialIdentity.domain[1], to: fee?.financialIdentity.domain[2], data: custodyEthereumData(row) };
    return { id, ...row, payout, blocked: blocked ? [blocked] : [] };
  }
  async payment({ id, reference, index }) {
    const row = await this.status(id); check(row.state === 'paying', 'financial_custody_claim');
    check(typeof reference === 'string' && reference.length <= 100 && Number.isSafeInteger(index) && index >= 0, 'financial_custody_reference');
    const mint = this.store.get('mints', row.request), fee = mint?.context?.kind === 'bulk-v1' ?
      (await this.reads.bulkCustodyOriginal(row, await this.reads.batchStamp())).fee : mint?.reservationEvidence?.feeItems.find(f => financialFeeKey(f) === row.fee);
    check(fee, 'financial_custody_terms');
    const hint = { claim: row.claim, reference, index };
    const action = { type: 'custody-settle', id, claim: row.claim, receipt: custodyReceipt(this.network, fee.financialIdentity.domain, hint) };
    const transition = { type: 'lifecycle', id, action };
    await this.reads.financialCustodyEvidence(action, await this.reads.batchStamp(), hint);
    await this.store.put('financialCustodyPayments', action.receipt, hint);
    return this.financial.submit(transition);
  }
}
