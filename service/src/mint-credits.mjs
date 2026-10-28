import { hash } from './util.mjs';
import { rules } from './rules.mjs';

export const creditSpace = ({ owner, payer, rail }) => 'mintUsable/' + hash(JSON.stringify([owner, payer, rail]));
export const releaseCreditClaims = (store, row) => (row.creditIds ?? [])
  .filter(id => store.get('creditClaims', id) === row.id).map(id => ({ space: 'creditClaims', id }));

// Commit the liability and its usable index in the same durable transaction.
export function creditOperations(store, row, items) {
  const prior = store.get('mintCredits', row.id);
  const value = { owner: row.request.owner, payer: row.payer, rail: row.kind, items };
  return [
    ...(prior ? [{ space: creditSpace(prior), id: row.id }] : []),
    { space: 'mintCredits', id: row.id, ...(items.length ? { value } : {}) },
    ...(items.length ? [{ space: creditSpace(value), id: row.id, value: true }] : []),
  ];
}

// Migration is a resumable bounded background step, never a full-history
// fallback on a request. Later lexical records become reachable across ticks.
export async function migrateCreditPage(store, limit) {
  const cursor = store.get('assetMaintenance', 'creditIndex');
  if (cursor?.done) return;
  const page = store.list('mintCredits', { after: cursor?.after ?? '', limit });
  await store.transact([
    ...page.filter(r => r.value.items?.length).map(r => ({ space: creditSpace(r.value), id: r.id, value: true })),
    { space: 'assetMaintenance', id: 'creditIndex', value: { after: page.at(-1)?.id ?? cursor?.after ?? '', done: page.length < limit } },
  ]);
}

export async function selectCredits(store, { owner, payer, rail, fees }, settings) {
  await migrateCreditPage(store, settings.creditPage);
  const space = creditSpace({ owner, payer, rail }), after = store.get('creditCursors', space) ?? '';
  let page = store.list(space, { after, limit: settings.creditPage });
  if (!page.length && after) page = store.list(space, { limit: settings.creditPage });
  const selected = [], cleanup = []; let visited = '';
  for (const { id } of page) {
    visited = id;
    const value = store.get('mintCredits', id);
    if (!value?.items?.length) { cleanup.push({ space, id }); continue; }
    if (!store.get('creditClaims', id) && value.items.some(item => fees.some(fee => rules.sameFee(fee, item)))) selected.push(id);
    if (selected.length === settings.creditSources) break;
  }
  await store.transact([...cleanup, { space: 'creditCursors', id: space, value: visited }]);
  return selected;
}

export function surplusReceipts(row) {
  const allocated = new Map((row.progress?.allocations ?? []).map(p => [p.key, BigInt(p.amount)]));
  return (row.payment?.receipts ?? []).filter(p => p.origin === row.id && p.accepted && p.confirmations >= 1)
    .map(p => ({ ...p, used: (BigInt(p.used ?? '0') + (allocated.get(p.key) ?? 0n)).toString() }))
    .filter(p => BigInt(p.amount) > BigInt(p.used));
}
