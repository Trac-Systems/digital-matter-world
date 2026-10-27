import { attestBinding, bindingKey, verifyWalletBinding } from '../../rules/src/payout-bindings.mjs';
import { check, canonicalJSON } from './crypto.mjs';

export function verifyPayoutSnapshot(snapshot, payouts, { bindings, journal }) {
  check(snapshot?.payouts && canonicalJSON(snapshot.payouts) === canonicalJSON(payouts), 'binding_snapshot_missing');
  for (const id of Object.values(payouts).filter(Boolean)) {
    const proof = bindings.proof(id), key = bindingKey(proof.request.agent, proof.request.rail);
    const known = journal.records.findLast(r => r.type === 'payout-binding' && r.key === key)?.record;
    check(!known || BigInt(known.request.nonce) <= BigInt(proof.request.nonce) || snapshot.issuedAt < known.acceptedAt, 'binding_rollback');
  }
}

// Called inside the signer's serialized request queue. A persisted nonce cannot
// be reused for another address, including after a crash or a gateway rollback.
export async function endorseBinding(record, { config, secrets, journal, bitcoinNetwork, now = Date.now() }) {
  const options = { network: config.network, bitcoinNetwork, now };
  const id = verifyWalletBinding(record, { ...options, historical: true });
  check(record.id === id, 'binding_id');
  const key = bindingKey(record.request.agent, record.request.rail);
  const prior = journal.records.findLast(r => r.type === 'payout-binding' && r.key === key);
  if (prior?.record.id === id) { check(canonicalJSON(prior.record) === canonicalJSON(record), 'binding_conflict'); return prior.attestation; }
  verifyWalletBinding(record, options);
  check(Number.isSafeInteger(record.acceptedAt) && record.acceptedAt <= now && now - record.acceptedAt <= 60000 && record.acceptedAt < record.request.expiry, 'binding_clock');
  check(!prior || BigInt(record.request.nonce) > BigInt(prior.record.request.nonce) && record.acceptedAt > prior.record.acceptedAt, 'binding_nonce');
  const attestation = attestBinding(record, { ...options, signer: config.id, secret: secrets.identity });
  await journal.append('payout-binding', { key, record, attestation });
  return attestation;
}
