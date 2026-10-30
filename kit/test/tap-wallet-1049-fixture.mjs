// Contract fixture: TAP Wallet 1.0.49 = 1.0.48 plus getCapabilities and
// singleTxTransfer(items, { extraOutputs }) adding at most one Bitcoin output
// to the same payment transaction. No chain sends.
import { tapWallet1048 } from './tap-wallet-1048-fixture.mjs';
import { cardinalFixture } from './wallet-funds-fixture.mjs';

export function tapWallet1049(options = {}) {
  const f = tapWallet1048(options), { calls } = f.state;
  f.state.version = options.version ?? '1.0.49';
  f.state.coins = [cardinalFixture()];
  f.provider.getBitcoinUtxos = async () => f.state.coins;
  const transfer = f.provider.singleTxTransfer;
  f.provider.getCapabilities = async () => ({ version: f.state.version, singleTxTransferExtraOutputs: true });
  f.provider.singleTxTransfer = async (items, extra) => {
    if (extra === undefined) return transfer(items);
    if (!Array.isArray(extra?.extraOutputs) || extra.extraOutputs.length > 1) throw { code: -32602, message: 'Invalid extraOutputs' };
    const at = calls.length;
    try {
      const { txid } = await transfer(items);
      return { txid, extraOutputs: extra.extraOutputs.map(({ address, satoshis }) => ({ address, satoshis, vout: items.length })) };
    } finally { calls[at]?.push(extra); }
  };
  return f;
}
