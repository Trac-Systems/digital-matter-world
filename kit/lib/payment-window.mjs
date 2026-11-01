import { ensure } from './inscription-core.mjs';

export const PAYMENT_MIN_BLOCKS = 2;
const height = value => (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) || Number.isSafeInteger(value) && value >= 0) ? BigInt(value) : null;

// This is a wallet preference, not a consensus gate. Read Bitcoin again just
// before opening approval; a cached counted height can lag the actual tip.
export async function checkPaymentWindow({ status, network, readTip, fetchImpl = fetch, minPaymentBlocks = PAYMENT_MIN_BLOCKS, readerPath }) {
  ensure(Number.isSafeInteger(minPaymentBlocks) && minPaymentBlocks >= 1, 'Invalid minimum payment window');
  const until = height(status.payBy?.untilBlock);
  ensure(until !== null, 'Cannot check when this request expires. Refresh it or create a fresh request before paying.');
  let tip;
  try {
    if (readTip) tip = await readTip();
    else {
      const url = network === 'mainnet' ? 'https://mempool.space/api/blocks/tip/height' :
        network === 'regtest' ? (readerPath ?? '/web-api/tap-reader') + '/getCurrentBlock' : null;
      ensure(url, 'Unsupported Bitcoin network');
      const response = await fetchImpl(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      ensure(response.ok, 'Bitcoin tip unavailable');
      tip = network === 'mainnet' ? await response.text() : (await response.json()).result;
    }
  } catch {
    throw Object.assign(Error('Cannot check the current Bitcoin block. Refresh the request and try again before paying.'), { code: 'payment_tip_unavailable', display: true });
  }
  tip = height(tip);
  ensure(tip !== null, 'Cannot check the current Bitcoin block. Refresh the request before paying.');
  if (until - tip < BigInt(minPaymentBlocks)) throw Object.assign(Error(`Fewer than ${minPaymentBlocks} Bitcoin blocks remain to pay. Create a fresh mint request before paying.`),
    { code: 'payment_window_short', display: true });
  return { tip: tip.toString(), remainingBlocks: (until - tip).toString() };
}
