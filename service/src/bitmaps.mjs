import { check, heightKey } from './util.mjs';

export async function walletBitmaps(e, owner, page, { maxInscriptions = 1000000 } = {}) {
  const address = e.reads.bindings.current(owner, 'tap')?.request.address;
  if (!address) return [];
  const count = Number(await e.reads.tap('getBitmapWalletHistoricListLength/' + address));
  check(Number.isSafeInteger(count) && count >= 0 && count <= maxInscriptions, 'bitmap_count');
  const inscriptions = new Set(), out = [];
  for (let offset = 0; offset < count; offset += 500) {
    const entries = await page(e.manifest, address, offset);
    check(Array.isArray(entries) && entries.length === Math.min(500, count - offset), 'bitmap_list_changed');
    for (const inscription of entries) inscriptions.add(inscription);
  }
  for (const inscription of inscriptions) {
    const bitmap = await e.reads.tap('getBitmapByInscription/' + inscription);
    // The wallet index is historical; transferred-away inscriptions remain.
    if (bitmap?.ownr !== address || bitmap.ins !== inscription) continue;
    check(Number.isSafeInteger(bitmap.bm) && bitmap.bm >= 0, 'bitmap_height');
    out.push({ height: bitmap.bm, inscription, linked: !!e.store.get('links', heightKey(bitmap.bm)) });
  }
  return out.sort((a, b) => a.height - b.height);
}
