import { gatewayRowsRoot, iterableRoot, migrationGatewayRows, pendingRows } from './migration-pages.mjs';
import { rules as r } from './rules.mjs';

// Offline cutover inventory. Counts are evidence, never an authorization to
// discard a row. Include zeroes for the kinds absent from the live inventory.
export function pendingInventory(rows, records = new Map()) {
  const spaces = {};
  if (rows.db) for (const { space, n } of rows.db.prepare('SELECT space,count(*) AS n FROM records GROUP BY space').iterate()) spaces[space] = n;
  else for (const [space] of rows) spaces[space] = (spaces[space] ?? 0) + 1;
  rows = pendingRows(rows);
  const state = rows.find(([s, id]) => s === 'meta' && id === 'ruleState')?.[2] ?? {};
  const admitted = new Set(rows.filter(([s]) => s === 'mintAdmissions').map(([, id]) => id));
  const unaccepted = new Set(rows.filter(([s, id, v]) => ['mints', 'activeMints', 'mintInputs', 'mintDeferred'].includes(s) &&
    !admitted.has(id) && !records.has('m/' + id) && (s !== 'mints' || v.state !== 'minted')).map(([, id]) => id));
  let notaryCustody = 0;
  for (const key of records.keys()) if (/^(?:cu|custody|fc)\/|^fi\/custody\//.test(key)) notaryCustody++;
  const unsupported = {
    custody: rows.filter(([s]) => /custody/i.test(s)).length + notaryCustody,
    ethereumLinks: rows.filter(([s, , v]) => ['linkRequests', 'linkIntents', 'linkObligations'].includes(s) &&
      (v.kind === 'ethereum' || v.terms?.kind === 'ethereum' || v.request?.kind === 'ethereum' || v.terms?.chainId)).length,
    unacceptedMintAdmissions: unaccepted.size,
    craftReceipts: rows.filter(([s, , v]) => s.startsWith('intake/') && v.move?.t === 'craft').length
  };
  return { version: 1, sourceRoot: gatewayRowsRoot(rows), spaces,
    ruleState: Object.fromEntries(['rounds', 'discoveryIndexes', 'discoveryQueue', 'discoveryCommits'].map(k => [k,
      Array.isArray(state[k]) ? state[k].length : Object.keys(state[k] ?? {}).length])), unsupported };
}

export function requireSupportedInventory(inventory) {
  const items = Object.entries(inventory.unsupported).filter(([, n]) => n > 0);
  if (items.length) throw Error('pending_activation_refused: ' + items.map(([kind, n]) => kind + '=' + n).join(', '));
}
