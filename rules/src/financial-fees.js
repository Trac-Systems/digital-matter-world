import { assert } from './core.js';
import { multiTickerActive } from './multi-ticker-activation.js';
import { TICKER_DEPLOY_SETTINGS } from './settings-v2.js';
import { splitFee } from './fees.js';

// Activated economics are pinned by the request's settings hash. Legacy fee
// splitting retains its original byte-for-byte behavior in fees.js.
export function financialSplit(total, { kind, linked = false, discovered = false, publicMint = false, executionHeight = '0' }, document) {
  const n = BigInt(total), v = document.values, cut = bps => n * BigInt(bps) / 10000n;
  let firstMaker = 0n, finder = 0n, landowner = 0n, burn = 0n, discoverer = 0n;
  if (kind === 'compound') { firstMaker = cut(v.firstMakerShareBps); burn = cut(v.compoundBurnBps); }
  else if (kind === 'find') {
    finder = publicMint ? 0n : cut(v.finderShareBps); landowner = linked ? cut(v.landownerShareBps) : 0n;
    burn = cut(v.findBurnBps) + (linked ? 0n : cut(v.unlinkedBurnBps));
    discoverer = discovered ? cut(v.discovererShareBps) : 0n;
  } else if (kind === 'ticker') {
    assert(multiTickerActive(executionHeight), 'fee_kind');
    const bps = v.tickerDeployBurnBps ?? TICKER_DEPLOY_SETTINGS.tickerDeployBurnBps;
    assert(Number.isSafeInteger(bps) && bps >= 0 && bps <= 10000, 'financial_fee_split');
    burn = cut(bps);
  } else { assert(kind === 'link', 'fee_kind'); burn = cut(v.linkBurnBps); }
  const treasury = n - firstMaker - finder - landowner - burn - discoverer;
  assert(treasury >= 0n, 'financial_fee_split');
  return Object.fromEntries(Object.entries({ firstMaker, finder, landowner, burn, treasury, discoverer }).map(([k, x]) => [k, x.toString()]));
}

// Retained link locks used a fixed split. Only execution height may select the
// new rule; their witness/payment heights cannot activate it. New v2 links
// already used financialSplit and continue to do so unchanged.
export function linkPaymentSplit(total, document, executionHeight = '0') {
  if (!multiTickerActive(executionHeight)) return splitFee(total, { kind: 'link' });
  assert(document?.values && Number.isSafeInteger(document.values.linkBurnBps) &&
    document.values.linkBurnBps >= 0 && document.values.linkBurnBps <= 10000, 'link_settings');
  return financialSplit(total, { kind: 'link' }, document);
}
