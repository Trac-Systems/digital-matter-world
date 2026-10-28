// Only known protocol codes cross the HTTP boundary. Dependency messages can
// contain URLs, paths or credentials and must never be returned verbatim.
const codes = new Set(`authentication host_authentication host_body_limit host_escrow_required
signer_closed signer_busy signer_not_caught_up ceremony_id ceremony_members ceremony_roster
ceremony_retired ceremony_reused ceremony_reserved threshold_roster slot_conflict slot_already_reserved
slots journal_double_reservation batch_authority batch_epoch batch_deadline batch_sequence
batch_inputs batch_views batch_uncounted batch_mismatch file_mismatch batch_execution_height
batch_snapshot batch_clock_changed batch_snapshot_changed batch_preflight batch_authority_changed
batch_retirement_snapshot batch_retirement_unproven batch_reservation_missing
preflight_snapshot preflight_budget preflight_batch receipt_certificate_read receipt_roster_changed
claim_budget_policy receipt_root receipt_attestations receipt_invalid receipt_root_conflict receipt_clock
receipt_observation block_clock execution_height counted_retreat tip_gap discovery_work
discovery_history_adapter_required bitcoin_history_seed_required bitcoin_history_missing bitcoin_header_height
bitcoin_pow bitcoin_link bitcoin_genesis bitcoin_difficulty bitcoin_time bitcoin_seed
evidence_signature evidence_binding evidence_stale evidence_capacity evidence_reorg evidence_projection
evidence_duplicate evidence_missing_or_stale evidence_context_missing evidence_archive_missing
evidence_snapshot_changed evidence_secret_field evidence_archive_hash evidence_row_limit
trac_snapshot_changed read_snapshot_changed http_timeout http_unavailable http_status http_queue
replay_busy replay_timeout replay_exit replay_startup recovery_result sidecar_session permit_recovery_required
session_parameters session_reused session_busy sign_state sign_membership session_kind session_identity
start_format session_missing session_inactive not_prepared not_ready result_id peer_refused rpc_error
host_registry_signature host_registry_policy_changed host_registry_bound host_registry_history_removed
host_registry_destinations host_registry_definition host_registry_first_maker host_registry_changed_during_sync
network proposal_kind route body_limit`.split(/\s+/));
export function signerError(error) {
  const message = error?.message;
  const code = codes.has(message) ? message : /^preflight:[a-z][a-z0-9_]{0,50}$/.test(message) ? message.replace(':', '_') : 'signer_error';
  const proof = error?.unreserved;
  return { error: code, ...(proof && /^[0-9a-f]{64}$/.test(proof.id) && /^[0-9a-f]{64}$/.test(proof.proposalHash)
    ? { unreserved: { id: proof.id, proposalHash: proof.proposalHash } } : {}) };
}
