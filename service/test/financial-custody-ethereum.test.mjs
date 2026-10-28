import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '../../contract/node_modules/@noble/hashes/sha3.js';
import { installCustodySources, custodyReceipt, custodyEthereumData } from '../src/financial-custody-sources.mjs';
import { installFinancialChain } from '../src/financial-chain.mjs';
import { identifyFinancialFees, financialFeeKey } from '../src/financial-fee-identity.mjs';
import { rules as r } from '../src/rules.mjs';

test('native Ethereum custody verifies token, chain, canonical log, sender, amount and claim-bound calldata', async () => {
  const network = 'dmw-regtest', id = r.hash('liability'), request = r.hash('request'), claim = r.hash('claim'), owner = r.hash('owner');
  const custodian = '0x' + 'a'.repeat(40), destination = '0x' + 'b'.repeat(40), token = '0x' + 'c'.repeat(40), blockHash = '0x' + r.hash('ethereum-block');
  const [fee] = identifyFinancialFees([{ role: 'firstMaker', to: custodian, amount: '10', ticker: 'tap', tt: 'a', dta: request }],
    { network, rail: 'ethereum', escrow: { chainId: '31337', token }, custody: [{ role: 'firstMaker', owner }] });
  const row = { request, owner, rail: 'ethereum', custodian, amount: '10', destination, claim, state: 'paying', fee: financialFeeKey(fee) };
  const hint = { claim, reference: '0x' + r.hash('transaction'), index: 0 }, at = { tip: '100', tipHash: r.hash('bitcoin') };
  const funding = { state: 'consumed' }, source = { rail: 'ethereum', feeItems: [fee] };
  const log = { logIndex: '0x0', transactionHash: hint.reference, blockHash, address: token, data: '0x' + 'a'.padStart(64, '0'), topics:
    ['0x' + Buffer.from(keccak_256(Buffer.from('Transfer(address,address,uint256)'))).toString('hex'), '0x' + custodian.slice(2).padStart(64, '0'), '0x' + destination.slice(2).padStart(64, '0')] };
  const receipt = { status: '0x1', transactionHash: hint.reference, blockHash, blockNumber: '0xa', logs: [log] };
  const transaction = { from: custodian, to: token, input: custodyEthereumData(row), blockHash };
  let canonical = blockHash, chainId = '0x7a69';
  const rpc = async method => ({ eth_chainId: chainId, eth_getTransactionReceipt: receipt, eth_getTransactionByHash: transaction,
    eth_getBlockByNumber: { hash: canonical }, eth_blockNumber: '0xa' })[method];
  const reads = { financialRecord: async key => key === 'bc/' + id ? row : key === 'fp/chain' ? { bitcoin: { height: '100', hash: at.tipHash }, ethereum: null } : null };
  installFinancialChain(reads, { bitcoinHash: async () => at.tipHash, ethereumRPC: rpc });
  installCustodySources(reads, { network, bitcoinNetwork: 'regtest', ethereumRPC: rpc, accepted: async () => ({ source, funding }), payout: async () => hint });
  const action = { type: 'custody-settle', id, claim, receipt: custodyReceipt(network, fee.financialIdentity.domain, hint) };
  assert.equal((await reads.financialCustodyEvidence(action, at)).state, 'paid');
  for (const [target, key, value] of [[transaction, 'input', transaction.input.slice(0, -64)], [transaction, 'from', destination],
    [log, 'address', destination], [log, 'data', '0x' + 'b'.padStart(64, '0')], [receipt, 'status', '0x0']]) {
    const old = target[key]; target[key] = value;
    await assert.rejects(reads.financialCustodyEvidence(action, at), /financial_custody_unsettled/); target[key] = old;
  }
  canonical = '0x' + r.hash('fork'); await assert.rejects(reads.financialCustodyEvidence(action, at), /financial_custody_unsettled/);
  canonical = blockHash; chainId = '0x1'; await assert.rejects(reads.financialCustodyEvidence(action, at), /financial_custody_domain/);
});
