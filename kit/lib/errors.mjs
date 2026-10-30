import { KIT_UPGRADE_MESSAGE } from '../../rules/src/kit-release.js';
// Only bounded codes are echoed. Remote bodies and nested errors may contain
// credentials, private paths or signed payloads.
export const errorMeanings = Object.freeze({
  tnk_invalid_address: 'Use a checksum-valid lowercase trac1… address for the TNK recipient.',
  tnk_invalid_amount: 'Use a positive decimal TNK string with at most 18 fractional digits, or max. Numbers, exponent notation and leading zeros are not accepted.',
  tnk_invalid_action_id: 'Choose a stable action ID of 1–64 letters, numbers, dots, dashes or underscores.',
  tnk_invalid_tx: 'Use the 64-character lowercase transaction hash returned by the TNK send.',
  tnk_self: 'The TNK recipient must differ from this agent’s address.',
  tnk_insufficient: 'The agent needs an MSB account with enough TNK for the positive transfer amount plus the current MSB fee. V2 game moves need 0 TNK.',
  tnk_validators: 'Sending TNK requires at least three distinct connected validators. Wait for connections and retry the same action ID.',
  tnk_unknown_status: 'TNK confirmation is unknown. Preserve the action ID and journal. A saved signed packet can be resent unchanged; an interrupted signing claim requires reconciliation and will not sign again.',
  tnk_action_conflict: 'This TNK action ID already belongs to a different recipient or amount. Retry its saved intent.',
  tnk_unavailable: 'This adapter does not expose native MSB TNK operations. Use the pinned player runtime.',
  tnk_fee_unavailable: 'The current MSB fee is unavailable. Wait for synchronization and retry.',
  tnk_balance_unavailable: 'The MSB account returned an invalid balance. Wait for synchronization and retry.',
  tnk_balance_changed: 'The balance or fee changed while preparing max. The signed packet is retained and was not sent; reconcile it before preparing another action.',
  tnk_signer: 'The native MSB wallet must belong to this agent.',
  tnk_packet: 'The native TNK packet does not match its saved transfer. Preserve the journal for reconciliation.',
  tnk_prepare_failed: 'Native TNK preparation failed. Its signing claim is retained; inspect the saved action before attempting a different action ID.',
  tnk_dry_run: 'The dry-run runtime cannot sign or submit TNK transactions.',
  upgrade_required: KIT_UPGRADE_MESSAGE,
  public_projection_pending: 'The v2 public index for this scope is catching up or its worker is blocked. Check public_status and retry this read; this is not an empty catalog or proof that a slot is free.',
  projection_asset_version: 'The gateway projection worker encountered an incompatible asset version. The operator must repair the index; keep local history and retry public reads later.',
  page_cursor_stale: 'This collection revision changed; restart the traversal with the same filters and no cursor.',
  claimed_cursor_stale: 'The submitted-block or mint-state revision changed; restart claimed_blocks with the same filters and no cursor.',
  claimed_query: 'Use a p2:NUMBER asset, limit 1–50, sort block, order asc/desc and only found/minted filters for claimed_blocks.',
  account_v2_required: 'Direct legacy TNK matter transfers are unavailable on dmw-v2. Preserve the intent; an authenticated v2 account transfer adapter is required.',
  transfer_v2_unavailable: 'Unit transfers activate with the public-mint settings height. Before activation they are unavailable. Live mode saves the account authorization locally, but nothing is submitted or charged. Keep the same action ID and journal; wait for activation before sending.',
  transfer_intent_stale: 'The saved transfer authorization uses an earlier account revision. It is retained unchanged; reconcile its intent before preparing a replacement.',
  transfer_intent_expired: 'The saved transfer authorization expired. It is retained unchanged; reconcile its intent before preparing a replacement.',
  transfer_assets: 'Use 1–16 distinct ledger assets and positive decimal integer amounts (at most 78 digits).',
  transfer_unknown_asset: 'This asset has no available units in your accepted account and was not found in the catalog. Check the exact asset ID in agent_profile balances.',
  transfer_insufficient_units: 'Not enough spendable units for this exact ledger asset. Reserved units cannot be sent. Imported pattern balances may use p0-style ledger IDs; check agent_profile balances.',
  transfer_legacy_action: 'This action ID already belongs to a saved legacy transaction. Preserve and reconcile it before preparing a different transfer.',
  transfer_account_changed: 'The accepted matter account changed during transfer preparation. Retry the same action ID.',
  transfer_capacity: 'This transfer exceeds the accepted account action or leaf limit. Reduce the number of assets before signing.',
  transfer_balance: 'The independent account balance reader returned an invalid amount. No transfer was prepared.',
  v2_batch_verifier_required: 'Automatic saved-move reconciliation needs an independent v2 accepted batch verifier. Keep the original packet; receipt admission is not a final game outcome.',
  next_batch_work_capacity: 'The next batch has no remaining work reservation. Retry the same action after it completes.',
  next_batch_byte_capacity: 'The next batch has no remaining byte reservation. Retry the same action after it completes.',
  closure_backlog_capacity: 'Earlier claim windows are still settling. Wait for Retry-After, then retry the same saved action.',
  next_batch_account_capacity: 'The next batch has no remaining account-proof reservation. Retry the same saved action after it completes.',
  compound_tier_cursor: 'The accepted tier calculation has advanced. Reconcile this action before preparing another step.',
  trac_address_required: 'Use a checksum-valid trac1… Trac address; raw hex keys are not accepted.',
  mint_balance: 'You do not have enough spendable units; an existing request may have reserved them.',
  mint_count: 'A pattern mint must consume exactly this block’s match count.',
  mint_finder: 'This block is still in its finder week, which starts at settlement.',
  financial_mint_right: 'You are not eligible under this block’s current mint ladder. Check its finder week, qualifying Bitmap holder and your available units.',
  public_minted: 'This block was already taken by a public TAP Wallet mint. Choose another unclaimed block.',
  claimed_first: 'An agent claimed this block before your payment was confirmed. Your payment is refunded.',
  claimed: 'This block has a settled or pending claim. Use the agent mint ladder once the claim settles; it is unavailable for wallet-only public minting.',
  someone_paid_first: 'An earlier confirmed payment won this block. Check the request’s refund records before paying again.',
  bitmap_holder_only: 'This quote uses an earlier mint policy. Refresh the block and request a new quote.',
  public_mint_inactive: 'The wallet-only public mint policy has not activated at the accepted Bitcoin height.',
  public_scan_pending: 'Confirmed Bitcoin payment order or pending claims are still being checked. No public reservation has been created.',
  mint_bitmap: 'This request uses an earlier mint policy. Refresh the block and request a new quote.',
  already_minted: 'This pattern slot has already been made real.',
  block_pending: 'This pattern slot already has an active reservation.',
  link_terms: 'The Bitmap is already linked, the owner is not its current holder, or the link terms are invalid.',
  asset_unregistered: 'Deployment needed. Use inscribe_deployment for the pattern element and deploy, or for the first maker’s compound deploy, then retry the quote.',
  list_path_missing: 'The JSON pointer has no such position in the returned source page; preserve its filters, order, cursor and limit.',
  invalid_cursor: 'The cursor does not match this route, filters, ordering or collection revision; restart the traversal.',
  request_rate: 'The gateway is pacing requests; wait before retrying the same action.',
  reveal_capacity: 'The gateway reveal allowance is full for this Bitcoin block. Retry the same discovery action ID after the next block; a receipt is still needed.',
  sender_rate: 'The gateway is pacing this player; wait before retrying the same action ID.',
  not_found: 'The requested public record or route is unavailable.',
  request_not_found: 'No payment request with this ID is known at this route.',
  financial_action_unknown: 'No accepted financial action with this ID is known to this gateway.',
  financial_custody_missing: 'No beneficiary custody liability with this ID is known to this gateway.',
  insufficient_balance: 'The wallet lacks enough spendable units for this action.',
  holder_unavailable: 'Current Bitmap ownership could not be verified; minting waits for that evidence.',
  finder_address_missing: 'The finder must bind a payout wallet for this payment rail.',
  discoverer_receiver: 'Only the discoverer can deploy this token during its first week. After that anyone can, and the deployer keeps its art rights.',
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
  account_insufficient: 400, account_signature: 400, account_replay: 400, claim_deadline: 400, public_minted: 400, craft_authorization: 400, craft_output: 400, compound_tier_cursor: 400, compound_tier_complete: 400,
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
