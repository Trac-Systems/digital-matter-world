import { check } from '../src/util.mjs';
import { walletBitmaps as readWalletBitmaps } from '../src/bitmaps.mjs';

export async function bitmapHistoryPage(manifest, address, offset) {
  check(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000 && typeof address === 'string' && address.length > 0 && address.length <= 128, 'bitmap_page');
  check(manifest.ordSource, 'bitcoin_ord_required');
  return (await manifest.ordSource.request('/r/tap/getBitmapWalletHistoricList/' + encodeURIComponent(address) + '?offset=' + offset + '&max=500', { maxBytes: 128000 })).result;
}

export async function walletBitmaps(e,owner,page=bitmapHistoryPage) {
  return readWalletBitmaps(e, owner, page);
}
