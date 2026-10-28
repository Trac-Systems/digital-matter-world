import { rules } from './rules.mjs';
import { check } from './util.mjs';

export const assetCheckpoint = state => ({ named: state.namedSnapshot, claims: state.claimSnapshot });

// These descriptors are lookup hints. Only the independently read notary roots
// authorize a value, and every path (including absence) authenticates its nodes.
export async function acceptedAssetProvenance({ store, reads, asset, block }) {
  check(/^p2:(0|[1-9][0-9]*)$/.test(asset) || /^c2:[0-9a-f]{64}$/.test(asset), 'asset_provenance_id');
  const context = await reads.rulesContext(), checkpoint = await store.get('assetCheckpoint', 'current');
  check(context?.ready && checkpoint?.named && checkpoint.claims, 'asset_provenance_checkpoint');
  const { named, claims } = checkpoint;
  check(rules.hashObject(['dmw-named-state-v2', named.nextPattern, named.catalogRevision, named.catalogRoot]) === context.catalogRoot &&
    rules.claimStateRoot(claims) === context.claimsRoot, 'asset_provenance_root');
  const limits = rules.validateSettingsDocument(context.settings).values, cache = new Map(); let bytes = Buffer.byteLength(rules.stableJSON(checkpoint));
  check(bytes <= limits.proofBytes, 'asset_provenance_budget');
  const finish = async value => {
    const after = await reads.rulesContext();
    check(after.catalogRoot === context.catalogRoot && after.claimsRoot === context.claimsRoot, 'asset_provenance_changed');
    return { ...value, revision: rules.hashObject(['dmw-asset-provenance-v2', asset, value]) };
  };
  const get = async (space, pointer, commitment, key) => {
    if (!pointer) { check(commitment === rules.EMPTY_NAMED_ROOT, 'asset_provenance_empty'); return null; }
    const path = rules.hash(key); let offset = 0;
    for (let depth = 0; pointer && depth <= 64; depth++) {
      const cacheKey = space + '/' + pointer;
      let row = cache.get(cacheKey);
      if (!row) {
        row = space === 'namedNodes' && store.namedNode ? await store.namedNode(pointer) :
          space === 'claimNodes' && store.claimNode ? await store.claimNode(pointer) : await store.get(space, pointer);
        check(row && rules.hashObject(['dmw-stored-index-v2', row]) === pointer, 'asset_provenance_node');
        bytes += Buffer.byteLength(rules.stableJSON(row)); check(bytes <= limits.proofBytes, 'asset_provenance_budget');
        cache.set(cacheKey, row);
      }
      check(typeof row.prefix === 'string' && /^[0-9a-f]*$/.test(row.prefix) && offset + row.prefix.length <= 64, 'asset_provenance_path');
      const root = rules.hashObject(row.children ? ['dmw-named-branch-v2', row.prefix,
        Object.keys(row.children).sort().map(k => [k, row.children[k].commitment])] : ['dmw-named-leaf-v2', row.prefix, row.key, row.value]);
      check(root === commitment && row.commitment === commitment, 'asset_provenance_commitment');
      if (!path.startsWith(row.prefix, offset)) return null;
      offset += row.prefix.length;
      if (offset === 64) return row.key === key ? row.value : null;
      const child = row.children?.[path[offset]];
      if (!child) return null;
      check(rules.hex(child.storage, 32) && rules.hex(child.commitment, 32), 'asset_provenance_child');
      pointer = child.storage; commitment = child.commitment;
    }
    throw Error('asset_provenance_depth');
  };
  const namedRead = key => get('namedNodes', named.records, named.catalogRoot, key);
  if (asset.startsWith('p2:')) {
    const number = asset.slice(3), key = await namedRead('number/' + number);
    const pattern = key && await namedRead('pattern/' + key);
    check(pattern?.number === number && pattern.key === key, 'asset_provenance_pattern');
    let find = null;
    if (block !== undefined) {
      const height = rules.decimalV2(block), map = claims.maps.finds;
      find = await get('claimNodes', map.storage, map.root, rules.findIdV2(height, number));
      check(!find || find.asset === asset && rules.decimalV2(find.block) === height, 'asset_provenance_find');
    }
    check(Number.isSafeInteger(pattern.tier) && pattern.tier >= 1 && pattern.tier <= 5, 'asset_provenance_tier');
    return finish({ pattern, find, maker: find?.finder ?? null, tier: pattern.tier });
  }
  const compound = await namedRead('compound/assets/' + asset), maker = await namedRead('compound/maker/' + asset);
  check(compound?.id === asset && rules.hex(maker?.owner, 32), 'asset_provenance_compound');
  const progress = await namedRead('compound/tiers/' + asset), tier = progress?.value ?? compound.tier?.value;
  check(Number.isSafeInteger(tier) && tier >= 1 && tier <= 5, 'compound_tier_pending');
  return finish({ compound, maker: maker.owner, tier, find: null, pattern: null });
}
