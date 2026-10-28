import { check, equal } from './crypto.mjs';
import { rules, requestID, permit } from './adapter.mjs';

// Used both by the batch approvers (before consumption) and by the detached
// permit approvers (after consumption). Every monetary field is read locally.
export async function paidMintPlan({ reads, bitcoinNetwork = reads.bindings?.bitcoinNetwork ?? 'mainnet', network, publicKey, request, signature, receiver, consumed = false, final = true, confirmations = 1 }) {
  check(rules.verifyRequest('rq', network, request, signature, request?.until), 'owner_signature');
  check(typeof receiver === 'string' && rules.hash(receiver) === request.receive, 'receiver_binding');
  const id = requestID(network, request), raw = await reads.pending(id), pending = await reads.pendingAcceptance(id);
  check(raw && [0, 1, 2].includes(raw.s) && pending?.id === id, 'pending_missing');
  check(Number.isSafeInteger(pending.created) && pending.created >= 0 && pending.expiry === request.expires && pending.created <= request.until &&
    request.expires - pending.created >= 6 && request.expires - pending.created <= 2016, 'pending_acceptance');
  check(await reads.agentAddress(raw.o) === request.owner && raw.asset === request.asset && raw.amount === request.amount && raw.receive === request.receive &&
    raw.e === request.expires && raw.block === request.block, 'pending_binding');
  const terms = await reads.mintFeeTerms(id), payment = await reads.mintPayment(id);
  check(['tap', 'ethereum'].includes(payment?.kind) && payment.payer === await reads.payer(id) && payment.requestId === id, 'payment_binding');
  const context = await reads.assetContext(request.asset, request.block, payment.kind, terms.payoutSnapshot, id), d = context.deployment;
  await reads.verifyPayoutSnapshot?.(terms.payoutSnapshot, context.payouts);
  check(d?.active === true && d.privilegePublicKey === publicKey && d.decimals === 0 && ['dmt', 'compound'].includes(d.kind), 'deployment');
  check((d.kind === 'dmt') === Object.hasOwn(request, 'block'), 'asset_kind');
  check(consumed || BigInt(d.remaining) >= BigInt(request.amount) && (!d.limit || d.limit === '0' || BigInt(request.amount) <= BigInt(d.limit)), 'mint_capacity');
  let holder = null;
  if (d.kind === 'dmt') {
    check(context.find?.finder && context.find.block === request.block && context.find.asset === request.asset && String(context.find.count) === request.amount, 'block_count');
    check(consumed || await reads.isMinted(d.id, d.tick, request.block) === false, 'already_minted');
    holder = context.link ? context.bitmapHolder ?? await reads.bitmap(request.block) : null;
    check(!context.link || holder?.agent && holder.address, 'bitmap_missing');
    const hold = await reads.blockHold(request.asset, request.block);
    check(!hold || hold.id === id, 'block_pending');
  }
  const price = rules.feeFor(d.kind === 'dmt' ? 'find' : 'compound', terms.baseFee, context.tier, terms.feeSettings ?? context.feeSettings);
  const split = rules.splitFee(price, { kind: d.kind === 'dmt' ? 'find' : 'compound', linked: !!holder, discovered: !!context.discoverer });
  const destinations = { treasury: context.treasury, finder: context.finderAddress ?? null, firstMaker: context.firstMakerAddress ?? null,
    landowner: payment.kind === 'ethereum' ? context.landownerAddress : holder?.address ?? null, discoverer: context.discoverer ?? null };
  const fees = rules.mintFeeItems(split, destinations, id, payment.payer, payment.kind, bitcoinNetwork);
  check(equal(payment.fees, fees), 'payment_split');
  const progress = rules.paymentProgress(fees, payment.receipts, { confirmations: Math.max(confirmations, payment.requiredConfirmations ?? 1) });
  check(final ? progress.final : progress.seen, final ? 'payment_incomplete' : 'payment_unseen');
  const p = permit(network, request, d, receiver, id, rules.paymentCommitment(progress.allocations));
  if (consumed) check(raw.s === 1 && raw.permitHash === p.digest && raw.paymentHash === rules.paymentCommitment(progress.allocations), 'units_not_consumed');
  const details = { id, request, signature, receiver, deployment: d, pending, payment: { kind: payment.kind, allocations: progress.allocations }, price, permit: p, commissions: [] };
  return { details, permit: p, payment, progress, raw, pending, fees };
}
