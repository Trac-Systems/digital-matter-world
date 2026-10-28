import { assert } from './core.js';

// Activated economics are pinned by the request's settings hash. Legacy fee
// splitting retains its original byte-for-byte behavior in fees.js.
export function financialSplit(total, { kind, linked = false, discovered = false }, document) {
  const n = BigInt(total), v = document.values, cut = bps => n * BigInt(bps) / 10000n;
  let firstMaker = 0n, finder = 0n, landowner = 0n, burn = 0n, discoverer = 0n;
  if (kind === 'compound') { firstMaker = cut(v.firstMakerShareBps); burn = cut(v.compoundBurnBps); }
  else if (kind === 'find') {
    finder = cut(v.finderShareBps); landowner = linked ? cut(v.landownerShareBps) : 0n;
    burn = cut(v.findBurnBps) + (linked ? 0n : cut(v.unlinkedBurnBps));
    discoverer = discovered ? cut(v.discovererShareBps) : 0n;
  } else { assert(kind === 'link', 'fee_kind'); burn = cut(v.linkBurnBps); }
  const treasury = n - firstMaker - finder - landowner - burn - discoverer;
  assert(treasury >= 0n, 'financial_fee_split');
  return Object.fromEntries(Object.entries({ firstMaker, finder, landowner, burn, treasury, discoverer }).map(([k, x]) => [k, x.toString()]));
}
