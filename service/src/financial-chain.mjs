import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { financialChainSettings } from './financial-chain-policy.mjs';

// One accepted high-water anchor per external chain covers every earlier
// settlement in that chain's prefix. Check ancestry before extending it.
// A shallow fork can rebase only with complete, money-free accepted provenance;
// a fresh tip alone cannot erase the old anchor or orphaned credits.
export function installFinancialChain(reads, { bitcoinHash, canonicalBitcoinHash, bitcoinHeader, rebaseSafe, settings, ethereumRPC }) {
  const policy = financialChainSettings(settings);
  const shallowRebase = async (prior, at) => {
    check(canonicalBitcoinHash && bitcoinHeader && rebaseSafe && policy.shallowReorgLimit > 0 &&
      BigInt(prior.bitcoin.height) <= BigInt(at.tip), 'financial_chain_recovery_required');
    const losing = []; let cursor = prior.bitcoin;
    // Read only the losing headers. The final parent is checked by hash, so a
    // fork exactly at the limit does not cost one extra losing-branch read.
    for (let depth = 0; depth < policy.shallowReorgLimit && BigInt(cursor.height) > 0n; depth++) {
      const header = await bitcoinHeader(cursor.hash);
      check(header && header.hash === cursor.hash && String(header.height) === cursor.height && rules.hex(header.parent, 32), 'financial_chain_recovery_required');
      losing.push(cursor);
      cursor = { height: String(BigInt(cursor.height) - 1n), hash: header.parent };
      if (await canonicalBitcoinHash(cursor.height) === cursor.hash) {
        check(await bitcoinHash(cursor.height, at) === cursor.hash &&
          await rebaseSafe({ prior, at, fork: cursor, losing, limit: policy.shallowReorgLimit }), 'financial_chain_recovery_required');
        return;
      }
    }
    throw Error('financial_chain_recovery_required');
  };
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
    let priorCanonical = !prior?.bitcoin || await bitcoinHash(prior.bitcoin.height, at) === prior.bitcoin.hash;
    let priorOnSource = priorCanonical;
    const bitcoin = { height: rules.decimalV2(at.tip), hash: at.tipHash };
    check(await bitcoinHash(bitcoin.height, at) === bitcoin.hash,
      priorCanonical ? 'financial_chain_snapshot' : 'financial_chain_recovery_required');
    // A valid retained fork view is not proof that the independent source
    // still considers it canonical. Check its best-chain membership too.
    if (canonicalBitcoinHash) {
      check(await canonicalBitcoinHash(bitcoin.height) === bitcoin.hash, 'financial_chain_recovery_required');
      if (prior?.bitcoin) {
        priorOnSource = await canonicalBitcoinHash(prior.bitcoin.height) === prior.bitcoin.hash;
        priorCanonical = priorOnSource && priorCanonical;
      }
    }
    if (!priorCanonical) {
      try {
        check(!priorOnSource, 'financial_chain_recovery_required');
        await shallowRebase(prior, at);
        check(await canonicalBitcoinHash(bitcoin.height) === bitcoin.hash, 'financial_chain_recovery_required');
      }
      catch { throw Error('financial_chain_recovery_required'); }
    }
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
