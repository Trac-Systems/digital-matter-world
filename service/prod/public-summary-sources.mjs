import { rules } from '../src/rules.mjs';
import { check } from '../src/util.mjs';
import { calldata } from '../../committee/signer/escrow.mjs';

// Point reads at independently checked source snapshots. No registry walk or
// wallet history is needed to verify a named balance or the token supply.
export function installPublicSummarySources(reads, { ethereum }) {
  const token = async (signature, args) => {
    check(BigInt(await reads.ethRPC('eth_chainId')).toString() === ethereum.chainId, 'public_supply_chain');
    const block = await reads.ethRPC('eth_getBlockByNumber', ['latest', false]);
    check(block?.hash && /^0x[0-9a-f]+$/.test(block.number), 'public_supply_block');
    const value = await reads.ethRPC('eth_call', [{ to: ethereum.token, data: calldata(signature, args) }, block.number]);
    check(typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value), 'public_supply_amount');
    check((await reads.ethRPC('eth_getBlockByNumber', [block.number, false]))?.hash === block.hash, 'public_supply_reorg');
    return { amount: BigInt(value).toString(), anchor: { chainId: ethereum.chainId, token: ethereum.token,
      height: BigInt(block.number).toString(), hash: block.hash } };
  };
  reads.publicTreasuryAccount = async (rail, address) => {
    if (rail === 'ethereum') {
      const fact = await token('balanceOf(address)', [['address', address]]);
      return { rail, address, balance: fact.amount, anchor: fact.anchor };
    }
    check(rail === 'tap', 'public_treasury_rail');
    const before = await reads.batchStamp(), value = await reads.tap('getBalance/' + encodeURIComponent(address) + '/tap');
    check(value === null || typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'public_treasury_amount');
    check(rules.stableJSON(before) === rules.stableJSON(await reads.batchStamp()) &&
      await reads.client.blockHash(before.tip) === before.tipHash, 'public_treasury_snapshot');
    return { rail, address, balance: value ?? '0', anchor: { height: rules.decimalV2(before.tip), hash: before.tipHash, tap: before.tap } };
  };
  reads.publicExternalSupply = async () => {
    const fact = await token('totalSupply()', []); return { ethereum: fact.amount, anchor: fact.anchor };
  };
  return reads;
}
