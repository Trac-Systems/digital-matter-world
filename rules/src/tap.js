import { secp256k1 } from '@noble/curves/secp256k1';
import { assert, utf8, hashBytes, bytesToHex, hex, stableJSON, hash } from './core.js';
import { amount, verifyRequest, pendingId } from './operations.js';
import { mintTiming } from './mint-rights.js';
import { formatTapAmount, treasuryPayment } from './fees.js';
import { TAP_BURN, tapBurnAddress } from './tap-burn.js';
export { TAP_BURN, tapBurnAddress } from './tap-burn.js';

// Indexed allocations are atomic. Only the inscription boundary renders TAP.
export function tapPaymentAllocations(split, destinations, kind = 'find', bitcoinNetwork = 'mainnet') {
  assert(['find', 'compound', 'link'].includes(kind), 'fee_kind');
  tapBurnAddress(bitcoinNetwork); // Validate the requested network.
  const roles = kind === 'find' ? [['finder', 'of'], ['landowner', 'sr'], ['burn', 'bn']] :
    kind === 'compound' ? [['firstMaker', 'of'], ['burn', 'bn']] : [['burn', 'bn']];
  return roles.filter(([role]) => split[role] !== '0').map(([role, rl]) => ({
    // ord-tap's native allocation parser requires this literal on every
    // network (auth.rs:3069). Address-transfer burn items use network encoding.
    tt: role === 'burn' ? 'b' : 'a', to: role === 'burn' ? TAP_BURN : destinations[role], amt: split[role], rl,
  }));
}
export function tapPaymentLock({ split, destinations, payer, hash: paymentHash, expiry, kind = 'find', bitcoinNetwork = 'mainnet' }) {
  assert(hex(paymentHash, 32) && Number.isSafeInteger(expiry) && expiry > 0 && expiry <= 0xffffffff, 'tap_lock');
  const allocations = tapPaymentAllocations(split, destinations, kind, bitcoinNetwork);
  assert([payer, destinations.treasury, ...allocations.map(a => a.to)].every(a => typeof a === 'string' && a.length > 0), 'payment_destination');
  const amt = formatTapAmount(treasuryPayment(split)); assert(amt !== '0', 'tap_lock_amount');
  return { op: 'lock', kind: 'htlc', tick: 'tap', amt, claim: destinations.treasury, refund: payer,
    condition: { type: 'hashlock', hash: paymentHash }, refund_after: String(expiry),
    al: allocations.map(a => ({ ...a, amt: formatTapAmount(a.amt) })) };
}
export function tapTransfer({ amount: atoms, data }) {
  const amt = formatTapAmount(atoms); assert(amt !== '0', 'tap_transfer_amount');
  return { p: 'tap', op: 'token-transfer', tick: 'tap', amt, ...(data === undefined ? {} : { dta: data }) };
}
const MAX = 18446744073709551615n;
function ticker(tick) { assert(typeof tick === 'string' && /^[a-z0-9]{3,32}$/.test(tick), 'compound_ticker'); return tick; }
// v2 compounds (c2:<64 hex>): dmwc and the first 8 hex of the commitment. A taken ticker
// falls back to the provisioner's collision candidates.
export const compoundTickerV2 = commitmentHex => { assert(hex(commitmentHex, 32), 'compound_ticker'); return ticker('dmwc' + commitmentHex.slice(0, 8)); };
export const compoundTicker = asset => typeof asset === 'string' && asset.startsWith('c2:') ? compoundTickerV2(asset.slice(3)) : ticker(`dmw${asset}`);
export function compoundDeploy({ tick, authority, max = MAX.toString() }) {
  ticker(tick); assert(/^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(authority) && amount(max) && BigInt(max) <= MAX, 'tap_deploy');
  const payload = { p: 'tap', op: 'token-deploy', tick, max, dec: '0', prv: authority };
  return { payload, inscriptionBytes: utf8(stableJSON(payload)) };
}
// ord-tap hashes raw ticker/amount/address/data/salt strings separated by '-'.
// This digest is signed directly, not as an Ethereum or Bitcoin signed message.
export function compoundMintPermit({ tick, quantity, address, salt, data }) {
  ticker(tick); assert(amount(quantity) && BigInt(quantity) <= MAX && typeof address === 'string' && address.length > 0 && address.length <= 128 &&
    typeof salt === 'string' && /^[0-9a-f]{64}$/.test(salt), 'tap_mint');
  assert(data === undefined || (typeof data === 'string' && utf8(data).length <= 512), 'tap_data');
  const fields = ['tap', 'token-mint', tick, quantity, address]; if (data !== undefined) fields.push(data); fields.push(salt);
  const signingBytes = utf8(fields.join('-')), signingDigest = hashBytes(signingBytes);
  const payload = { p: 'tap', op: 'token-mint', tick, amt: quantity, ...(data === undefined ? {} : { dta: data }) };
  return { payload, signingBytes, signingDigest, address, salt };
}
export function attachMintPrivilege(permit, signature) {
  assert(signature && [0, 1, 2, 3].includes(signature.v) && hex(signature.r, 32) && hex(signature.s, 32), 'tap_signature');
  const payload = { ...permit.payload, prv: { sig: { v: signature.v, r: `0x${signature.r}`, s: `0x${signature.s}` },
    hash: bytesToHex(permit.signingDigest), address: permit.address, salt: permit.salt } };
  return { payload, inscriptionBytes: utf8(stableJSON(payload)) };
}
export function signMintPrivilege(permit, secret) {
  const s = secp256k1.sign(permit.signingDigest, secret, { prehash: false, lowS: true });
  return attachMintPrivilege(permit, { v: s.recovery, r: s.r.toString(16).padStart(64, '0'), s: s.s.toString(16).padStart(64, '0') });
}

// Committee entry point: bind the low-level TAP bytes to the owner's request,
// a live pending record, the exact recipient and remaining indexed TAP supply.
export function compoundRequestPermit({ network, request, sig, pending, counted, address, remainingSupply, tick }) {
  assert(verifyRequest('rq', network, request, sig, pending?.created), 'owner_signature');
  assert(!Object.hasOwn(request, 'block') && pending.id === pendingId(network, request) && pending.expiry === request.expires, 'compound_pending');
  assert(typeof address === 'string' && hash(address) === request.receive, 'mint_receive');
  assert(mintTiming(pending, counted).maySignOrBroadcast, 'units_not_consumed');
  assert(typeof remainingSupply === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(remainingSupply) &&
    BigInt(remainingSupply) <= MAX && BigInt(request.amount) <= BigInt(remainingSupply), 'tap_remaining_supply');
  return compoundMintPermit({ tick, quantity: request.amount, address, salt: pending.id, data: pending.id });
}
