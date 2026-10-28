import { assert, stableJSON } from './core.js';
import { merkleRoot } from './merkle.js';
import { encodeBinary } from './binary.js';

export function creditActions(operations) {
  const owners = new Map();
  for (const op of operations) {
    assert(op.op === 'ac', 'account_credit_source');
    const assets = owners.get(op.to) ?? new Map();
    for (const [asset, amount] of op.assets) assets.set(asset, (assets.get(asset) ?? 0n) + BigInt(amount));
    owners.set(op.to, assets);
  }
  return [...owners].sort(([a], [b]) => a < b ? -1 : 1).map(([owner, assets]) => ({ type: 'credits', owner,
    assets: [...assets].sort(([a], [b]) => a < b ? -1 : 1).map(([asset, n]) => [asset, String(n)]) }));
}
export const accountOperationsRoot = operations => merkleRoot(operations.filter(o => ['ar', 'fp'].includes(o.op)).map(encodeBinary));
export function verifyCreditOperations(credits, operations, crafts = []) {
  assert(Array.isArray(operations) && operations.every(o => o.op === 'ar' && o.v === 2 && Array.isArray(o.actions)), 'account_operations');
  assert(stableJSON([...creditActions(credits), ...crafts.map(c => c.action)]) === stableJSON(operations.flatMap(o => o.actions)), 'account_credit_derivation');
  return operations;
}
