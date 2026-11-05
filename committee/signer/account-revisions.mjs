import { rules } from './adapter.mjs';
import { check, equal } from './crypto.mjs';

export async function verifyAccountRevisions(context, reads) {
  if (!context.inputs.some(i => i.accountRevisions !== undefined)) return;
  check(typeof reads.financialRecord === 'function', 'account_revision_reader');
  const revisions = new Map(), at = { counted: context.counted, last: context.last };
  for (const input of context.inputs) {
    if (input.accountRevisions !== undefined) {
      rules.accountRevisionMap(input.entries, input.accountRevisions);
      const expected = [];
      for (const owner of rules.accountRevisionOwners(input.entries)) {
        if (!revisions.has(owner)) revisions.set(owner, (await reads.financialRecord('ar/' + owner, at))?.revision ?? '0');
        expected.push([owner, revisions.get(owner)]);
      }
      check(equal(input.accountRevisions, expected), 'account_revision_read');
    }
    // Replay binds these operations to the audit, and contract preflight
    // validates their proofs and predecessor revisions before any signature.
    for (const op of [...(input.accountOperations ?? []), ...(input.financialOperations ?? []).flatMap(i => i.operations)]) {
      if (op.op === 'ar') for (const account of op.accounts) revisions.set(account.owner, rules.nextUint(account.revision));
    }
  }
}
