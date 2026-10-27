import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { canonicalJSON, check, equal, hex, isHex, sha256 } from './crypto.mjs';
import { permit, requestID, rules } from './adapter.mjs';
const bodyFor = (network, details, signature) => ({ domain: 'dmw-mint-result-v1', network, details, signature });
export function attestMintResult(network, details, signature, signer, secret) {
  const body = bodyFor(network, details, signature);
  return { signer, sig: hex(ed25519.sign(Buffer.from(canonicalJSON(body)), Buffer.from(secret, 'hex'))) };
}
export function verifyMintResult(details, signature, { network, publicKey, id }) {
  check(details?.id === id, 'mint_certificate');
  const r = details.request;
  check(requestID(network, r) === id && rules.verifyRequest('rq', network, r, details.signature, r.until) && sha256(details.receiver) === r.receive, 'certificate_request');
  check(details.deployment.privilegePublicKey === publicKey, 'certificate_authority');
  const expected = permit(network, r, details.deployment, details.receiver, id, rules.paymentCommitment(details.payment.allocations));
  check(equal(expected, details.permit), 'certificate_permit');
  check(isHex(signature?.compact, 64) && /^[0-9]+$/.test(signature.r) && /^[0-9]+$/.test(signature.s) && [0, 1].includes(signature.v), 'certificate_signature');
  const parsed = secp256k1.Signature.fromCompact(signature.compact);
  check(parsed.r === BigInt(signature.r) && parsed.s === BigInt(signature.s) &&
    secp256k1.verify(signature.compact, expected.digest, publicKey, { lowS: true, prehash: false }) &&
    parsed.addRecoveryBit(signature.v).recoverPublicKey(expected.digest).toHex() === publicKey, 'certificate_signature');
  return details;
}
export function verifyMintCertificate(certificate, { network, members, publicKey, id, rosterHistory = [] }) {
  if (rosterHistory.length) {
    let last;
    for (const roster of [members, ...rosterHistory.map(r => r.members)]) {
      try { return verifyMintCertificate(certificate, { network, members: roster, publicKey, id }); } catch (e) { last = e; }
    }
    throw last;
  }
  check(certificate?.domain === 'dmw-mint-result-v1' && certificate.network === network && members.length === 5 && new Set(members.map(m => m.id)).size === 5 && new Set(members.map(m => m.identity)).size === 5, 'mint_certificate');
  const { details, signature, attestations } = certificate;
  verifyMintResult(details, signature, { network, publicKey, id });
  check(Array.isArray(attestations) && attestations.length >= 3 && attestations.length <= 5 && new Set(attestations.map(a => a.signer)).size === attestations.length, 'certificate_quorum');
  const body = Buffer.from(canonicalJSON(bodyFor(network, details, signature)));
  for (const a of attestations) {
    const member = members.find(m => m.id === a.signer);
    check(member && isHex(a.sig, 64) && ed25519.verify(a.sig, body, member.identity, { zip215: false }), 'certificate_attestation');
  }
  return details;
}
