import { recordGet } from './record-index.js';
import { assert, integer, hex, findId } from './core.js';
import { patternCount } from './patterns.js';
import { pendingId, makeRealOp, completeRealOp, cancelRealOp } from './operations.js';
export const MINT_DEFAULTS = Object.freeze({ finderWindow: 1008, pendingBlocks: 432 });
export function mintCandidate({ pattern, block, history, state }) {
  const count = patternCount(pattern, history.get(block)); assert(count > 0, 'mint_no_match');
  const find = recordGet(state.finds, findId(block, pattern.number));
  assert(find && hex(find.finder, 32), 'mint_no_find');
  return { ...find, count };
}
export function mintRight({ find, owner, counted, link = null, currentHolder = null, finderWindow = 1008 }) {
  assert(hex(owner, 32) && integer(counted) && integer(finderWindow) && finderWindow > 0, 'mint_right_input');
  assert(find && integer(find.block, 0xffffffff) && integer(find.count) && find.count > 0 && integer(find.findHeight) && counted >= find.findHeight && hex(find.finder, 32), 'mint_find');
  if (link) assert(link.block === find.block && integer(link.linkHeight), 'mint_link');
  if (counted < find.findHeight + finderWindow) return { allowed: owner === find.finder, role: 'finder', until: find.findHeight + finderWindow };
  if (link && link.linkHeight < find.findHeight) return { allowed: hex(currentHolder, 32) && owner === currentHolder, role: 'bitmap', until: null };
  return { allowed: true, role: 'public', until: null };
}
// Invoke in accepted contract order and persist atomically with that acceptance.
// The caller supplies fresh indexed mint status, Bitmap holder and Trac balance.
export function acceptMintRequest({ state = { holds: {}, minted: {}, pending: {} }, request, sig, network, counted,
  find = null, compound = false, link = null, currentHolder = null, minted = false, balance, settings = {} }) {
  const s = { ...MINT_DEFAULTS, ...settings }, op = makeRealOp({ request, sig }, network, counted), id = pendingId(network, request);
  assert(typeof balance === 'string' && /^(0|[1-9][0-9]*)$/.test(balance) && BigInt(balance) >= BigInt(request.amount), 'mint_balance');
  const nonceKey = `${request.owner}:${request.nonce}`;
  assert(!state.pending[id] && !state.usedNonces?.[nonceKey], 'mint_replay');
  let key = null;
  if (compound) assert(!Object.hasOwn(request, 'block'), 'compound_block');
  else {
    assert(find && request.block === find.block && request.asset === find.asset && request.amount === String(find.count), 'mint_count');
    const right = mintRight({ find, owner: request.owner, counted, link, currentHolder, finderWindow: s.finderWindow });
    assert(right.allowed, `mint_${right.role}`); key = `${request.asset}/${request.block}`;
    assert(!minted && !state.minted[key], 'already_minted');
    const hold = state.holds[key]; assert(!hold || counted > hold.expiry, 'block_pending');
  }
  const pending = { id, key, owner: request.owner, asset: request.asset, amount: request.amount, created: counted, expiry: request.expires };
  return { op, id, pending, state: { ...state, usedNonces: { ...state.usedNonces, [nonceKey]: true }, holds: { ...state.holds, ...(key ? { [key]: pending } : {}) }, pending: { ...state.pending, [id]: pending } } };
}
export function finishMintRequest(state, id, counted, { inscription = null } = {}) {
  const p = state.pending[id]; assert(p && integer(counted) && counted >= p.created, 'mint_pending');
  assert(inscription ? p.consumed === true : !p.paymentSeen && !p.consumed && counted > p.expiry, 'mint_pending');
  const op = inscription ? completeRealOp(id, inscription) : cancelRealOp(id), pending = { ...state.pending }, holds = { ...state.holds };
  delete pending[id]; if (!inscription && p.key && holds[p.key]?.id === id) delete holds[p.key];
  return { op, state: { ...state, pending, holds, minted: { ...state.minted, ...(inscription && p.key ? { [p.key]: inscription } : {}) } } };
}
export function mintTiming(pending, counted) {
  assert(integer(pending.created) && integer(counted), 'mint_timing');
  return { maySignOrBroadcast: pending.consumed === true, reservationExpires: pending.paymentSeen || pending.consumed ? null : pending.expiry };
}
