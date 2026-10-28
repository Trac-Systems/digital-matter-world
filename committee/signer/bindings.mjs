import { attestBinding, bindingKey, bindingBarrier, BINDING_V2_DEFAULTS, verifyWalletBinding } from '../../rules/src/payout-bindings.mjs';
import { check, canonicalJSON } from './crypto.mjs';

export async function verifyPayoutSnapshot(snapshot, payouts, { bindings, journal }) {
  check(snapshot?.payouts && canonicalJSON(snapshot.payouts) === canonicalJSON(payouts), 'binding_snapshot_missing');
  for (const id of Object.values(payouts).filter(Boolean)) {
    const proof = await bindings.proof(id), key = bindingKey(proof.request.agent, proof.request.rail);
    const known = journal.records.findLast(r => r.type === 'payout-binding' && r.key === key)?.record;
    check(!known || BigInt(known.request.nonce) <= BigInt(proof.request.nonce) || snapshot.issuedAt < bindingBarrier(known), 'binding_rollback');
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
  const retry = prior?.record.id === id && record.request.v === 2 && BigInt(record.attempt) > BigInt(prior.record.attempt);
  if (prior?.record.id === id && !retry) { check(canonicalJSON(prior.record) === canonicalJSON(record), 'binding_conflict'); return prior.attestation; }
  if (record.request.v === 2) check(typeof record.attempt === 'string' && /^(0|[1-9][0-9]*)$/.test(record.attempt) &&
    Number.isSafeInteger(record.blockedAt) && record.blockedAt >= 0 && record.blockedAt <= record.acceptedAt, 'binding_attempt');
  if (retry) check(record.blockedAt === prior.record.blockedAt && record.agentSignature === prior.record.agentSignature &&
    record.walletSignature === prior.record.walletSignature && canonicalJSON(record.request) === canonicalJSON(prior.record.request), 'binding_conflict');
  verifyWalletBinding(record, options);
  const freshnessMs = record.request.v === 2 ? config.bindingFreshnessMs ?? BINDING_V2_DEFAULTS.freshnessMs : 60000;
  check(Number.isSafeInteger(record.acceptedAt) && record.acceptedAt <= now && now - record.acceptedAt <= freshnessMs && record.acceptedAt < record.request.expiry, 'binding_clock');
  check(!prior || (retry || BigInt(record.request.nonce) > BigInt(prior.record.request.nonce)) && record.acceptedAt > prior.record.acceptedAt &&
    (prior.record.request.v !== 2 || record.request.v === 2), 'binding_nonce');
  const attestation = attestBinding(record, { ...options, signer: config.id, secret: secrets.identity });
  await journal.append('payout-binding', { key, record, attestation });
  return attestation;
}
