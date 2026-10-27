import { tapBurnAddress } from '../rules/src/tap-burn.js';
export { TAP_BURN, tapBurnAddress } from '../rules/src/tap-burn.js';

function decimal(atoms, decimals) {
  const scale = 10n ** BigInt(decimals);
  const fraction = (atoms % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (atoms / scale).toString() + (fraction ? '.' + fraction : '');
}

// The price is in atomic units; inscriptions use decimal token units.
export function paymentLock({ tick = 'tap', priceAtoms, decimals = 18, payer, finder, landowner = null, treasury, hash, expiry, bitcoinNetwork = 'mainnet' }) {
  if (typeof priceAtoms !== 'bigint' || priceAtoms <= 0n || priceAtoms % 100n !== 0n) throw new Error('Price must be positive atomic units divisible by 100; rounding policy is not defined');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid decimals');
  if (!Number.isSafeInteger(expiry) || expiry < 1 || expiry > 0xffffffff) throw new Error('Invalid expiry height');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Expected SHA256 hex hash');
  const burn = tapBurnAddress(bitcoinNetwork);
  const recipients = [payer, finder, treasury, ...(landowner === null ? [] : [landowner]), burn];
  if (recipients.some(a => typeof a !== 'string' || !a) || new Set(recipients).size !== recipients.length) throw new Error('Payment roles must have distinct addresses');
  const share = percent => decimal(priceAtoms * BigInt(percent) / 100n, decimals);
  return {
    op: 'lock', kind: 'htlc', tick, amt: share(35), claim: treasury, refund: payer,
    condition: { type: 'hashlock', hash }, refund_after: String(expiry),
    al: [
      { tt: 'a', to: finder, amt: share(30), rl: 'of' },
      ...(landowner === null ? [] : [{ tt: 'a', to: landowner, amt: share(15), rl: 'sr' }]),
      { tt: 'b', to: burn, amt: share(landowner === null ? 35 : 20), rl: 'bn' },
    ],
  };
}

// Pass this object directly to the wallet's redeemTapActions method.
export function paymentMessage(auth, action, requestId) {
  if (typeof auth !== 'string' || !auth || typeof requestId !== 'string' || !requestId) throw new Error('Authority and request ID are required');
  return { auth, items: [], data: requestId, actions: [action] };
}
