import { accountKey } from '../../contract/account-tree.js';
import { check } from './util.mjs';

// Called on a disposable execution overlay (or the explicit offline import).
// Work is proportional to touched leaves; the returned writes commit with roots.
export function publicAccountWrites({ store, get, availability, balances }) {
  const writes = [], owners = new Set(), assets = new Set();
  for (const { owner, asset } of balances) {
    owners.add(owner); assets.add(asset);
    const record = get('ar/' + owner), leaf = availability.prove(record.root, [accountKey('balance', asset)]).leaves[0].value;
    writes.push({ space: 'publicBalances', id: owner + '/' + asset, value: { owner, asset,
      amount: leaf?.available ?? '0', held: leaf?.held ?? '0', ...record } });
  }
  for (const owner of owners) writes.push({ space: 'publicBalanceHeads', id: owner, value: get('ar/' + owner) });
  const record = get('ar/supply');
  if (record && assets.size) {
    const prior = store.get('publicSummaries', 'outstandingSupply') ?? {};
    let issued = BigInt(prior.matterIssued ?? '0'), burned = BigInt(prior.matterBurned ?? '0');
    for (const asset of assets) {
      const leaf = availability.prove(record.root, [accountKey('supply', asset)]).leaves[0].value ?? { issued: '0', burned: '0' };
      const old = store.get('publicSupply', asset) ?? { issued: '0', burned: '0' };
      issued += BigInt(leaf.issued) - BigInt(old.issued); burned += BigInt(leaf.burned) - BigInt(old.burned);
      writes.push({ space: 'publicSupply', id: asset, value: { asset, ...leaf, outstanding: String(BigInt(leaf.issued) - BigInt(leaf.burned)), ...record } });
    }
    check(issued >= burned && burned >= 0n, 'public_supply_conservation');
    writes.push({ space: 'publicSummaries', id: 'outstandingSupply', value: { ...prior, matterIssued: String(issued),
      matterBurned: String(burned), matter: String(issued - burned), matterHead: record,
      matterMeaning: 'materialized_account_units_including_holds' } });
  }
  return writes;
}
