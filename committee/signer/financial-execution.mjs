import { applyRootAccounts } from '../../contract/root-accounts.js';
import { applyPaymentPage } from '../../contract/payment-pages.js';
import { accountSettings } from '../../rules/src/account-settings.js';
import { financialPlan, financialOperationShape } from '../../rules/src/financial-execution.js';
import { check, equal } from './crypto.mjs';
import { verifyCreditOperations } from '../../rules/src/account-batch.js';
import { hashObject } from '../../rules/src/core.js';
import { compareOrdinal } from '../../rules/src/integers-v2.js';
import { applyBeaconRecovery } from '../../contract/beacon/recovery.js';
import { claimsNeverCloseActive } from '../../rules/src/public-mint.js';

// Read accepted financial records from the independent notary snapshot, not
// from gateway replay context. Sequential simulation checks each page against
// predecessor effects and verifies all root proofs before signing.
export async function verifyFinancialExecution({ files, reads, document, network, height, at }) {
  check(typeof reads.financialRecord === 'function' && typeof reads.financialEvidence === 'function', 'financial_source_adapter_required');
  if (reads.financialScope) {
    const snapshot = await reads.batchStamp();
    check(!at || compareOrdinal(at.counted, snapshot.counted) === 0 && equal(at.last, snapshot.last) &&
      (at.revision === undefined || at.revision === snapshot.revision) && (at.tipHash === undefined || at.tipHash === snapshot.tipHash), 'financial_snapshot_changed');
    at = snapshot;
  }
  const changed = new Map(), store = { get: async key => changed.has(key) ? changed.get(key) : await reads.financialRecord(key, at),
    put: (key, value) => changed.set(key, value), del: key => changed.set(key, null) }, settings = accountSettings(document);
  const reservations = new Map(), sources = reads.financialScope?.({ record: store.get, reservations }) ?? reads;
  const apply = async op => {
    if (op.op === 'ar') await applyRootAccounts(store, op, { network, height, settings });
    else if (op.op === 'fp') await applyPaymentPage(store, op, { network, height, settings });
    else if (op.op === 'br') {
      const deployment = await reads.financialBeaconConfig();
      await applyBeaconRecovery(store, op, { ...deployment.beacon, poster: null, integerVersion: 2, settings });
    }
    else throw Error('financial_operation');
  };
  for (const file of files) {
    const inputs = file.financialOperations ?? [], financialCount = inputs.reduce((n, i) => n + i.operations.length, 0);
    check(financialCount <= file.ops.length && equal(file.ops.slice(file.ops.length - financialCount), inputs.flatMap(i => i.operations)), 'financial_operation_binding');
    const prefix = file.ops.slice(0, file.ops.length - financialCount);
    // These files have already passed deterministic claim/craft/transfer replay. Bind
    // the complete prefix to those results before applying any account effect.
    const credits = (file.settlements ?? []).flatMap(s => s.winners ?? []).map(w =>
      ({ op: 'ac', to: w.winner, assets: [[w.asset, String(w.count)]] }));
    verifyCreditOperations(credits, prefix, file.crafts ?? [], file.transfers ?? []);
    for (const op of prefix) await apply(op);
    for (const input of inputs) {
      let evidence = await sources.financialEvidence(input.transition, at);
      if (input.transition.type === 'public-scan' && claimsNeverCloseActive(document, height)) {
        // Full rules replay already derived this decision after agent closure
        // and moves. The external scan is read at the accepted predecessor and
        // therefore cannot itself observe same-observation claim reservations.
        evidence = { ...evidence, claim: input.evidence.claim };
      }
      check(equal(evidence, input.evidence), 'financial_evidence_read');
      const chainAnchor = reads.financialChainAnchor && input.transition.type !== 'beacon-recovery' && !input.transition.action?.type.startsWith('recovery-') ?
        await reads.financialChainAnchor({ at, prior: await store.get('fp/chain'), ethereum: evidence.ethereumAnchor }) : undefined;
      check(equal(chainAnchor ?? null, input.chainAnchor ?? null), 'financial_chain_evidence');
      const plan = await financialPlan({ transition: input.transition, evidence, ...(chainAnchor ? { chainAnchor } : {}) }, { read: store.get, height, document });
      check(equal(plan, input.operations.map(financialOperationShape)), 'financial_effects');
      const before = new Map(changed);
      for (const op of input.operations) await apply(op);
      if (input.recordCommitments || reads.financialChainAnchor) {
        const commitments = [];
        for (const [key, value] of changed) {
          const old = before.has(key) ? before.get(key) : await reads.financialRecord(key, at);
          if (!equal(value ?? null, old ?? null)) commitments.push([key, hashObject(value ?? null)]);
        }
        commitments.sort(([a], [b]) => a < b ? -1 : 1);
        check(equal(commitments, input.recordCommitments), 'financial_record_commitments');
      }
      if (input.transition.type === 'reserve' || input.transition.action?.type === 'link-reserve') reservations.set(input.transition.id, evidence);
    }
  }
}
