import { appendFileSync } from 'node:fs';
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
receipt_admission_conflict receipt_admission_fenced receipt_admission_predecessor receipt_admission_policy
receipt_admission_snapshot receipt_admission_checkpoint receipt_cutoff_conflict receipt_cutoff_domain receipt_cutoff_predecessor
receipt_cutoff_checkpoint receipt_cutoff_budget receipt_cutoff_segment receipt_cutoff_segment_chain
receipt_cutoff_range receipt_cutoff_binding receipt_cutoff_omission receipt_cutoff_segment_read
receipt_cutoff_snapshot receipt_cutoff_preparation_uncertain receipt_journal_uncertain
receipt_batch_reserved receipt_batch_omission receipt_witness_identity
discovery_history_adapter_required bitcoin_history_seed_required bitcoin_history_missing bitcoin_header_height
bitcoin_pow bitcoin_link bitcoin_genesis bitcoin_difficulty bitcoin_time bitcoin_seed
evidence_signature evidence_binding evidence_stale evidence_capacity evidence_reorg evidence_projection
evidence_duplicate evidence_missing_or_stale evidence_context_missing evidence_archive_missing
evidence_snapshot_changed evidence_secret_field evidence_archive_hash evidence_row_limit
evidence_version evidence_index_required evidence_snapshot_expired evidence_page_bytes evidence_page
evidence_proof_budget evidence_proof_gap evidence_proof_root evidence_proof_rows evidence_proof
evidence_blob evidence_file_limit evidence_file_changed evidence_key evidence_settings
evidence_migration_snapshot evidence_migration_page evidence_migration_root migration_settings migration_row_order migration_row_bytes
pending_export_request pending_export_network pending_export_legacy_notary pending_export_snapshot_changed pending_export_header_coverage pending_export_history
pending_network pending_legacy_state pending_signed_draft_reconciliation pending_signed_transport_reconciliation pending_signature_reconciliation pending_financial_adapter_required
reconcile_operator_identity reconcile_operator_signature reconcile_operator_pins reconcile_artifact_pins reconcile_notary_records reconcile_source_disagreement
reconcile_page_pins reconcile_signer_journal reconcile_operator_derivation
registry_migration_required registry_keyed_update_required registry_snapshot_changed registry_history_changed
registry_page_required registry_page_bytes registry_record_bytes registry_permissions mint_admission_index_required
bitcoin_history_catching_up tap_lookup_index_catching_up tap_lookup_reorg tap_snapshot_changed
tap_lookup_item_page_required ethereum_index_catching_up escrow_event_reorg escrow_event_page_budget
bitmap_index_reorg bitmap_cursor_changed
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
  // Callers only see bounded codes; operators need the real reason. Codes and stack frames, no secrets.
  if (process.env.DMW157_STATE) try { appendFileSync(process.env.DMW157_STATE + '/signer-refusals.log', `${new Date().toISOString()} ${code} ${String(message).slice(0, 300)} at ${String(error?.stack ?? '').split('\n').slice(1, 4).map(l => l.trim()).join(' | ')}\n`); } catch {}
  if (code === 'signer_error' || process.env.DMW_SIGNER_LOG_ALL) console.error(`signer refusal: ${String(message).slice(0, 300)} at ${String(error?.stack ?? '').split('\n').slice(1, 4).map(l => l.trim()).join(' | ')}`);
  const proof = error?.unreserved;
  return { error: code, ...(proof && /^[0-9a-f]{64}$/.test(proof.id) && /^[0-9a-f]{64}$/.test(proof.proposalHash)
    ? { unreserved: { id: proof.id, proposalHash: proof.proposalHash } } : {}) };
}
