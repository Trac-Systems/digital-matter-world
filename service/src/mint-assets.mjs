import { rules } from './rules.mjs';
import { check } from './util.mjs';

export const deploymentAssetId = asset => typeof asset === 'string' &&
  (/^[pc][0-9a-z]{1,23}$/.test(asset) || /^p2:(0|[1-9][0-9]*)$/.test(asset));

// Imported finds and balances keep the v1 ledger key. The p2 catalog key is
// only an alias for those patterns, never a second pool of mintable units.
export function patternCatalogId(asset) {
  if (/^p2:(0|[1-9][0-9]*)$/.test(asset)) return asset;
  if (!/^p[0-9a-z]{1,23}$/.test(asset)) return null;
  let number = 0n;
  for (const digit of asset.slice(1)) number = number * 36n + BigInt(parseInt(digit, 36));
  return 'p2:' + number;
}

// Public catalog rows use p2 ids; imported mint records retain the original
// ledger id. Resolve that alias at read time without duplicating mint counts.
export function patternMint(store, asset, block) {
  const catalog = patternCatalogId(asset), pattern = catalog && store.get('patternsByAsset', catalog);
  const ledger = pattern?.legacy?.asset ?? asset;
  return store.get('minted', `${ledger}/${block}`) ?? (catalog && store.get('minted', `${catalog}/${block}`)) ?? null;
}

export async function mintAssetDefinition(store, requestedAsset) {
  check(deploymentAssetId(requestedAsset), 'deployment_asset');
  const catalogAsset = patternCatalogId(requestedAsset);
  const pattern = catalogAsset && await store.get('patternsByAsset', catalogAsset);
  if (pattern) {
    const asset = pattern.legacy?.asset ?? catalogAsset;
    check(requestedAsset === catalogAsset || requestedAsset === asset, 'asset_unknown');
    const definition = pattern.legacy?.record ?? Object.fromEntries(
      ['number', 'name', 'pat', 'fld', 'dt', 'discoverer'].filter(k => pattern[k] !== undefined).map(k => [k, pattern[k]]));
    return { asset, catalogAsset, definition };
  }
  const definition = requestedAsset.startsWith('p2:') ? null : requestedAsset.startsWith('p') ?
    (await store.get('meta', 'patterns') ?? []).find(p => rules.patternAsset(p) === requestedAsset) : await store.get('types', requestedAsset);
  check(definition, 'asset_unknown');
  return { asset: requestedAsset, catalogAsset: requestedAsset, definition };
}
