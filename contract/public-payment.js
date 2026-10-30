import { hashObject, hex } from '../rules/src/core.js';
import { publicRequestId } from '../rules/src/public-mint.js';
import { publicPaymentV2Active, publicPaymentKey, validatePublicPaymentRegistration, bindPublicPaymentIntent } from '../rules/src/public-payment.js';
import { financialUnfrozen } from './financial-lifecycle.js';

const check = (ok, reason) => { if (!ok) throw Error(reason); };
export async function applyPublicPayment(store, op, { network, height, settings }) {
  check(publicPaymentV2Active(settings, height), 'public_payment_activation');
  const key = publicPaymentKey(op.id), old = await store.get(key);
  await financialUnfrozen(store, [key, 'fp/chain']);
  check(op.previous === hashObject(old ?? null), 'public_payment_predecessor');
  if (op.action === 'register') {
    const r = validatePublicPaymentRegistration(op.registration, settings, height);
    check(!old && r.network === network && r.commitment === op.id && BigInt(height) <= BigInt(r.validUntil), 'public_payment_registration');
    store.put(key, { registration: r, registeredHeight: height });
  } else {
    check(op.action === 'reveal' && old && !old.intent &&
      typeof op.reference === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(op.reference) &&
      typeof op.paymentHeight === 'string' && /^(0|[1-9][0-9]*)$/.test(op.paymentHeight) &&
      publicPaymentV2Active(settings, op.paymentHeight) && BigInt(op.paymentHeight) > BigInt(old.registeredHeight) &&
      BigInt(op.paymentHeight) <= BigInt(height), 'public_payment_reveal');
    bindPublicPaymentIntent(op.intent, old.registration);
    check(hex(op.intent.signature, 64), 'public_payment_reveal');
    store.put(key, { ...old, intent: op.intent, reference: op.reference, paymentHeight: op.paymentHeight });
  }
}

// Historical operations keep their original shape until the counted boundary.
export async function validatePublicPaymentSettlement(store, payment, { network, height, settings }) {
  if (!publicPaymentV2Active(settings, height)) {
    check(payment.paymentVersion === undefined, 'public_payment_activation'); return;
  }
  check(typeof payment.paymentCreated === 'string' && /^(0|[1-9][0-9]*)$/.test(payment.paymentCreated), 'public_payment_created');
  if (payment.paymentVersion === 1) {
    check(BigInt(payment.paymentCreated) < BigInt(settings.publicPaymentV2Height), 'public_payment_activation'); return;
  }
  check(payment.paymentVersion === 2 && publicPaymentV2Active(settings, payment.height) && hex(payment.commitment, 32), 'public_payment_activation');
  const row = await store.get(publicPaymentKey(payment.commitment));
  check(row?.intent && BigInt(payment.height) > BigInt(row.registeredHeight), 'public_payment_unrevealed');
  const intent = bindPublicPaymentIntent(row.intent, row.registration);
  check(payment.id === publicRequestId(network ?? intent.network, intent) && intent.asset === payment.asset && intent.block === payment.block &&
    intent.tapAddress === payment.tapAddress && intent.feeQuote.validFrom === payment.paymentCreated &&
    (!payment.source || hashObject(payment.source.intent) === hashObject(intent)), 'public_payment_binding');
}
