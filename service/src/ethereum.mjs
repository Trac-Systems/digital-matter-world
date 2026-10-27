import { createEscrowReader } from '../../committee/signer/escrow-reader.mjs';
import { expectedEscrowSplit, ethereumSignature, escrowRelease, calldata, bytes32, keccak, ethAddress, abiWord } from '../../committee/signer/escrow.mjs';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
export { expectedEscrowSplit, ethereumSignature };
const eventTopic = text => '0x' + keccak(Buffer.from(text)).toString('hex');
const RELEASED = eventTopic('Released(bytes32,address,address,bytes32,uint256,address,uint256)');
const REFUNDED = eventTopic('Refunded(bytes32,address,address,uint256)');
export function releaseCalldata(payer, id, signature) {
  check(/^0x[0-9a-f]{130}$/.test(signature), 'ethereum_signature');
  return calldata('release(address,bytes32,bytes)', [['address', ethAddress(payer)], ['bytes32', id], ['uint256', '96'], ['uint256', '65']]) + signature.slice(2).padEnd(192, '0');
}
// Read-only escrow observations. Callers submit release calldata themselves.
export function ethereumPayments({ rpc, escrow }) {
  const reader = createEscrowReader({ rpc, ...escrow });
  const domainMatches = p => p.chainId === escrow.chainId && p.contract === escrow.address.toLowerCase() && p.token === escrow.token.toLowerCase();
  return {
    ethereumDomainMatches: domainMatches,
    async observe(kind, id, payer) {
      check(kind === 'ethereum', 'payment_kind');
      const snapshot = await reader.deposit(payer, id), d = snapshot.deposit;
      return { id, requestId: snapshot.requestId, kind, chainId: snapshot.chainId, contract: snapshot.address, token: snapshot.token,
        payer: d.payer, total: d.amount, expiry: d.expiry, splitHash: d.splitHash, split: d.split, status: d.status,
        consumed: d.status !== 1, confirmations: snapshot.confirmations };
    },
    async live(payment) { const s = await reader.deposit(payment.payer, payment.requestId); return domainMatches(payment) && s.deposit.status === 1 && BigInt(s.deposit.expiry) > BigInt(s.timestamp); },
    async settled(kind, id, payer) {
      check(kind === 'ethereum', 'payment_kind');
      payer = ethAddress(payer);
      const s = await reader.deposit(payer, id); if (s.deposit.status !== 2 && s.deposit.status !== 3) return null;
      const topic = s.deposit.status === 2 ? RELEASED : REFUNDED;
      const payerTopic = '0x' + Buffer.from(abiWord('address', payer)).toString('hex');
      const logs = await rpc('eth_getLogs', [{ address: escrow.address, fromBlock: escrow.fromBlock ?? '0x0', toBlock: s.blockNumber, topics: [topic, bytes32(id), payerTopic] }]);
      check(logs.length === 1 && logs[0].removed === false && logs[0].address.toLowerCase() === escrow.address.toLowerCase(), 'escrow_settlement_event');
      check(logs[0].topics?.[0]?.toLowerCase() === topic && logs[0].topics?.[1]?.toLowerCase() === bytes32(id) && logs[0].topics?.[2]?.toLowerCase() === payerTopic, 'escrow_settlement_binding');
      const event = logs[0]; check((await rpc('eth_getBlockByNumber', [event.blockNumber, false]))?.hash === event.blockHash, 'escrow_settlement_reorg');
      const confirmations = Number(BigInt(s.blockNumber) - BigInt(event.blockNumber) + 1n);
      check(Number.isSafeInteger(confirmations) && confirmations > 0, 'escrow_confirmations');
      return { requestId: id, payer, kind: s.deposit.status === 2 ? 'claim' : 'refund', confirmations };
    },
    releaseTransaction(request, signed) {
      return { to: escrow.address, data: releaseCalldata(request.payer, request.id, signed.ethereumSignature ?? ethereumSignature(signed.signature)) };
    }
  };
}
