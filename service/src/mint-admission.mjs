import { check } from './util.mjs';
export const activeOwnerSpace = owner => 'activeMintsByOwner/' + owner;
export const reservingSpace = row => 'mintReserving/' + row.request.owner + '/' + row.request.asset;
export const releaseAdmission = row => [{ space: activeOwnerSpace(row.request.owner), id: row.id }, { space: reservingSpace(row), id: row.id }];
export async function migrateMintAdmission(store, limit) {
  const cursor = store.get('assetMaintenance', 'mintAdmission');
  if (cursor?.done) return true;
  const page = store.list('activeMints', { after: cursor?.after ?? '', limit }), operations = [];
  for (const { id } of page) {
    const row = store.get('mints', id); check(row?.request, 'mint_admission_index');
    operations.push({ space: activeOwnerSpace(row.request.owner), id, value: true });
    if (row.state === 'reserving') operations.push({ space: reservingSpace(row), id, value: row.request.amount });
  }
  await store.transact([...operations, { space: 'assetMaintenance', id: 'mintAdmission', value: { after: page.at(-1)?.id ?? '', done: page.length < limit } }]);
  return page.length < limit;
}
export function reservedFor(store, row, limit) {
  const rows = store.list(reservingSpace(row), { limit });
  check(rows.length < limit, 'mint_owner_index_budget', 503);
  return rows.reduce((sum, r) => sum + (store.get('mints', r.id)?.state === 'reserving' ? BigInt(r.value) : 0n), 0n);
}
