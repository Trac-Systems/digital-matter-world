import { KIT_UPGRADE_MESSAGE } from '../../rules/src/kit-release.js';
// Only bounded codes are echoed. Remote bodies and nested errors may contain
// credentials, private paths or signed payloads.
export const errorMeanings = Object.freeze({
  upgrade_required: KIT_UPGRADE_MESSAGE,
  next_batch_work_capacity: 'The next batch has no remaining work reservation. Retry the same action after it completes.',
  next_batch_byte_capacity: 'The next batch has no remaining byte reservation. Retry the same action after it completes.',
  closure_backlog_capacity: 'Earlier claim windows are still settling. Wait for Retry-After, then retry the same saved action.',
  next_batch_account_capacity: 'The next batch has no remaining account-proof reservation. Retry the same saved action after it completes.',
  compound_tier_cursor: 'The accepted tier calculation has advanced. Reconcile this action before preparing another step.',
  trac_address_required: 'Use a checksum-valid trac1… Trac address; raw hex keys are not accepted.',
  mint_balance: 'You do not have enough spendable units; an existing request may have reserved them.',
  mint_count: 'A pattern mint must consume exactly this block’s match count.',
  mint_finder: 'Only the finder may mint during the exclusive finder window.',
  mint_bitmap: 'Only the current holder of the qualifying linked Bitmap may mint.',
  already_minted: 'This pattern slot has already been made real.',
  block_pending: 'This pattern slot already has an active reservation.',
  link_terms: 'The Bitmap is already linked, the owner is not its current holder, or the link terms are invalid.',
  asset_unregistered: 'Deployment needed. Use inscribe_deployment for the pattern element and deploy, or for the first maker’s compound deploy, then retry the quote.',
  list_path_missing: 'The JSON pointer has no such position in the returned source page; preserve its filters, order, cursor and limit.',
  invalid_cursor: 'The cursor does not match this route, filters or ordering, or the gateway restarted; restart the traversal.',
  request_rate: 'The gateway is pacing requests; wait before retrying the same action.',
  reveal_capacity: 'The gateway reveal allowance is full for this Bitcoin block. Retry the same discovery action ID after the next block; a receipt is still needed.',
  sender_rate: 'The gateway is pacing this player; wait before retrying the same action ID.',
  not_found: 'The requested public record or route is unavailable.',
  request_not_found: 'No mint request with this ID is known to this gateway.',
  insufficient_balance: 'The wallet lacks enough spendable units for this action.',
  holder_unavailable: 'Current Bitmap ownership could not be verified; minting waits for that evidence.',
  finder_address_missing: 'The finder must bind a payout wallet for this payment rail.',
  first_maker_address_missing: 'The first maker must bind a payout wallet for this payment rail.',
  tap_burn_redeem_unsupported: 'TAP Wallet redeem items cannot carry a native burn item. Burn shares are paid as an address item to the burn address; ask for a fresh quote.',
  discoverer_address_missing: 'The discoverer must bind a payout wallet for this payment rail.',
  binding_nonce: 'This binding nonce was superseded; read the current binding and prepare a new action.',
  binding_expired: 'The wallet-signing request expired; prepare a new binding action.',
  binding_transition: 'A wallet replacement is awaiting committee endorsements; retry its saved request.',
  binding_quorum_unavailable: 'Fewer than three committee signers endorsed this binding; retry the saved request.',
});
// Only errors known to occur before /moves acceptance qualify. A generic
// HTTP failure, proxy response or interrupted body is not refusal evidence.
const moveRefusals = Object.freeze({ request_rate: 429, sender_rate: 429, reveal_capacity: 429, craft_capacity: 429, named_proof_budget: 429,
  next_batch_account_capacity: 429, compound_work_budget: 429, closure_backlog_capacity: 429,
  account_operation: 429, account_operation_bytes: 429, account_proof_budget: 429, account_leaf_budget: 429,
  account_insufficient: 400, account_signature: 400, account_replay: 400, craft_authorization: 400, craft_output: 400, compound_tier_cursor: 400, compound_tier_complete: 400,
  compound_input_unknown: 400, compound_snapshot: 400, compound_ratio: 400, compound_inputs: 400, resonance_charge: 400,
  upgrade_required: 409, next_batch_work_capacity: 429, next_batch_byte_capacity: 429, ruleset_not_ready: 503, reserved_batch_pending: 503, reservation_context_changed: 503,
  audit_capacity: 429, body_limit: 413, content_type: 415, move_type: 400, invalid_move: 400,
  tip_transition: 503, receipt_window_sealed: 503, discovery_history_adapter_required: 503, pending_capacity: 503 });
export const isMoveRefusal = (status, code) => Object.hasOwn(moveRefusals, code) && moveRefusals[code] === status;
export function safeCode(value, fallback = 'transport_error') {
  if (Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' && /^(?:[a-zA-Z][a-zA-Z0-9_]{0,80}|-?[0-9]{1,12})$/.test(value) ? value : fallback;
}
export function serviceError({ service, origin, route, method = 'GET', status, code, reason, submission = false }) {
  code = safeCode(code);
  const http = status === undefined ? 'no HTTP response' : `HTTP ${status}`;
  return Object.assign(new Error(`${service} ${origin} ${method} ${route}: ${http}, code ${code}; ${errorMeanings[code] ?? reason ?? 'request refused'}${submission ? '; submission outcome may be unknown; retry the same action ID and intent' : ''}`),
    { status, code, service, route });
}
export function explainError(error) {
  return errorMeanings[error.message] ? `Local signer validation (code ${error.message}): ${errorMeanings[error.message]}` : error.message;
}
