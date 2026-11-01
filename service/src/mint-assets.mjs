import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { patternCatalogId } from '../../rules/src/public-claims.js';
import { acceptedAssetProvenance } from './asset-provenance.mjs';
export { patternCatalogId };

export const compoundAssetV2 = asset => typeof asset === 'string' && /^c2:[0-9a-f]{64}$/.test(asset);
export const deploymentAssetId = asset => typeof asset === 'string' &&
  (/^[pc][0-9a-z]{1,23}$/.test(asset) || /^p2:(0|[1-9][0-9]*)$/.test(asset) || compoundAssetV2(asset));

// Imported finds and balances keep the v1 ledger key. The p2 catalog key is
// only an alias for those patterns, never a second pool of mintable units.
// Public catalog rows use p2 ids; imported mint records retain the original
// ledger id. Resolve that alias at read time without duplicating mint counts.
export function patternMint(store, asset, block, scope = null) {
  const catalog = patternCatalogId(asset), pattern = catalog && store.get('patternsByAsset', catalog);
  const ledger = pattern?.legacy?.asset ?? asset;
  return store.get('minted', rules.mintPlotKey(ledger, block, scope)) ?? (catalog && store.get('minted', rules.mintPlotKey(catalog, block, scope))) ?? (scope ? acceptedPlotStatus(store, ledger, block, scope).minted : null) ?? null;
}

export async function mintAssetDefinition(store, requestedAsset) {
  check(deploymentAssetId(requestedAsset), 'deployment_asset');
  const catalogAsset = patternCatalogId(requestedAsset);
  const pattern = catalogAsset && await store.get('patternsByAsset', catalogAsset);
  if (pattern) {
    const asset = pattern.legacy?.asset ?? catalogAsset;
    check(requestedAsset === catalogAsset || requestedAsset === asset, 'asset_unknown');
    const definition = pattern.legacy?.record ?? Object.fromEntries(
      ['number', 'name', 'pat', 'fld', 'dt', 'amountMode', 'discoverer'].filter(k => pattern[k] !== undefined).map(k => [k, pattern[k]]));
    return { asset, catalogAsset, definition };
  }
  // v2 crafts are stored under compoundTypes, with their first maker.
  const definition = requestedAsset.startsWith('p2:') ? null : requestedAsset.startsWith('p') ?
    (await store.get('meta', 'patterns') ?? []).find(p => rules.patternAsset(p) === requestedAsset) :
    await store.get(compoundAssetV2(requestedAsset) ? 'compoundTypes' : 'types', requestedAsset);
  check(definition, 'asset_unknown');
  // A compound merged into its deterministic id is never deployed or minted again.
  check(!definition.retired, 'compound_retired');
  return { asset: requestedAsset, catalogAsset: requestedAsset, definition };
}

// Signers take a v2 compound and its first maker from the notarized named state,
// the same proof mint signing reads, not from a gateway store row.
export async function acceptedCompoundDefinition(reads, asset) {
  check(compoundAssetV2(asset), 'deployment_asset');
  const { compound, maker } = await acceptedAssetProvenance({ store: reads.store, reads, asset });
  return { ...compound, firstMaker: maker };
}

// Public projections use only accepted point records. A deployment selection
// must be an immutable inscription id; omitted selections mean official.
export function selectedMintScope(store, asset, deployment, height) {
  if (!deployment) return null;
  check(typeof deployment === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(deployment), 'mint_deployment_selection');
  const generation = store.get('accountRecords', 'fd/external/' + rules.hashObject(deployment));
  const row = generation && store.get('accountRecords', 'fd/' + generation);
  const catalog = patternCatalogId(asset), ledger = catalog && store.get('patternsByAsset', catalog)?.legacy?.asset || asset;
  check(row?.asset === ledger && row.deployment === deployment, 'financial_deployment_pending', 409);
  return rules.tickerSupplyScope(row, height);
}
export function acceptedPlotStatus(store, asset, block, scope = null) {
  const id = store.get('accountRecords', rules.capacityPlotKey(asset, rules.decimalV2(block), scope));
  const capacity = id && store.get('accountRecords', 'dc/' + id);
  return { minted: capacity?.state === 'minted' ? { id } : null,
    pending: capacity && ['reserved', 'issued'].includes(capacity.state) ? { id, expiry: null, safeToReplace: false } : null };
}
