import { verifyMintExit } from '../../rules/src/asset-exits.js';
import { check, equal } from './crypto.mjs';

// Gateway and each signer run this using their own canonical-chain reader.
// getDeposit status 3 is terminal in the existing deployed escrow: the same
// payer/request cannot subsequently release or be deposited again.
export async function mintExitEvidence({ reads, network, id, reason, escrow }) {
  const row = await reads.mintRequest(id), reservation = await reads.pending(id), pending = await reads.pendingAcceptance(id);
  const owner = await reads.agentAddress(reservation?.o), payment = await reads.mintPayment(id);
  const evidence = { reservation, pending, owner, payment };
  if (reason === 'ethereum_refund') {
    check(escrow, 'escrow_domain');
    evidence.domain = { chainId: escrow.chainId, address: escrow.address.toLowerCase(), token: escrow.token.toLowerCase() };
    evidence.refund = await reads.escrowDeposit(row.payer, id);
  }
  const input = { op: 'mx', v: 2, reason, request: row.request, sig: row.signature, evidence };
  return { input, operation: verifyMintExit(input, { network, counted: await reads.counted() }) };
}
export async function verifyMintExitEvidence(input, options) {
  const expected = await mintExitEvidence({ ...options, id: input.evidence.pending.id, reason: input.reason });
  check(equal(input, expected.input), 'mint_exit_read'); return expected.operation;
}
