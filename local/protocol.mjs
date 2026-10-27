import { createHash, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const testKey = () => secp256k1.utils.randomPrivateKey();
export function signMessage(message, key) {
  const hash = sha256(message);
  const signature = secp256k1.sign(hash, key, { lowS: true });
  return { hash, sig: { v: String(signature.recovery), r: signature.r.toString(), s: signature.s.toString() } };
}
export function authority(key, { privilege = false, auth = [], salt = randomBytes(16).toString('hex') } = {}) {
  if (privilege && Array.isArray(auth)) auth = { name: 'dmw-local' };
  return { p: 'tap', op: privilege ? 'privilege-auth' : 'token-auth', auth, ...signMessage(JSON.stringify(auth) + salt, key), salt };
}
export function mintPermit({ tick, blk, dep, address, dta, salt = randomBytes(16).toString('hex') }, key) {
  const mint = { p: 'tap', op: 'dmt-mint', tick, blk: String(blk), dep, ...(dta === undefined ? {} : { dta }) };
  const message = [mint.p, mint.op, tick, mint.blk, dep, address, ...(dta === undefined ? [] : [dta]), salt].join('-');
  return { ...mint, prv: { ...signMessage(message, key), address, salt } };
}
export function tokenMintPermit({ tick, amt, address, dta, salt = randomBytes(16).toString('hex') }, key) {
  if (typeof amt !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(amt)) throw new Error('Mint amount must be an exact decimal string');
  const mint = { p: 'tap', op: 'token-mint', tick, amt, ...(dta === undefined ? {} : { dta }) };
  const message = [mint.p, mint.op, tick, amt, address, ...(dta === undefined ? [] : [dta]), salt].join('-');
  return { ...mint, prv: { ...signMessage(message, key), address, salt } };
}
export function redeem(auth, actions, key, { items = [], data = '', salt = randomBytes(16).toString('hex') } = {}) {
  const payload = { auth, items, data, actions };
  return { p: 'tap', op: 'token-auth', redeem: payload, ...signMessage(JSON.stringify(payload) + salt, key), salt };
}
