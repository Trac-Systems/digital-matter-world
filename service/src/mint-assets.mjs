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
