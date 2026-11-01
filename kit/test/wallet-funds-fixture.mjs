// Offline reader responses use the same atomic-string shapes as TAP Wallet.
export function walletFundsReply(url, { overall = '1000000000000000000000000', held = '0', locked = '0', obligation = '0', decimals = 18, ticker = 'tap', feeRate = 2 } = {}) {
  const path = new URL(url, 'http://fixture.invalid').pathname;
  if (path === '/api/blocks/tip/height') return '900000';
  if (path.endsWith('/getCurrentBlock')) return { result: '900000' };
  if (path === '/api/v1/fees/recommended') return { halfHourFee: feeRate };
  if (path.includes('/getAccountTokensBalance/')) return { data: { total: 1, list: [{ ticker, overallBalance: overall, transferableBalance: held }] } };
  if (path.includes('/getDeployment/')) return { result: { tick: ticker, dec: decimals } };
  if (path.includes('/getLockedBalance/')) return { result: locked };
  if (path.includes('/getObligationLockedBalance/')) return { result: obligation };
  if (path.includes('/getBalance/')) return { result: overall };
  if (path.includes('/getTransferable/')) return { result: held };
  // The unspent-coin cross-check is covered by its own test; elsewhere it answers "cannot tell" and never blocks.
  if (/\/api\/address\/[^/]+\/utxo$/.test(path)) return { unknown: true };
  return null;
}
export async function walletFundsFetch(url, options) {
  if (options?.method && options.method !== 'GET') throw Error('fixture allows reads only');
  const value = walletFundsReply(url);
  if (!value) throw Error('Unexpected fixture read: ' + url);
  return { ok: true, json: async () => value, text: async () => String(value) };
}
export const cardinalFixture = (satoshi = 1000000) => ({ txid: '56'.repeat(32), vout: 0, satoshi, height: 1, inscriptions: [], isSpent: false, isUserSpendable: false });
