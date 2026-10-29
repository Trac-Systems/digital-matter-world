// Only locally defined codes are logged. Never serialize an upstream error.
const codes = new Set(['mint_sender_seed_unavailable', 'mint_sender_journal_identity', 'mint_sender_journal_missing',
  'mint_sender_directory', 'mint_sender_journal_path', 'mint_sender_status_path', 'mint_sender_separate_store',
  'mint_sender_gateway_loopback', 'mint_sender_config', 'mint_sender_config_path', 'mint_sender_settings',
  'mint_sender_funding_cap', 'mint_sender_http_status', 'mint_sender_response_limit', 'mint_sender_timeout',
  'mint_sender_source_unavailable', 'mint_sender_bitcoin_network', 'mint_sender_source_network',
  'mint_sender_utxos', 'mint_sender_coin', 'mint_sender_transaction_missing', 'mint_sender_coin_binding',
  'mint_sender_fee_unavailable', 'mint_sender_transaction_binding', 'mint_sender_broadcast_binding',
  'mint_sender_gateway_unavailable', 'mint_sender_gateway_identity', 'mint_sender_gateway_binding',
  'mint_sender_funding_binding', 'mint_sender_request_changed', 'mint_sender_status_binding',
  'mint_sender_coin_changed', 'mint_sender_permit_changed', 'mint_sender_plan_immutable',
  'mint_sender_return_immutable', 'mint_sender_coin_immutable', 'mint_sender_spend_conflict']);
export const mintSenderError = error => codes.has(error?.message) ? error.message : 'mint_sender_dependency_unavailable';
