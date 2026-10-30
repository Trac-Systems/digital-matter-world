import { assert, exactKeys, hashObject, hex } from './core.js';
import { decimalV2, uintV2 } from './integers-v2.js';
import { publicMintActive, publicMintValues } from './public-mint.js';

export const PUBLIC_PAYMENT_REGISTRATION_DOMAIN = 'dmw-public-payment-registration-v2';
export const publicPaymentKey = commitment => 'fp/public-intent/' + commitment;
export const publicPaymentFeeBinding = (commitment, role, to, ticker) => hashObject(['dmw-public-payment-fee-v2', commitment, role, to, ticker]);
export function publicPaymentV2Active(settings, height) {
  const v = publicMintValues(settings);
  return v.publicPaymentV2Height !== undefined && publicMintActive(settings, height) &&
    BigInt(decimalV2(height)) >= BigInt(uintV2(v.publicPaymentV2Height));
}
export function publicPaymentCommitment(intent) {
  assert(intent?.paymentVersion === 2 && hex(intent.paymentSalt, 32), 'public_payment_commitment');
  return hashObject(['dmw-public-pay-v2', intent]);
}
export function validatePublicPaymentRegistration(registration, settings, height) {
  const r = registration;
  assert(r && exactKeys(r, ['network', 'commitment', 'payer', 'validFrom', 'validUntil', 'settingsHash', 'feeBindings', 'signature']) &&
    typeof r.network === 'string' && hex(r.commitment, 32) && hex(r.settingsHash, 32) && hex(r.signature, 64) &&
    typeof r.payer === 'string' && r.payer.length > 0 && r.payer.length <= 128 &&
    Array.isArray(r.feeBindings) && r.feeBindings.length > 0 && r.feeBindings.length <= publicMintValues(settings).paymentPage &&
    r.feeBindings.every(h => hex(h, 32)) && new Set(r.feeBindings).size === r.feeBindings.length, 'public_payment_registration');
  uintV2(r.validFrom); uintV2(r.validUntil);
  assert(publicPaymentV2Active(settings, r.validFrom) && BigInt(r.validUntil) > BigInt(r.validFrom) &&
    BigInt(decimalV2(height)) >= BigInt(r.validFrom), 'public_payment_activation');
  return r;
}
export function bindPublicPaymentIntent(intent, registration) {
  assert(publicPaymentCommitment(intent) === registration.commitment && intent.network === registration.network &&
    intent.tapAddress === registration.payer && intent.settingsHash === registration.settingsHash &&
    intent.feeQuote?.validFrom === registration.validFrom && intent.feeQuote.validUntil === registration.validUntil,
  'public_payment_commitment');
  assert(Array.isArray(intent.fees) && hashObject(intent.fees.map(f => publicPaymentFeeBinding(registration.commitment, f.role, f.to, f.ticker))) ===
    hashObject(registration.feeBindings), 'public_payment_commitment');
  return intent;
}
