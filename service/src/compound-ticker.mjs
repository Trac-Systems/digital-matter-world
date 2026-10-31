import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { verifyTapMessage } from '../../rules/src/payout-bindings.mjs';
import { decodeTracAddress } from '../../rules/src/trac-address.js';
import { check } from './util.mjs';

export const TICKER_CHOICE_KEYS = ['asset', 'ticker', 'revision', 'expiry', 'agentSignature', 'walletSignature'];
// A choice signed now stays valid at most this long.
export const TICKER_CHOICE_MS = 86400000;

// Only the first maker chooses: their agent key signs (the kit), or the TAP Wallet
// bound to their agent signs (the site). That wallet is also the only deploy receiver.
export function verifyTickerChoice({ message, firstMaker, input, bindings, bitcoinNetwork }) {
  if (input.agentSignature !== undefined) {
    let ok = false;
    try { ok = /^[0-9a-f]{128}$/.test(input.agentSignature) && ed25519.verify(input.agentSignature, Buffer.from(message), decodeTracAddress(firstMaker), { zip215: false }); } catch {}
    check(ok, 'first_maker_signature', 403);
    return 'agent';
  }
  let address = null;
  try { address = bindings?.resolve(decodeTracAddress(firstMaker), 'tap', null, 'firstMaker')?.request.address ?? null; }
  catch (error) { if (!/^(?:first_maker_address_missing|binding_transition)$/.test(error.message)) throw error; }
  check(address, 'first_maker_wallet_required', 403);
  try { verifyTapMessage(message, address, input.walletSignature, bitcoinNetwork); } catch { check(false, 'first_maker_signature', 403); }
  return 'wallet';
}
