import { createRequire } from 'node:module';
import { check, hash } from './util.mjs';
import { validRequestId, validDestination } from './mint-sender-keys.mjs';
import { REFUND_MAX_FEES, REFUND_AMOUNT_DIGITS, refundMessage, tokenAuthPayload } from './mint-refund-payload.mjs';
const require = createRequire(new URL('../../kit/package.json', import.meta.url));
const { secp256k1 } = require('@noble/curves/secp256k1');
export const inscriptionId = id => typeof id === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(id);
const amountPattern = new RegExp('^(0|[1-9][0-9]{0,' + (REFUND_AMOUNT_DIGITS - 1) + '})$');
export const atomicAmount = amount => typeof amount === 'string' && amountPattern.test(amount);
export function tokenAuth(message, field, privateKey, salt) {
  check(['auth', 'redeem'].includes(field) && typeof salt === 'string', 'mint_refund_signature');
  const digest = hash(JSON.stringify(message) + salt), signature = secp256k1.sign(digest, privateKey);
  return tokenAuthPayload(message, field, digest,
    { v: String(signature.recovery), r: String(signature.r), s: String(signature.s) }, salt);
}
export function refundAmounts(record, network, settings) {
  check(validRequestId(record.refundId) && validRequestId(record.id) && inscriptionId(record.reference) && record.state === 'owed' &&
    validDestination(record.tapAddress, network) && Array.isArray(record.fees) && record.fees.length > 0 && record.fees.length <= REFUND_MAX_FEES, 'mint_refund_record');
  const amounts = {};
  for (const fee of record.fees) {
    check(settings.refundTickers.includes(fee.ticker) && atomicAmount(fee.amount) && BigInt(fee.amount) > 0n, 'mint_refund_amount');
    amounts[fee.ticker] = String(BigInt(amounts[fee.ticker] ?? 0) + BigInt(fee.amount));
  }
  return amounts;
}
export function refundRedeem(record, authority, privateKey, network, settings) {
  check(inscriptionId(authority), 'mint_refund_authority');
  const amounts = refundAmounts(record, network, settings), message = refundMessage(amounts, record.tapAddress, record.refundId, authority);
  const payload = tokenAuth(message, 'redeem', privateKey, hash(message.data + '|' + authority));
  const text = JSON.stringify(payload);
  check(Buffer.byteLength(text) <= settings.refundContentBytes, 'mint_refund_content');
  return { text, payload, amounts };
}
