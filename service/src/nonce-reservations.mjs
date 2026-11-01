import { financialPlan, mergedReservePlans } from '../../rules/src/financial-execution.js';
import { rules } from './rules.mjs';

// Derive every reservation independently at the same predecessor, then prove
// all balances/nonces in one account change. Funding/capacity/checkpoints keep
// their individual request identities and deterministic queue order.
export async function executeNonceReservations({ execution, transitions, sources, reads, document, height, at }) {
  const inputs = [];
  for (const transition of transitions) {
    const evidence = await sources.financialEvidence(transition,
      rules.legacyDeployShareActive(height) || rules.multiTickerActive(height) || rules.freeLinkActive(height) ? { ...at, executionHeight: height } : at);
    inputs.push({ transition, evidence });
  }
  const plans = [];
  for (const input of inputs) plans.push(await financialPlan(input, { read: key => execution.getAsync(key), height, document }));
  const merged = mergedReservePlans(plans);
  for (const [i, input] of inputs.entries()) {
    const before = new Map(execution.changed), plan = merged[i];
    if (reads.financialChainAnchor) {
      input.chainAnchor = await reads.financialChainAnchor({ at, prior: await execution.getAsync('fp/chain'), ethereum: input.evidence.ethereumAnchor });
      plan.push({ op: 'fp', v: 2, type: 'checkpoint', id: input.transition.id,
        previous: rules.hashObject(await execution.getAsync('fp/chain') ?? null), anchor: input.chainAnchor });
    }
    input.operations = [];
    for (const op of plan) input.operations.push(op.op === 'ar' ? await execution.accounts(op.actions) : await execution.payment(op));
    input.recordCommitments = [];
    for (const [key, value] of execution.changed) {
      const old = before.has(key) ? before.get(key) : await execution.base(key);
      if (rules.stableJSON(value ?? null) !== rules.stableJSON(old ?? null)) input.recordCommitments.push([key, rules.hashObject(value ?? null)]);
    }
    input.recordCommitments.sort(([a], [b]) => a < b ? -1 : 1);
  }
  inputs[0].reserveGroup = inputs.length;
  return inputs;
}
