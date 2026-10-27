import { check, heightKey, serial } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';

// Only accepted batches change total supply: credits and exchanges create or
// burn units, and mc burns mint escrow. Transfers, locks, reservations and
// refunds merely move units between v/, e/ and l/ (the local reader's sum).
// Bootstrap/resume in bounded pages of keyed gateway records, never headers or
// owner balances. Persist progress but do not publish a partial total.
export class AcceptedAssetSupply {
  constructor({ store, state = store, trac }) { Object.assign(this, { store, state, trac }); this.gate = serial(); }
  read() { return this.gate(async () => {
    const { store, state, trac } = this, last = await trac('batchLast');
    const saved = state.get('prodAssetSupply', 'checkpoint') ?? { n: 0, root: null, totals: {} };
    check(Number.isSafeInteger(last.n) && last.n >= saved.n, 'asset_supply_rewound', 503);
    if (saved.n) check(await trac('root', [saved.n]) === saved.root, 'asset_supply_rewound', 503);
    const totals = new Map(Object.entries(saved.totals).map(([asset, amount]) => [asset, BigInt(amount)]));
    const add = (asset, amount) => {
      const next = (totals.get(asset) ?? 0n) + amount;
      check(next >= 0n, 'asset_supply_negative', 503);
      if (next) totals.set(asset, next); else totals.delete(asset);
    };
    const burns = new Set(), stop = Math.min(last.n, saved.n + 32);
    let root = saved.root, end = saved.n, operations = 0;
    for (let n = saved.n + 1; n <= stop; n++) {
      const batch = store.get('batches', heightKey(n))?.batch;
      check(batch?.n === n && Array.isArray(batch.ops), 'asset_supply_batch_missing', 503);
      check(batch.ops.length <= 512, 'asset_supply_batch_size', 503);
      if (operations + batch.ops.length > 512) break;
      operations += batch.ops.length;
      root = await trac('root', [n]);
      check(root && batch.root === root, 'asset_supply_batch_binding', 503);
      for (const op of batch.ops) {
        if (op.op === 'mk') add(op.asset, BigInt(op.amount));
        if (op.op === 'ac') for (const [asset, amount] of op.assets) add(asset, BigInt(amount));
        if (op.op === 'xc') {
          for (const [asset, amount] of op.request.in) add(asset, -BigInt(amount));
          for (const [asset, amount] of op.request.out) add(asset, BigInt(amount));
        }
        if (op.op === 'mc' && !burns.has(op.id) && !state.get('prodAssetSupplyBurns', op.id)) {
          // Consumed requests retain their asset/amount in the contract. mc is
          // idempotent, so its appearance in a later batch must not burn twice.
          const mint = await trac('pending', [op.id]);
          check(mint?.s === 1, 'asset_supply_mint_binding', 503);
          add(mint.asset, -BigInt(mint.amount)); burns.add(op.id);
        }
      }
      end = n;
    }
    check(rules.stableJSON(last) === rules.stableJSON(await trac('batchLast')), 'asset_supply_snapshot_changed', 503);
    const supply = Object.fromEntries([...totals].map(([asset, amount]) => [asset, amount.toString()]));
    if (end > saved.n) await state.transact([
      ...[...burns].map(id => ({ space: 'prodAssetSupplyBurns', id, value: true })),
      { space: 'prodAssetSupply', id: 'checkpoint', value: { n: end, root, totals: supply } }
    ]);
    check(end === last.n, 'asset_supply_pending', 503);
    return supply;
  }); }
}
