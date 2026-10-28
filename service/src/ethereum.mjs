import { createEscrowReader } from '../../committee/signer/escrow-reader.mjs';
import { expectedEscrowSplit, ethereumSignature, calldata, ethAddress } from '../../committee/signer/escrow.mjs';
import { check } from './util.mjs';
export { expectedEscrowSplit, ethereumSignature };
export function releaseCalldata(payer, id, signature) {
  check(/^0x[0-9a-f]{130}$/.test(signature), 'ethereum_signature');
  return calldata('release(address,bytes32,bytes)', [['address', ethAddress(payer)], ['bytes32', id], ['uint256', '96'], ['uint256', '65']]) + signature.slice(2).padEnd(192, '0');
}
// Read-only escrow observations. Callers submit release calldata themselves.
export function ethereumPayments({ rpc, escrow }) {
  let reader; const getReader = () => reader ??= createEscrowReader({ rpc, ...escrow, events: rpc?.escrowEvents });
  const domainMatches = p => p.chainId === escrow.chainId && p.contract === escrow.address.toLowerCase() && p.token === escrow.token.toLowerCase();
  return {
    ethereumDomainMatches: domainMatches,
    async observe(kind, id, payer, hint) {
      check(kind === 'ethereum', 'payment_kind');
      const snapshot = await getReader().deposit(payer, id, hint), d = snapshot.deposit;
      return { id, requestId: snapshot.requestId, kind, chainId: snapshot.chainId, contract: snapshot.address, token: snapshot.token,
        payer: d.payer, total: d.amount, expiry: d.expiry, splitHash: d.splitHash, split: d.split, status: d.status,
        consumed: d.status !== 1, confirmations: snapshot.confirmations };
    },
    async live(payment) { const s = await getReader().deposit(payment.payer, payment.requestId); return domainMatches(payment) && s.deposit.status === 1 && BigInt(s.deposit.expiry) > BigInt(s.timestamp); },
    async settled(kind, id, payer, hint = {}) {
      check(kind === 'ethereum', 'payment_kind');
      payer = ethAddress(payer);
      const s = await getReader().deposit(payer, id, hint); if (s.deposit.status !== 2 && s.deposit.status !== 3) return null;
      const event = await getReader().events.find(s.deposit.status === 2 ? 'release' : 'refund', payer, id, s.blockNumber, hint.settlementTxid);
      const confirmations = Number(BigInt(s.blockNumber) - BigInt(event.blockNumber) + 1n);
      check(Number.isSafeInteger(confirmations) && confirmations > 0, 'escrow_confirmations');
      check((await rpc('eth_getBlockByNumber', [s.blockNumber, false]))?.hash === s.blockHash, 'escrow_reorg');
      return { requestId: id, payer, kind: s.deposit.status === 2 ? 'claim' : 'refund', confirmations, transactionHash: event.transactionHash, blockNumber: event.blockNumber, blockHash: event.blockHash, logIndex: event.logIndex };
    },
    releaseTransaction(request, signed) {
      return { to: escrow.address, data: releaseCalldata(request.payer, request.id, signed.ethereumSignature ?? ethereumSignature(signed.signature)) };
    }
  };
}
