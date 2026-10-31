// Only locally defined codes are logged. Never serialize an upstream error.
const codes = new Set(['mint_payout_journal', 'mint_payout_pending', 'mint_payout_plan_immutable', 'mint_payout_evidence_immutable', 'mint_payout_state', 'mint_payout_evidence', 'mint_payout_fee', 'mint_payout_record', 'mint_payout_tap_behind', 'mint_payout_content', 'mint_payout_changed', 'mint_payout_already_paid', 'mint_refund_tap_behind', 'mint_refund_evidence', 'mint_refund_evidence_immutable', 'mint_refund_amount', 'mint_refund_authority', 'mint_refund_authority_binding', 'mint_refund_authority_cancelled', 'mint_refund_authority_content', 'mint_refund_authority_funding', 'mint_refund_authority_outputs', 'mint_refund_binding', 'mint_refund_content', 'mint_refund_evidence_retry', 'mint_refund_fee', 'mint_refund_float_coin_unknown', 'mint_refund_id', 'mint_refund_plan_immutable', 'mint_refund_record', 'mint_refund_record_changed', 'mint_refund_redeem_content', 'mint_refund_reference', 'mint_refund_retry', 'mint_refund_signature', 'mint_refund_tap_balance', 'mint_refund_tap_canonical', 'mint_refund_tap_changed', 'mint_refund_tap_height', 'mint_refund_tap_page', 'mint_refund_tap_response', 'mint_refund_transfer_binding', 'mint_refund_transfer_count', 'mint_sender_refund_bounds', 'mint_sender_refund_reserve', 'mint_sender_refund_tickers',
  'mint_sender_seed_unavailable', 'mint_sender_journal_identity', 'mint_sender_journal_missing',
  'mint_sender_directory', 'mint_sender_journal_path', 'mint_sender_status_path', 'mint_sender_separate_store',
  'mint_sender_gateway_loopback', 'mint_sender_config', 'mint_sender_config_path', 'mint_sender_settings',
  'mint_sender_funding_cap', 'mint_sender_http_status', 'mint_sender_response_limit', 'mint_sender_timeout',
  'mint_sender_source_unavailable', 'mint_sender_bitcoin_network', 'mint_sender_source_network',
  'mint_sender_utxos', 'mint_sender_coin', 'mint_sender_transaction_missing', 'mint_sender_coin_binding',
  'mint_sender_fee_unavailable', 'mint_sender_transaction_binding', 'mint_sender_broadcast_binding',
  'mint_sender_gateway_unavailable', 'mint_sender_gateway_identity', 'mint_sender_gateway_binding',
  'mint_sender_funding_binding', 'mint_sender_refund_binding', 'mint_sender_request_changed', 'mint_sender_status_binding',
  'mint_sender_coin_changed', 'mint_sender_permit_changed', 'mint_sender_plan_immutable',
  'mint_sender_return_immutable', 'mint_sender_coin_immutable', 'mint_sender_spend_conflict']);
export const mintSenderError = error => codes.has(error?.message) ? error.message : 'mint_sender_dependency_unavailable';
