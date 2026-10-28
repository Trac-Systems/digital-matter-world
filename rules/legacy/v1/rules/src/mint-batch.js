import { paymentProgress, paymentCommitment } from './mint-payments.js';
import { recordGet, recordSet } from './record-index.js';
import { assert, integer, hex, hash, stableJSON, exactKeys } from './core.js';
import { pendingId, verifyRequest, completeRealOp, cancelRealOp, holdPaidOp, consumePaidOp } from './operations.js';
import { acceptMintRequest } from './mint-rights.js';

export const MINT_BATCH_DEFAULTS = Object.freeze({ maxMintOps: 8 });
export const mintContext = context => ({ deployment: context.deployment,
  find: context.find ?? null, link: context.link ?? null });
const decimal = n => typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n);
const inscription = s => typeof s === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(s);
const same = (a, b) => stableJSON(a) === stableJSON(b);

// These are deterministic evidence checks. Signers must obtain each evidence
// field independently; an audit commitment alone is not an indexer proof.
export function applyMintInput({ input, network, counted, tip, hashAt, state, settings = {} }) {
  assert(exactKeys(input, ['op', 'request', 'sig', 'receiver', 'evidence']) && ['rq', 'mp', 'mc', 'rx'].includes(input.op), 'mint_input');
  const { request: r, sig, receiver, evidence: e, op } = input;
  assert(verifyRequest('rq', network, r, sig, op === 'rq' ? counted : r?.until), 'owner_signature');
  assert(typeof receiver === 'string' && receiver.length > 0 && receiver.length <= 128 && hash(receiver) === r.receive, 'receiver_binding');
  const id = pendingId(network, r), key = Object.hasOwn(r, 'block') ? `${r.asset}/${r.block}` : null;
  const mints = { holds: {}, pending: {}, minted: {}, ...state.mints };
  let next = { ...mints, holds: { ...mints.holds }, pending: { ...mints.pending }, minted: { ...mints.minted } }, operation;
  if (op === 'rq') {
    assert(exactKeys(e, ['context', 'bitmap', 'minted', 'hold', 'balance', 'nonceUsed']), 'mint_evidence');
    const c = e.context, d = c?.deployment;
    assert(d && ['dmt', 'compound'].includes(d.kind) && inscription(d.id) && typeof d.tick === 'string' && d.tick.length > 0 &&
      d.active === true && hex(d.privilegePublicKey, 33) && d.decimals === 0, 'mint_deployment');
    assert(decimal(d.remaining) && BigInt(d.remaining) >= BigInt(r.amount) && BigInt(r.amount) <= 18446744073709551615n &&
      decimal(d.limit) && (d.limit === '0' || BigInt(r.amount) <= BigInt(d.limit)), 'mint_capacity');
    assert((d.kind === 'dmt') === !!key && typeof e.minted === 'boolean' && e.nonceUsed === false, 'mint_evidence');
    assert(!recordGet(state.usedNonces, `${r.owner}:${r.nonce}`), 'mint_replay');
    assert(!key || c.find && hex(c.find.finder, 32), 'mint_no_find');
    assert(!c.link || hex(e.bitmap?.agent, 32) && typeof e.bitmap.address === 'string' && e.bitmap.address.length > 0, 'bitmap_missing');
    assert(c.link || e.bitmap === null, 'bitmap_unexpected');
    assert(e.hold === null || key && hex(e.hold.id, 32) && integer(e.hold.expiry), 'mint_hold');
    if (key && next.holds[key] && counted <= next.holds[key].expiry) assert(same(e.hold, { id: next.holds[key].id, expiry: next.holds[key].expiry }), 'mint_hold_changed');
    if (key && e.hold) next.holds[key] = e.hold;
    const accepted = acceptMintRequest({ state: next, request: r, sig, network, counted, find: c.find, compound: d.kind === 'compound',
      link: c.link, currentHolder: e.bitmap?.agent ?? null, minted: e.minted, balance: e.balance, settings });
    next = accepted.state; operation = accepted.op;
    state.balances = recordSet(state.balances, r.owner, { ...recordGet(state.balances, r.owner), [r.asset]: (BigInt(e.balance) - BigInt(r.amount)).toString() });
    state.usedNonces = recordSet(state.usedNonces, `${r.owner}:${r.nonce}`, true);
  } else {
    assert(exactKeys(e, ['pending', 'reservation', 'payment', 'authorization', 'balance']), 'mint_evidence');
    const p = e.pending, raw = e.reservation, a = e.authorization;
    assert(p?.id === id && integer(p.created) && p.created <= counted && p.created <= r.until && p.expiry === r.expires, 'mint_pending');
    assert(raw && [0, 2].includes(raw.s) && raw.asset === r.asset && raw.amount === r.amount && raw.receive === r.receive && raw.e === r.expires && raw.block === r.block, 'mint_pending');
    assert(!next.finished?.[id] && decimal(e.balance), 'mint_replay');
    assert(a?.id === id && a.receiver === receiver && same(a.request, r) && inscription(a.deployment?.id) &&
      (a.deployment.kind === 'dmt') === !!key && hex(a.deployment.privilegePublicKey, 33), 'mint_authorization');
    assert(e.payment?.requestId === id && ['tap', 'ethereum'].includes(e.payment.kind) && same(e.payment.fees, a.fees), 'payment_binding');
    const progress = paymentProgress(a.fees, e.payment.receipts, { confirmations: e.payment.requiredConfirmations ?? 1 });
    if (op === 'mp') {
      assert(progress.seen, 'payment_unseen');
      assert(!raw.h, 'payment_already_held');
      if (counted > p.expiry) {
        assert(BigInt(e.balance) >= BigInt(r.amount), 'mint_balance');
        state.balances = recordSet(state.balances, r.owner, { ...recordGet(state.balances, r.owner), [r.asset]: (BigInt(e.balance) - BigInt(r.amount)).toString() });
      }
      next.pending[id] = { ...p, paymentSeen: true };
      if (key) next.holds[key] = { id, expiry: Number.MAX_SAFE_INTEGER };
      operation = holdPaidOp(id);
    } else if (op === 'mc') {
      assert(raw.h === true && progress.final && hex(a.permit?.hash, 32) && a.paymentHash === paymentCommitment(progress.allocations), 'payment_incomplete');
      operation = consumePaidOp(id, a.permit.hash, progress.allocations);
      delete next.pending[id];
      if (key) { next.holds[key] = { id, expiry: Number.MAX_SAFE_INTEGER }; next.minted[key] = a.permit.hash; }
      next.finished = { ...next.finished, [id]: 'mc' };
    } else {
      assert(!raw.h && !progress.seen && counted > p.expiry, 'mint_payment_seen');
      operation = cancelRealOp(id);
      delete next.pending[id];
      if (key && next.holds[key]?.id === id) delete next.holds[key];
      next.finished = { ...next.finished, [id]: 'rx' };
    }
  }

  state.mints = next;
  return operation;
}

export function mintAuthorization(details) {
  const d = details.deployment;
  return { id: details.id, request: details.request, receiver: details.receiver,
    deployment: { id: d.id, kind: d.kind, tick: d.tick, privilegePublicKey: d.privilegePublicKey },
    permit: { hash: details.permit.digest, dta: details.permit.payload.dta }, commissions: details.commissions ?? [] };
}
