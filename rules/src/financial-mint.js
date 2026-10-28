import { ordinalCodec } from './integers-v2.js';
import { ed25519 } from '@noble/curves/ed25519';
import { assert, hex, hashObject, exactKeys, digest, bytesToHex } from './core.js';
import { pendingId, verifyRequest } from './operations.js';
export const financialAsset = a => typeof a === 'string' && (/^[0-9a-z]{1,24}$/.test(a) || /^p2:(0|[1-9][0-9]*)$/.test(a) || /^c2:[0-9a-f]{64}$/.test(a));
export function financialMintDigest(network, r) {
  const clock = ordinalCodec(typeof r?.until === 'string');
  assert(r?.v === 2 && exactKeys(r, ['v', 'owner', 'asset', 'amount', 'receive', 'nonce', 'until', 'expires', 'settingsHash', ...(Object.hasOwn(r, 'block') ? ['block'] : [])]) &&
    hex(r.owner, 32) && financialAsset(r.asset) && typeof r.amount === 'string' && /^[1-9][0-9]*$/.test(r.amount) &&
    hex(r.receive, 32) && hex(r.nonce, 32) && hex(r.settingsHash, 32) && clock.valid(r.until) && clock.valid(r.expires) && clock.compare(r.expires, r.until) > 0 && (!Object.hasOwn(r, 'block') || clock.valid(r.block)), 'financial_mint_request');
  return digest('dmw-mint-request-v2', network, r);
}
export const financialMintId = (network, request) => request?.v === 2 ? bytesToHex(financialMintDigest(network, request)) : pendingId(network, request);
export function verifyFinancialMintRequest(network, request, signature, counted) {
  if (request?.v !== 2) return verifyRequest('rq', network, request, signature, counted);
  try { return ordinalCodec(typeof counted === 'string').valid(counted) && ordinalCodec().compare(counted, request.until) <= 0 && hex(signature, 64) && ed25519.verify(signature, financialMintDigest(network, request), request.owner, { zip215: false }); } catch { return false; }
}
export const financialPaymentHash = funding => funding.legacyPaymentHash ?? hashObject(['dmw-mint-funding-v2', funding.terms, funding.consumedRoot ?? funding.root]);
