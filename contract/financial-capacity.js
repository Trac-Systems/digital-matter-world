import { canonicalJSON, sha256, utf8ToBytes, bytesToHex } from './signing.js';
import { financialUnfrozen } from './financial-lifecycle.js';
const check = (ok, reason) => { if (!ok) throw Error(reason); };
const hash = value => bytesToHex(sha256(utf8ToBytes(canonicalJSON(value))));
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
export const capacityKey = deployment => 'fm/capacity/' + hash(deployment);
export const plotKey = (asset, block) => 'fm/plot/' + hash([asset, block]);

// Issued permits continue occupying capacity until a verified external
// terminal transition reconciles them. A source's remaining supply alone is
// never enough to grant two simultaneous reservations for the last unit.
export async function reserveFinancialCapacity(store, id, capacity) {
  const c = capacity;
  check(c && typeof c.deployment === 'string' && typeof c.asset === 'string' && uint(c.amount) && c.amount !== '0' && uint(c.remaining) && uint(c.limit), 'financial_capacity');
  const key = capacityKey(c.deployment), reserved = await store.get(key) ?? '0', imported = await store.get('fi/deployment/' + c.deployment) ?? '0';
  check(uint(reserved) && uint(imported) && BigInt(reserved) + BigInt(imported) + BigInt(c.amount) <= BigInt(c.remaining) &&
    (c.limit === '0' || BigInt(c.amount) <= BigInt(c.limit)), 'financial_capacity_reserved');
  const plot = c.block === null ? null : plotKey(c.asset, c.block);
  await financialUnfrozen(store, [key, 'fi/deployment/' + c.deployment, ...(plot ? [plot, 'fi/plot/' + c.asset + '/' + c.block] : [])]);
  check(!plot || !await store.get(plot) && !await store.get('fi/plot/' + c.asset + '/' + c.block), 'financial_plot_reserved');
  return [[key, (BigInt(reserved) + BigInt(c.amount)).toString()], ...(plot ? [[plot, { id, state: 'reserved' }]] : [])];
}
export async function releaseFinancialCapacity(store, id, capacity, { minted = false } = {}) {
  if (!capacity) return [];
  const key = capacityKey(capacity.deployment), reserved = await store.get(key);
  check(uint(reserved) && BigInt(reserved) >= BigInt(capacity.amount), 'financial_capacity_accounting');
  const plot = capacity.block === null ? null : plotKey(capacity.asset, capacity.block);
  await financialUnfrozen(store, [key, ...(plot ? [plot] : [])]);
  check(!plot || (await store.get(plot))?.id === id, 'financial_plot_identity');
  return [[key, (BigInt(reserved) - BigInt(capacity.amount)).toString()], ...(plot ? [[plot, minted ? { id, state: 'minted' } : null]] : [])];
}
