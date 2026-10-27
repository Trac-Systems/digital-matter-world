import { fixture } from './fixture.mjs';
import { rules } from '../signer/adapter.mjs';
import { committeeAddress, expectedEscrowSplit, hashSplit, escrowRelease, escrowRotation } from '../signer/escrow.mjs';

export const localAddress = byte => '0x' + byte.repeat(20);
export function ethereumFixture({ publicKey, escrow = { chainId: '31337', address: localAddress('12'), token: localAddress('34') }, payer = localAddress('45'), treasury = localAddress('56'), finder = localAddress('67'), landowner = localAddress('78'), baseFee = '100', kind = 'dmt' } = {}) {
  const f = fixture(kind, publicKey, baseFee), context = f.data.context;
  Object.assign(context, { treasury, finderAddress: finder, firstMakerAddress: finder, landownerAddress: landowner });
  if (kind === 'dmt') {
    context.link = { block: 10, linkHeight: 90 };
    f.data.bitmap = { agent: f.proposal.request.owner, address: landowner };
  }
  f.data.payer = payer;
  f.data.payment = { id: f.proposal.paymentId, requestId: f.id, kind: 'ethereum', payer, chainId: escrow.chainId, contract: escrow.address, token: escrow.token, refundAfterBitcoin: 700 };
  const amount = rules.feeFor(kind === 'dmt' ? 'find' : 'compound', baseFee, 1);
  const split = expectedEscrowSplit(rules.splitFee(amount, { kind: kind === 'dmt' ? 'find' : 'compound', linked: kind === 'dmt' }), { treasury, finder, firstMaker: finder, landowner }, kind === 'compound');
  f.data.escrow = { ...escrow, timestamp: '1000', committee: committeeAddress(f.publicKey), committeeEpoch: '0', rotationNonce: '0', pendingCommittee: { successor: localAddress('00'), executableAt: '0', nonce: '0', adminOrigin: false }, payer, requestId: f.id, confirmations: 1, deposit: { payer, status: 1, amount, expiry: '10000', splitHash: hashSplit(split), split } };
  f.refresh = () => { f.data.escrow.deposit.splitHash = hashSplit(f.data.escrow.deposit.split); f.data.escrow.releaseDigest = escrowRelease(escrow, f.id, f.data.escrow.deposit, f.data.escrow.committeeEpoch).digest; };
  f.reprice(); f.data.payment.depositFinal = true; f.data.payment.split = split;
  f.refresh(); f.policy.escrow = escrow;
  f.reads.escrowDeposit = async () => structuredClone(f.data.escrow);
  f.reads.committeeRotation = async () => f.data.rotation;
  f.reads.escrowRotation = async (successor, deadline) => ({ ...f.data.escrow, rotationDigest: escrowRotation(escrow, successor, f.data.escrow.rotationNonce, f.data.escrow.committeeEpoch, deadline).digest });
  return f;
}
