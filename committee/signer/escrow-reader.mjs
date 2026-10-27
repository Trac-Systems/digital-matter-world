import { check, equal, hex } from './crypto.mjs';
import { TYPES, abiWord, calldata, ethAddress, bytes32, hashSplit, keccak, escrowRelease, escrowRotation } from './escrow.mjs';

function words(encoded, length) {
  check(typeof encoded === 'string' && /^0x[0-9a-fA-F]*$/.test(encoded) && encoded.length === 2 + 64 * length, 'escrow_abi');
  return encoded.slice(2).match(/.{64}/g);
}
const number = word => BigInt('0x' + word).toString();
const address = word => { check(/^0{24}/.test(word), 'escrow_abi_address'); return ethAddress('0x' + word.slice(24)); };
const splitAt = values => Object.fromEntries(TYPES.Split.map(({ name, type }, i) => [name, type === 'address' ? address(values[i]) : number(values[i])]));
const DEPOSITED = '0x' + hex(keccak(Buffer.from(`Deposited(bytes32,address,uint256,uint256,bytes32,(${TYPES.Split.map(f => f.type).join(',')}))`)));

// The operator supplies the RPC transport and deployment, never the requester.
// Every getter/log read is pinned to one canonical block and checked again after
// the read. A trusted RPC and its chain-finality policy remain required.
export function createEscrowReader({ rpc, chainId, address: contract, token, fromBlock = '0x0' }) {
  const escrow = { chainId, address: ethAddress(contract), token: ethAddress(token) };
  async function snapshot(read) {
    check(BigInt(await rpc('eth_chainId', [])).toString() === chainId, 'escrow_chain');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    check(block?.hash && block.number && block.timestamp, 'escrow_block');
    const call = async (signature, args = []) => rpc('eth_call', [{ to: escrow.address, data: calldata(signature, args) }, block.number]);
    const [tokenWord, committeeWord, epochWord, nonceWord, proposalWord] = await Promise.all(['token()', 'committee()', 'committeeEpoch()', 'rotationNonce()', 'pendingCommittee()'].map(s => call(s)));
    check(address(words(tokenWord, 1)[0]) === escrow.token, 'escrow_token');
    const proposal = words(proposalWord, 4), origin = number(proposal[3]);
    check(origin === '0' || origin === '1', 'escrow_abi_origin');
    const pendingCommittee = { successor: address(proposal[0]), executableAt: number(proposal[1]), nonce: number(proposal[2]), adminOrigin: origin === '1' };
    const state = { ...escrow, blockNumber: block.number, blockHash: block.hash, timestamp: BigInt(block.timestamp).toString(), committee: address(words(committeeWord, 1)[0]), committeeEpoch: number(words(epochWord, 1)[0]), rotationNonce: number(words(nonceWord, 1)[0]), pendingCommittee };
    const result = await read(state, call);
    check((await rpc('eth_getBlockByNumber', [block.number, false]))?.hash === block.hash, 'escrow_reorg');
    return { ...state, ...result };
  }
  return {
    deposit: (payer, requestId) => snapshot(async (state, call) => {
      payer = ethAddress(payer);
      const id = bytes32(requestId), args = [['address', payer], ['bytes32', id]], w = words(await call('getDeposit(address,bytes32)', args), 5 + TYPES.Split.length);
      const deposit = { payer: address(w[0]), status: Number(BigInt('0x' + w[1])), amount: number(w[2]), expiry: number(w[3]), splitHash: bytes32(w[4]), split: splitAt(w.slice(5)) };
      check(deposit.payer === payer, 'escrow_payer');
      check(hashSplit(deposit.split) === deposit.splitHash, 'escrow_split_hash');
      const payerTopic = '0x' + hex(abiWord('address', payer));
      const logs = await rpc('eth_getLogs', [{ address: escrow.address, fromBlock, toBlock: state.blockNumber, topics: [DEPOSITED, id, payerTopic] }]);
      check(Array.isArray(logs) && logs.length === 1, 'escrow_deposit_event');
      const log = logs[0], data = words(log.data, 3 + TYPES.Split.length);
      check(log.removed === false && ethAddress(log.address) === escrow.address && log.topics.length === 3 && log.topics[0].toLowerCase() === DEPOSITED && log.topics[1].toLowerCase() === id, 'escrow_deposit_event');
      check(equal({ payer: address(words(log.topics[2], 1)[0]), amount: number(data[0]), expiry: number(data[1]), splitHash: bytes32(data[2]), split: splitAt(data.slice(3)) }, { payer: deposit.payer, amount: deposit.amount, expiry: deposit.expiry, splitHash: deposit.splitHash, split: deposit.split }), 'escrow_event_mismatch');
      check((await rpc('eth_getBlockByNumber', [log.blockNumber, false]))?.hash === log.blockHash, 'escrow_event_reorg');
      const confirmations = Number(BigInt(state.blockNumber) - BigInt(log.blockNumber) + 1n);
      check(Number.isSafeInteger(confirmations) && confirmations > 0, 'escrow_confirmations');
      const releaseDigest = bytes32(await call('releaseDigest(address,bytes32)', args)).slice(2);
      check(escrowRelease(escrow, id, deposit, state.committeeEpoch).digest === releaseDigest, 'escrow_release_digest');
      return { payer, requestId: id.slice(2), deposit, confirmations, releaseDigest };
    }),
    rotation: (newCommittee, deadline) => snapshot(async (state, call) => {
      const rotationDigest = bytes32(await call('rotationDigest(address,uint256)', [['address', newCommittee], ['uint256', deadline]])).slice(2);
      check(escrowRotation(escrow, newCommittee, state.rotationNonce, state.committeeEpoch, deadline).digest === rotationDigest, 'escrow_rotation_digest');
      return { rotationDigest };
    }),
  };
}
