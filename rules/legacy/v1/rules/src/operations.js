import { ed25519 } from '@noble/curves/ed25519';
import { requestDigest as contractRequestDigest, batchDigest } from '../../contract/signing.js';
import { assert, integer, exactKeys, hex, bytesToHex, hexToBytes, utf8, stableJSON as canonicalJSON } from './core.js';
export { batchDigest };
export const assetId = id => typeof id === 'string' && /^[0-9a-z]{1,24}$/.test(id);
export const amount = n => typeof n === 'string' && /^[1-9][0-9]{0,77}$/.test(n);
export const assetPairs = a => Array.isArray(a) && a.length >= 1 && a.length <= 16 && a.every(p => Array.isArray(p) && p.length === 2 && assetId(p[0]) && amount(p[1])) && new Set(a.map(p => p[0])).size === a.length;
export function validateRequest(type, r) {
  assert(['xc', 'rq'].includes(type), 'request_type');
  if (type === 'xc') assert(exactKeys(r, ['owner', 'in', 'out', 'nonce', 'until']) && assetPairs(r.in) && assetPairs(r.out), 'request_exchange');
  else {
    const keys = ['owner', 'asset', 'amount', 'receive', 'nonce', 'until', 'expires'];
    if (Object.hasOwn(r ?? {}, 'block')) keys.push('block');
    assert(exactKeys(r, keys) && assetId(r.asset) && amount(r.amount) && hex(r.receive, 32) && integer(r.expires) && (!keys.includes('block') || integer(r.block)), 'request_real');
  }
  assert(hex(r.owner, 32) && hex(r.nonce, 32) && integer(r.until), 'request_fields'); return r;
}
export function requestDigest(type, network, request) {
  validateRequest(type, request); return contractRequestDigest(network, type, request);
}
export const pendingId = (network, request) => bytesToHex(requestDigest('rq', network, request));
export function signRequest(type, network, request, secret) {
  assert(bytesToHex(ed25519.getPublicKey(secret)) === request.owner, 'signer');
  return bytesToHex(ed25519.sign(requestDigest(type, network, request), secret));
}
export function verifyRequest(type, network, request, sig, counted) {
  try { return integer(counted) && request.until >= counted && hex(sig, 64) &&
    ed25519.verify(hexToBytes(sig), requestDigest(type, network, request), hexToBytes(request.owner), { zip215: false }); } catch { return false; }
}
export function validateOp(op) {
  if (op.op === 'mk') assert(exactKeys(op, ['op', 'to', 'asset', 'amount']) && hex(op.to, 32) && assetId(op.asset) && amount(op.amount), 'op_mk');
  else if (op.op === 'ac') assert(exactKeys(op, ['op', 'to', 'assets']) && hex(op.to, 32) && assetPairs(op.assets), 'op_ac');
  else if (op.op === 'xc' || op.op === 'rq') {
    assert(exactKeys(op, ['op', 'request', 'sig']) && hex(op.sig, 64), 'op_request'); validateRequest(op.op, op.request);
  } else if (['rx', 'mp'].includes(op.op)) assert(exactKeys(op, ['op', 'id']) && hex(op.id, 32), 'op_pending');
  else if (op.op === 'mc') {
    assert(exactKeys(op, ['op', 'id', 'permitHash', 'payments']) && hex(op.id, 32) && hex(op.permitHash, 32) &&
      Array.isArray(op.payments) && op.payments.length > 0 && op.payments.length <= 64 &&
      new Set(op.payments.map(p => p.key)).size === op.payments.length && op.payments.every(p =>
        exactKeys(p, ['key', 'amount', 'total']) && hex(p.key, 32) && amount(p.amount) && amount(p.total) && BigInt(p.amount) <= BigInt(p.total)), 'op_payment');
  }
  else if (op.op === 'rl') assert(exactKeys(op, ['op', 'id', 'inscription']) && hex(op.id, 32) && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(op.inscription), 'op_real');
  else if (op.op === 'kv') assert(exactKeys(op, ['op', 'key', 'value']) && /^[a-z0-9/._-]{1,64}$/.test(op.key) &&
    (op.value === null || (typeof op.value === 'string' && utf8(op.value).length <= 256)), 'op_kv');
  else throw new Error('op_type'); return op;
}
export const creditOp = (to, asset, quantity) => validateOp({ op: 'mk', to, asset, amount: quantity });
export const aggregateCreditOp = (to, assets) => validateOp({ op: 'ac', to, assets });
export const notaryOp = (key, value) => validateOp({ op: 'kv', key, value });
export function signedOp(type, request, sig, network, counted) {
  assert(verifyRequest(type, network, request, sig, counted), 'owner_signature');
  if (type === 'rq') validateRequestExpiry(request, counted);
  return validateOp({ op: type, request, sig });
}
export function validateRequestExpiry(request, counted) {
  assert(integer(counted) && integer(request?.expires) && request.expires - counted >= 6 && request.expires - counted <= 2016, 'request_expiry');
  return request.expires;
}
export const makeRealOp = ({ request, sig }, network, counted) => signedOp('rq', request, sig, network, counted);
export const completeRealOp = (id, inscription) => validateOp({ op: 'rl', id, inscription });
export const cancelRealOp = id => validateOp({ op: 'rx', id });
export const holdPaidOp = id => validateOp({ op: 'mp', id });
export const consumePaidOp = (id, permitHash, payments) => validateOp({ op: 'mc', id, permitHash, payments });
export function discoveryOps(record) {
  const prefix = `pattern/${record.number.toString(36)}`;
  return [notaryOp(prefix, canonicalJSON([record.name, record.pat, record.fld, record.dt, record.rarity, record.tier, record.historyHeight])),
    notaryOp(`${prefix}/by`, record.discoverer), notaryOp(`${prefix}/proof`, canonicalJSON([record.fingerprint, record.historyHash]))];
}
export const bitmapLinkOp = (block, linkHeight) => {
  assert(integer(block, 0xffffffff) && integer(linkHeight), 'bitmap_link');
  return notaryOp(`link/${block.toString(36)}`, canonicalJSON({ block, linkHeight }));
};
