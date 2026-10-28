import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { custodyId } from '../../contract/financial-lifecycle.js';
import { financialFeeKey } from './financial-fee-identity.mjs';
import { payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { calldata } from '../../committee/signer/escrow.mjs';
import { keccak_256 } from '../../contract/node_modules/@noble/hashes/sha3.js';

const transferTopic = '0x' + Buffer.from(keccak_256(Buffer.from('Transfer(address,address,uint256)'))).toString('hex');
export const custodyPaymentData = claim => 'dmw-custody/' + claim;
export const custodyEthereumData = row => calldata('transfer(address,uint256)', [['address', row.destination], ['uint256', row.amount]]) + row.claim;
export const custodyReceipt = (network, domain, hint) => rules.hashObject(['dmw-custody-receipt-v2', network, domain, hint.reference, hint.index]);

export function installCustodySources(reads, { network, bitcoinNetwork, accepted, payout, ethereumRPC }) {
  const original = async (row, at) => {
    const { source, funding } = await accepted(row.request, at), fee = source.feeItems.find(f => financialFeeKey(f) === row.fee);
    check(fee?.financialIdentity?.beneficiary === row.owner && fee.to === row.custodian && fee.amount === row.amount &&
      source.rail === row.rail && funding.state === 'consumed', 'financial_custody_terms');
    return { source, funding, fee };
  };
  reads.financialCustodyAccruals = async (id, at) => {
    const { source, funding } = await accepted(id, at);
    check(funding.state === 'consumed', 'financial_custody_unconsumed');
    return (source.custody ?? []).map(c => {
      const fee = source.feeItems.find(f => f.role === c.role), key = financialFeeKey(fee);
      return { type: 'custody-accrue', id: custodyId(id, key), request: id, fee: key, owner: c.owner, rail: c.rail, custodian: c.custodian, amount: c.amount };
    });
  };
  reads.financialCustodyEvidence = async (action, at, suppliedHint) => {
    const a = action;
    // Accepted allocations are only spendable while their entire verified
    // chain prefix remains canonical. A fork freezes this path for recovery.
    check(reads.financialChainAnchor, 'financial_custody_chain_adapter');
    const prior = await reads.financialRecord('fp/chain', at);
    check(prior, 'financial_custody_chain_checkpoint');
    await reads.financialChainAnchor({ at, prior });
    if (a.type === 'custody-accrue') {
      const actions = await reads.financialCustodyAccruals(a.request, at);
      check(actions.some(candidate => rules.stableJSON(candidate) === rules.stableJSON(a)), 'financial_custody_identity');
      const { funding } = await original(a, at), { type, id, ...liability } = a;
      return { requestId: id, state: 'custodied', confirmations: 1, liability, terms: funding.terms, fundingRoot: funding.consumedRoot };
    }
    const row = await reads.financialRecord('bc/' + a.id, at);
    check(row, 'financial_custody_missing');
    if (a.type === 'custody-claim') {
      payoutAddress(row.rail, a.destination, bitcoinNetwork);
      return { requestId: a.id, state: 'destination_verified', owner: row.owner, rail: row.rail, destination: a.destination, revision: row.revision };
    }
    // Direct transfer rails have no revocable payout authorization. A timeout
    // cannot demonstrate that an already signed transfer will never settle.
    check(a.type === 'custody-settle', 'financial_custody_revocation_unavailable');
    check(row.state === 'paying' && row.claim === a.claim, 'financial_custody_claim');
    const { fee } = await original(row, at), hint = suppliedHint ?? await payout(a.receipt), domain = fee.financialIdentity.domain;
    check(hint?.claim === row.claim && Number.isSafeInteger(hint.index) && hint.index >= 0 &&
      custodyReceipt(network, domain, hint) === a.receipt, 'financial_custody_receipt');
    let ethereumAnchor;
    if (row.rail === 'tap') {
      check(/^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(hint.reference), 'financial_custody_reference');
      const included = await reads.included(hint.reference, at), content = await reads.content(hint.reference);
      const transfer = (await reads.paymentTransfers(hint.reference)).find(r => r.index === hint.index)?.value;
      check(included?.confirmations >= 1 && content?.p === 'tap' && content.op === 'token-auth' &&
        transfer?.ins === hint.reference && transfer.fail === false && transfer.int === true && transfer.addr === row.custodian &&
        transfer.taddr === row.destination && transfer.tick === fee.ticker && transfer.amt === row.amount && transfer.dta === custodyPaymentData(row.claim) &&
        content.redeem?.items?.some(i => i.address === row.destination && i.tick === fee.ticker &&
          rules.parseTapAmount(i.amt) === row.amount && i.dta === transfer.dta), 'financial_custody_unsettled');
    } else {
      check(ethereumRPC && /^0x[0-9a-f]{64}$/.test(hint.reference) && domain[0] === 'ethereum' &&
        BigInt(await ethereumRPC('eth_chainId')).toString() === domain[1], 'financial_custody_domain');
      const receipt = await ethereumRPC('eth_getTransactionReceipt', [hint.reference]);
      const transaction = await ethereumRPC('eth_getTransactionByHash', [hint.reference]);
      const log = receipt?.logs?.find(l => BigInt(l.logIndex) === BigInt(hint.index));
      const addressTopic = address => '0x' + address.slice(2).padStart(64, '0');
      check(receipt?.status === '0x1' && receipt.transactionHash?.toLowerCase() === hint.reference && log && !log.removed &&
        transaction?.from?.toLowerCase() === row.custodian && transaction.to?.toLowerCase() === domain[2] &&
        transaction.input?.toLowerCase() === custodyEthereumData(row) && transaction.blockHash === receipt.blockHash &&
        log.transactionHash?.toLowerCase() === hint.reference && log.blockHash === receipt.blockHash &&
        log.address?.toLowerCase() === domain[2] && rules.stableJSON(log.topics?.map(t => t.toLowerCase())) ===
          rules.stableJSON([transferTopic, addressTopic(row.custodian), addressTopic(row.destination)]) &&
        /^0x[0-9a-fA-F]{64}$/.test(log.data) && BigInt(log.data).toString() === row.amount &&
        (await ethereumRPC('eth_getBlockByNumber', [receipt.blockNumber, false]))?.hash === receipt.blockHash &&
        BigInt(await ethereumRPC('eth_blockNumber')) >= BigInt(receipt.blockNumber), 'financial_custody_unsettled');
      ethereumAnchor = { chainId: domain[1], height: BigInt(receipt.blockNumber).toString(), hash: receipt.blockHash.toLowerCase() };
    }
    return { requestId: a.id, state: 'paid', claim: row.claim, amount: row.amount, rail: row.rail, custodian: row.custodian,
      destination: row.destination, receipt: a.receipt, confirmations: 1, ...(ethereumAnchor ? { ethereumAnchor } : {}) };
  };
}
