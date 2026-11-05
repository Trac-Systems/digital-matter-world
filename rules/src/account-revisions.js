import { assert } from './core.js';
import { uintV2 } from './integers-v2.js';

export function accountRevisionOwners(entries) {
  return [...new Set(entries.filter(({ move }) => ['craft-v2', 'transfer-v2'].includes(move.t)).map(({ move }) => move.a))].sort();
}

// Revisions are independently checked against accepted account records by the
// signers. The audit retains them so a stale authorization has an explicit
// outcome instead of preventing every other receipt in its batch executing.
export function accountRevisionMap(entries, rows) {
  const owners = accountRevisionOwners(entries);
  assert(Array.isArray(rows) && rows.length === owners.length, 'account_revision_evidence');
  rows.forEach((row, i) => {
    assert(Array.isArray(row) && row.length === 2 && row[0] === owners[i], 'account_revision_evidence');
    uintV2(row[1]);
  });
  return new Map(rows);
}
