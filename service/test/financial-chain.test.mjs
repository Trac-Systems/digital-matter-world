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

async function forkFixture({ depth = 1, limit = 6, safe = true } = {}) {
  const parentHeight = 10, tip = String(parentHeight + depth), canonical = h => r.hash('canonical/' + h);
  const at = { tip, tipHash: canonical(tip) }, headers = new Map();
  let parent = canonical(parentHeight);
  for (let n = 1; n <= depth; n++) {
    const height = String(parentHeight + n), hash = r.hash('losing/' + height);
    headers.set(hash, { height, hash, parent }); parent = hash;
  }
  const prior = { bitcoin: { height: tip, hash: parent }, ethereum: null };
  let headerReads = 0, proofReads = 0;
  const reads = installFinancialChain({}, { bitcoinHash: async h => canonical(h), canonicalBitcoinHash: async h => canonical(h),
    bitcoinHeader: async hash => { headerReads++; return headers.get(hash); }, settings: { shallowReorgLimit: limit },
    rebaseSafe: async ({ fork, losing }) => { proofReads++; assert.equal(fork.height, '10'); assert.equal(losing.length, depth); return safe; } });
  return { reads, at, prior, counts: () => ({ headerReads, proofReads }) };
}

test('a bounded shallow fork replaces only a proven money-free anchor', async () => {
  const f = await forkFixture();
  assert.deepEqual(await f.reads.financialChainAnchor(f), { bitcoin: { height: f.at.tip, hash: f.at.tipHash }, ethereum: null });
  assert.deepEqual(f.counts(), { headerReads: 1, proofReads: 1 });
  const unsafe = await forkFixture({ safe: false });
  await assert.rejects(unsafe.reads.financialChainAnchor(unsafe), /financial_chain_recovery_required/);
});

test('the shallow limit includes its boundary and never reads more losing headers', async () => {
  for (const [depth, limit, accepted] of [[6, 6, true], [7, 6, false], [1, 0, false], [2, 1, false]]) {
    const f = await forkFixture({ depth, limit });
    if (accepted) await f.reads.financialChainAnchor(f);
    else await assert.rejects(f.reads.financialChainAnchor(f), /financial_chain_recovery_required/);
    assert.ok(f.counts().headerReads <= limit);
    assert.equal(f.counts().proofReads, accepted ? 1 : 0);
  }
});

test('missing headers, unavailable provenance and a noncanonical current stamp stay fenced', async () => {
  const common = r.hash('common'), losing = r.hash('losing'), winner = r.hash('winner');
  const at = { tip: '11', tipHash: winner }, prior = { bitcoin: { height: '11', hash: losing }, ethereum: null };
  const base = { bitcoinHash: async h => h === '10' ? common : winner, canonicalBitcoinHash: async h => h === '10' ? common : winner,
    bitcoinHeader: async () => ({ height: '11', hash: losing, parent: common }), rebaseSafe: async () => true };
  for (const override of [{ bitcoinHeader: async () => null }, { bitcoinHeader: async () => ({ height: '12', hash: losing, parent: common }) },
    { rebaseSafe: undefined }, { rebaseSafe: async () => { throw Error('accepted_audit_root'); } },
    { canonicalBitcoinHash: async h => h === '10' ? common : losing, bitcoinHash: async h => h === '10' ? common : winner },
    { canonicalBitcoinHash: async () => r.hash('another-fork') }]) {
    const reads = installFinancialChain({}, { ...base, ...override });
    await assert.rejects(reads.financialChainAnchor({ at, prior }), /financial_chain_recovery_required/);
  }
  let tipReads = 0;
  const reads = installFinancialChain({}, { ...base, canonicalBitcoinHash: async h => h === '10' ? common : ++tipReads < 3 ? winner : r.hash('new-tip') });
  await assert.rejects(reads.financialChainAnchor({ at, prior }), /financial_chain_recovery_required/);
});

test('an inconsistent retained view is not a shallow reorg of a canonical prior', async () => {
  const prior = { bitcoin: { height: '11', hash: r.hash('canonical-prior') }, ethereum: null };
  const at = { tip: '12', tipHash: r.hash('canonical-tip') };
  const reads = installFinancialChain({}, {
    bitcoinHash: async h => h === '12' ? at.tipHash : r.hash('inconsistent-view'),
    canonicalBitcoinHash: async h => h === '12' ? at.tipHash : prior.bitcoin.hash,
    bitcoinHeader: () => assert.fail('a canonical prior must not enter the losing-header walk'),
    rebaseSafe: () => assert.fail('inconsistent view must not rebase')
  });
  await assert.rejects(reads.financialChainAnchor({ at, prior }), /financial_chain_recovery_required/);
});

test('a stale current stamp preserves the recovery error for an orphaned prior', async () => {
  const prior = { bitcoin: { height: '11', hash: r.hash('losing-prior') }, ethereum: null };
  const at = { tip: '12', tipHash: r.hash('stale-tip') };
  const reads = installFinancialChain({}, { bitcoinHash: async h => r.hash('canonical/' + h),
    bitcoinHeader: () => assert.fail('an invalid current stamp cannot enter rebase'),
    rebaseSafe: () => assert.fail('an invalid current stamp cannot prove rebase') });
  await assert.rejects(reads.financialChainAnchor({ at, prior }), /financial_chain_recovery_required/);
  await assert.rejects(reads.financialChainAnchor({ at, prior: null }), /financial_chain_snapshot/);
});
