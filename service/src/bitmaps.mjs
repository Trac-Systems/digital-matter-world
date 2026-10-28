import { check } from './util.mjs';

// Public projection only. Link/mint authorization still reads the named Bitmap
// and its present owner independently. Lists never backfill wallet history.
export async function walletBitmaps({ reads, store }, owner) {
  if (store?.get('meta', 'ruleState')?.batchVersion === 2) {
    const { itemPage } = await import('./public-projections.mjs');
    return itemPage(store, 'bitmaps', owner, new URLSearchParams());
  }
  const address = (await reads.bindings.current(owner, 'tap'))?.request.address;
  if (!address) return [];
  check(reads.bitmapInventory, 'bitmap_index_required');
  return reads.bitmapInventory.source(address);
}
