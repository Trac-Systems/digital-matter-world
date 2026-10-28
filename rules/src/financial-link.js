import { ed25519 } from '@noble/curves/ed25519';
import { assert, exactKeys, hex, digest, bytesToHex } from './core.js';
import { uintV2 } from './integers-v2.js';

export function financialLinkDigest(network, r) {
  assert(r?.v === 2 && r.kind === 'link' && exactKeys(r, ['v', 'kind', 'owner', 'block', 'payer', 'nonce', 'until', 'settingsHash', 'quoteHash']) &&
    hex(r.owner, 32) && hex(r.nonce, 32) && hex(r.settingsHash, 32) && hex(r.quoteHash, 32) &&
    typeof r.payer === 'string' && r.payer.length > 0 && r.payer.length <= 128, 'financial_link_request');
  uintV2(r.block); uintV2(r.until);
  return digest('dmw-link-request-v2', network, r);
}
export const financialLinkId = (network, r) => bytesToHex(financialLinkDigest(network, r));
export function verifyFinancialLink(network, request, signature) {
  try { return hex(signature, 64) && ed25519.verify(signature, financialLinkDigest(network, request), request.owner, { zip215: false }); }
  catch { return false; }
}
