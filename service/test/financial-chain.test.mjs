import test from 'node:test';
import assert from 'node:assert/strict';
import { installFinancialChain } from '../src/financial-chain.mjs';
import { rules as r } from '../src/rules.mjs';

test('accepted chain checkpoints reject Bitcoin and Ethereum forks before dependent spending', async () => {
  const height = '1' + '0'.repeat(79), at = { tip: height, tipHash: r.hash('tip') }, oldHeight = (BigInt(height) - 1n).toString();
  const prior = { bitcoin: { height: oldHeight, hash: r.hash('old') }, ethereum: { chainId: '1', height: '10', hash: '0x' + r.hash('eth') } };
  let forkBitcoin = false, forkEthereum = false;
  const reads = installFinancialChain({}, { bitcoinHash: async h => h === height ? at.tipHash : r.hash(forkBitcoin ? 'fork' : 'old'),
    ethereumRPC: async method => method === 'eth_chainId' ? '0x1' : method === 'eth_blockNumber' ? '0xb' : { hash: '0x' + r.hash(forkEthereum ? 'fork' : 'eth') } });
  assert.deepEqual(await reads.financialChainAnchor({ at, prior }), { bitcoin: { height, hash: at.tipHash }, ethereum: prior.ethereum });
  forkBitcoin = true; await assert.rejects(reads.financialChainAnchor({ at, prior }), /financial_chain_recovery_required/);
  forkBitcoin = false; forkEthereum = true; await assert.rejects(reads.financialChainAnchor({ at, prior }), /financial_chain_recovery_required/);
});

test('a retained notary fork cannot replace independent canonical chain evidence', async () => {
  const at = { tip: '12', tipHash: r.hash('retained-tip') }, prior = { bitcoin: { height: '10', hash: r.hash('retained-old') }, ethereum: null };
  let fork = false;
  const reads = installFinancialChain({}, { bitcoinHash: async h => h === '12' ? at.tipHash : prior.bitcoin.hash,
    canonicalBitcoinHash: async h => fork ? r.hash('canonical-replacement') : h === '12' ? at.tipHash : prior.bitcoin.hash });
  await reads.financialChainAnchor({ at, prior });
  fork = true;
  await assert.rejects(reads.financialChainAnchor({ at, prior }), /financial_chain_recovery_required/);
});
