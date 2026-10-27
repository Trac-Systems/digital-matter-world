import { check } from './util.mjs';
import { same } from './deployments.mjs';

// Each continuation segment grants its finds a full finder window from the
// height at which that segment was credited. Authenticate that exact audit.
export async function auditedFind({ id, asset, block, pattern, hint, batch, audits }) {
  for (const file of await audits(batch)) {
    if (file.height !== hint.findHeight) continue;
    for (const settlement of file.settlements) {
      if (settlement.void || settlement.window !== hint.window) continue;
      const winner = settlement.winners.find(w => w.id === id);
      if (!winner) continue;
      const result = { block: winner.block, pattern: winner.pattern, asset: winner.asset, count: winner.count,
        finder: winner.winner, findHeight: file.height, window: settlement.window, source: winner.source };
      check(result.block === block && result.pattern === pattern.number && result.asset === asset && same(result, hint), 'find_audit_binding');
      return result;
    }
  }
  throw Error('find_audit_missing');
}
