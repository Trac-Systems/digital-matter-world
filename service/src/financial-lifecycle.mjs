import { releaseCreditClaims } from './mint-credits.mjs';
import { rules } from './rules.mjs';
import { assetResources } from './asset-resources.mjs';

// Called inside Pipeline's accepted-batch transaction. These are local queue
// projections, never substitutes for accepted financial records or evidence.
export function financialTerminalOperations(store, input, batch) {
  const t = input.transition, a = t.action, id = t.id, writes = [];
  if (t.type === 'consume') writes.push({ space: 'financialCustodyPending', id, value: true });
  if (a?.type === 'link-reserve') {
    writes.push({ space: 'financialLinkIntents', id, value: { id, owner: a.owner, block: a.block, until: a.until } },
      { space: 'activeFinancialLinks', id, value: true }, { space: 'activeFinancialLinksByOwner/' + a.owner, id, value: true });
  }
  const terminal = ['consume', 'refund'].includes(t.type) || ['link-complete', 'link-exit', 'legacy-link-complete', 'legacy-link-exit', 'capacity-finish'].includes(a?.type);
  if (!terminal) return writes;
  for (const space of ['mints', 'linkRequests', 'financialLinkIntents', 'financialLinks']) {
    const row = store.get(space, id);
    if (row) writes.push(...releaseCreditClaims(store, row));
  }
  if (a?.type.startsWith('link-') || a?.type.startsWith('legacy-link-')) {
    const row = store.get('financialLinkIntents', id) ?? store.get('linkIntents', id);
    const owner = row?.owner ?? row?.request?.owner;
    writes.push(...['activeFinancialLinks', 'financialLinkRecovery', 'financialLinkFailures', 'activeLinks', 'linkRecovery'].map(space => ({ space, id })),
      ...(owner ? [{ space: 'activeFinancialLinksByOwner/' + owner, id }, { space: 'activeLinksByOwner/' + owner, id }] : []),
      { space: 'financialPendingLinks', id }, ...(owner ? [{ space: 'financialLinkOwner/' + owner, id }] : []),
      ...(store.get('financialLinks', id)?.work ? [{ space: 'financialQueue', id: store.get('financialLinks', id).work }, { space: 'financialDeferred', id: store.get('financialLinks', id).work }] : []),
      { space: 'linkStatus', id, value: { state: a.type.endsWith('link-complete') ? 'accepted' : input.evidence.state === 'credit' ? 'credited' : 'refunded', batch } });
    for (const type of ['link-complete', 'link-exit']) {
      const queued = rules.hashObject(['dmw-financial-transition-v2', { type: 'lifecycle', id, action: { type, id } }]);
      writes.push({ space: 'financialQueue', id: queued }, { space: 'financialDeferred', id: queued });
    }
  }
  return writes;
}

// Bounded fair local scheduling. Expired obligations leave admission slots but
// remain in a durable reconciliation index until a batch settles them. Neither
// an unavailable source nor a restart discards their accepted payment identity.
export class FinancialLinkReconciler {
  constructor({ store, financial, reads, resources }) { Object.assign(this, { store, financial, reads }); this.resources = assetResources(resources); }
  async tick(height, at) {
    for (const space of ['activeFinancialLinks', 'financialLinkRecovery']) {
      const after = this.store.get('financialLinkCursors', space) ?? '';
      let rows = this.store.list(space, { after, limit: this.resources.workPage });
      if (!rows.length && after) rows = this.store.list(space, { limit: this.resources.workPage });
      for (const { id } of rows) {
        const row = this.store.get('financialLinkIntents', id), accepted = this.store.get('accountRecords', 'fl/' + id);
        if (!row || accepted?.state !== 'reserved') continue;
        if (rules.compareOrdinal(height, row.until) > 0 && space === 'activeFinancialLinks') await this.store.transact([
          { space, id }, { space: 'activeFinancialLinksByOwner/' + row.owner, id }, { space: 'financialLinkRecovery', id, value: true }]);
        const funding = this.store.get('accountRecords', 'fp/' + id);
        const complete = funding?.state === 'open' && funding.fees.every((fee, i) => fee.amount === funding.paid[i]);
        if (!complete && rules.compareOrdinal(height, row.until) <= 0) continue;
        const transition = { type: 'lifecycle', id, action: { type: complete ? 'link-complete' : 'link-exit', id } };
        try {
          try {
            await this.reads.financialEvidence(transition, at);
            await this.financial.submit(transition);
          } catch (error) {
            if (!complete) throw error;
            // Full funding is not proof the entitlement still exists. A
            // separately proved exit may resolve an invalidated paid link.
            const exit = { type: 'lifecycle', id, action: { type: 'link-exit', id } };
            await this.reads.financialEvidence(exit, at); await this.financial.submit(exit);
          }
        } catch (error) {
          await this.store.put('financialLinkFailures', id, { height, reason: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_evidence_unavailable' });
        }
      }
      await this.store.put('financialLinkCursors', space, rows.at(-1)?.id ?? '');
    }
  }
}
