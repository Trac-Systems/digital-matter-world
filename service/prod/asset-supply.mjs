import { check, heightKey, serial } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';

// Only accepted batches change total supply: credits and exchanges create or
// burn units, and mc burns mint escrow. Transfers, locks, reservations and
// refunds merely move units between v/, e/ and l/ (the local reader's sum).
// Bootstrap/resume in bounded pages of keyed gateway records, never headers or
// owner balances. Persist progress but do not publish a partial total.
export class AcceptedAssetSupply {
  constructor({ store, state = store, trac, pageBatches = 32, pageOperations = 512 }) {
    check(Number.isSafeInteger(pageBatches) && pageBatches > 0 && Number.isSafeInteger(pageOperations) && pageOperations > 0, 'asset_supply_settings');
    Object.assign(this, { store, state, trac, pageBatches, pageOperations }); this.gate = serial();
  }
  read() { return this.gate(async () => {
    const { store, state, trac } = this, last = await trac('batchLast');
    const v2 = typeof last.n === 'string', clock = rules.ordinalCodec(v2), space = v2 ? 'prodAssetSupplyV2' : 'prodAssetSupply';
    const saved = state.get(space, 'checkpoint') ?? state.get('prodAssetSupply', 'checkpoint') ?? { n: 0, root: null, totals: {} };
    check(clock.valid(last.n) && clock.compare(last.n, saved.n) >= 0, 'asset_supply_rewound', 503);
    if (clock.compare(saved.n, 0) > 0) check(await trac('root', [saved.n]) === saved.root, 'asset_supply_rewound', 503);
    const totals = new Map(Object.entries(saved.totals).map(([asset, amount]) => [asset, BigInt(amount)]));
    const add = (asset, amount) => {
      const next = (totals.get(asset) ?? 0n) + amount;
      check(next >= 0n, 'asset_supply_negative', 503);
      if (next) totals.set(asset, next); else totals.delete(asset);
    };
    const burns = new Set(), stop = clock.min(last.n, clock.add(saved.n, this.pageBatches));
    let root = saved.root, end = saved.n, operations = 0;
    for (let n = clock.add(saved.n); clock.compare(n, stop) <= 0; n = clock.add(n)) {
      const batch = (await store.get('batches', heightKey(n)))?.batch;
      check(batch && clock.compare(batch.n, n) === 0 && Array.isArray(batch.ops), 'asset_supply_batch_missing', 503);
      check(batch.ops.length <= this.pageOperations, 'asset_supply_batch_size', 503);
      if (operations + batch.ops.length > this.pageOperations) break;
      operations += batch.ops.length;
      root = await trac('root', [n]);
      check(root && batch.root === root, 'asset_supply_batch_binding', 503);
      for (const op of batch.ops) {
        if (op.op === 'ar') for (const action of op.actions) {
          if (action.type === 'credit') add(action.asset, BigInt(action.amount));
          if (action.type === 'credits') for (const [asset, amount] of action.assets) add(asset, BigInt(amount));
          if (action.type === 'craft') {
            for (const [asset, amount] of action.in) add(asset, -BigInt(amount));
            for (const [asset, amount] of action.out) add(asset, BigInt(amount));
          }
          if (action.type === 'consume' && !burns.has(action.id) && !state.get('prodAssetSupplyBurns', action.id)) {
            const obligation = await trac('read', ['ao/' + action.id]);
            check(obligation?.state === 'consumed' && obligation.permitHash === action.permitHash, 'asset_supply_mint_binding', 503);
            const capacity = rules.perTickerSupplyActive(batch.execution?.height ?? 0) ? await trac('read', ['dc/' + action.id]) : null;
            // Additional ticker permits keep their units in the account's held
            // balance. Their later release moves them without changing supply.
            if (!rules.mintRetainsUnits(capacity)) add(obligation.asset, -BigInt(obligation.amount));
            burns.add(action.id);
          }
        }
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
    if (clock.compare(end, saved.n) > 0) await state.transact([
      ...[...burns].map(id => ({ space: 'prodAssetSupplyBurns', id, value: true })),
      { space, id: 'checkpoint', value: { n: end, root, totals: supply } }
    ]);
    check(clock.compare(end, last.n) === 0, 'asset_supply_pending', 503);
    return supply;
  }); }
}
