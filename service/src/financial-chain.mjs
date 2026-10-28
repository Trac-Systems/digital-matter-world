import { rules } from './rules.mjs';
import { check } from './util.mjs';

// One accepted high-water anchor per external chain covers every earlier
// settlement in that chain's prefix. Check ancestry before extending it. A
// fork requires financial reconciliation; a fresh tip cannot erase the old
// anchor or silently make orphaned credits spendable.
export function installFinancialChain(reads, { bitcoinHash, canonicalBitcoinHash, ethereumRPC }) {
  reads.financialRecoveryAnchor = async (at, supplied) => {
    const prior = await reads.financialRecord('fp/chain', at), adopted = await reads.financialRecord('b/recovery', at);
    check(adopted?.tip && rules.hex(adopted.tip.hash, 32), 'financial_recovery_unadopted');
    const bitcoin = { height: rules.decimalV2(adopted.tip.height), hash: adopted.tip.hash };
    let ethereum = null;
    if (prior?.ethereum) {
      check(ethereumRPC && prior.ethereum.chainId === BigInt(await ethereumRPC('eth_chainId')).toString(), 'financial_chain_domain');
      const height = supplied?.ethereum?.height ?? BigInt(await ethereumRPC('eth_blockNumber')).toString();
      check(BigInt(height) >= BigInt(prior.ethereum.height), 'financial_recovery_chain_behind');
      const block = await ethereumRPC('eth_getBlockByNumber', ['0x' + BigInt(height).toString(16), false]);
      check(block?.hash, 'financial_chain_snapshot');
      ethereum = { chainId: prior.ethereum.chainId, height, hash: block.hash.toLowerCase() };
    }
    const anchor = { bitcoin, ethereum };
    // Finish the adoption already accepted by the notary, even if another
    // fork/extension arrives before cleanup. Ordinary spending separately
    // requires best-chain membership; an orphaned adoption needs a new recovery.
    check(!supplied || rules.stableJSON(supplied) === rules.stableJSON(anchor), 'financial_recovery_anchor');
    return anchor;
  };
  if (canonicalBitcoinHash) reads.financialAnchorCanonical = async anchor => {
    if (await canonicalBitcoinHash(anchor.bitcoin.height) !== anchor.bitcoin.hash) return false;
    if (anchor.ethereum) {
      check(ethereumRPC && anchor.ethereum.chainId === BigInt(await ethereumRPC('eth_chainId')).toString(), 'financial_chain_domain');
      if ((await ethereumRPC('eth_getBlockByNumber', ['0x' + BigInt(anchor.ethereum.height).toString(16), false]))?.hash?.toLowerCase() !== anchor.ethereum.hash) return false;
    }
    return true;
  };
  reads.financialChainAnchor = async ({ at, prior, ethereum = null }) => {
    if (prior?.bitcoin) check(await bitcoinHash(prior.bitcoin.height, at) === prior.bitcoin.hash, 'financial_chain_recovery_required');
    const bitcoin = { height: rules.decimalV2(at.tip), hash: at.tipHash };
    check(await bitcoinHash(bitcoin.height, at) === bitcoin.hash, 'financial_chain_snapshot');
    // A valid retained fork view is not proof that the independent source
    // still considers it canonical. Check its best-chain membership too.
    if (canonicalBitcoinHash) check(await canonicalBitcoinHash(bitcoin.height) === bitcoin.hash &&
      (!prior?.bitcoin || await canonicalBitcoinHash(prior.bitcoin.height) === prior.bitcoin.hash), 'financial_chain_recovery_required');
    const verifyEthereum = async anchor => {
      check(ethereumRPC && anchor.chainId === BigInt(await ethereumRPC('eth_chainId')).toString() &&
        (await ethereumRPC('eth_getBlockByNumber', ['0x' + BigInt(anchor.height).toString(16), false]))?.hash?.toLowerCase() === anchor.hash &&
        BigInt(await ethereumRPC('eth_blockNumber')) >= BigInt(anchor.height), 'financial_chain_recovery_required');
    };
    if (prior?.ethereum) await verifyEthereum(prior.ethereum);
    if (ethereum) await verifyEthereum(ethereum);
    const selected = !ethereum || prior?.ethereum && BigInt(prior.ethereum.height) > BigInt(ethereum.height) ? prior?.ethereum ?? null : ethereum;
    return { bitcoin, ethereum: selected };
  };
  return reads;
}
