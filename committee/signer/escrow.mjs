import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { check, hex } from './crypto.mjs';

export const ZERO_ADDRESS = '0x' + '00'.repeat(20);
export const keccak = bytes => Buffer.from(keccak_256(bytes));
const textHash = text => keccak(Buffer.from(text));
const fields = entries => entries.map(([name, type]) => ({ name, type }));
export const TYPES = {
  EIP712Domain: fields([['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address']]),
  Split: fields([['treasury', 'address'], ['treasuryAmount', 'uint256'], ['finder', 'address'], ['finderAmount', 'uint256'], ['landowner', 'address'], ['landownerAmount', 'uint256'], ['discoverer', 'address'], ['discovererAmount', 'uint256'], ['burnAmount', 'uint256']]),
  Release: fields([['requestId', 'bytes32'], ['payer', 'address'], ['amount', 'uint256'], ['splitHash', 'bytes32'], ['expiry', 'uint256'], ['committeeEpoch', 'uint256']]),
  RotateCommittee: fields([['newCommittee', 'address'], ['nonce', 'uint256'], ['committeeEpoch', 'uint256'], ['deadline', 'uint256']]),
};
export function uint256(value) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < 1n << 256n, 'uint256'); return value;
}
export function ethAddress(value) {
  check(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), 'ethereum_address'); return value.toLowerCase();
}
export function bytes32(value) {
  check(typeof value === 'string' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(value), 'bytes32'); return '0x' + value.replace(/^0x/, '').toLowerCase();
}
export function abiWord(type, value) {
  if (type === 'string') return textHash(value);
  if (type === 'uint256') return Buffer.from(BigInt(uint256(value)).toString(16).padStart(64, '0'), 'hex');
  if (type === 'address') return Buffer.from(ethAddress(value).slice(2).padStart(64, '0'), 'hex');
  if (type === 'bytes32') return Buffer.from(bytes32(value).slice(2), 'hex');
  throw Error('abi_type');
}
export function calldata(signature, args = []) {
  return '0x' + hex(textHash(signature).subarray(0, 4)) + args.map(([type, value]) => hex(abiWord(type, value))).join('');
}
function hashStruct(type, message) {
  const declaration = `${type}(${TYPES[type].map(f => `${f.type} ${f.name}`).join(',')})`;
  return keccak(Buffer.concat([textHash(declaration), ...TYPES[type].map(f => abiWord(f.type, message[f.name]))]));
}
export function normalizeSplit(split) {
  check(split && Object.keys(split).length === TYPES.Split.length, 'escrow_split_fields');
  return Object.fromEntries(TYPES.Split.map(({ name, type }) => [name, type === 'address' ? ethAddress(split[name]) : uint256(split[name])]));
}
export const hashSplit = split => '0x' + hex(hashStruct('Split', normalizeSplit(split)));
function typed(escrow, primaryType, message) {
  const domain = { name: 'DmwEscrow', version: '1', chainId: uint256(escrow.chainId), verifyingContract: ethAddress(escrow.address) };
  const digest = hex(keccak(Buffer.concat([Buffer.from([0x19, 0x01]), hashStruct('EIP712Domain', domain), hashStruct(primaryType, message)])));
  return { digest, typedData: { domain, primaryType, types: { EIP712Domain: TYPES.EIP712Domain, [primaryType]: TYPES[primaryType] }, message } };
}
export function escrowRelease(escrow, requestId, deposit, committeeEpoch) {
  check(hashSplit(deposit.split) === bytes32(deposit.splitHash), 'escrow_split_hash');
  return typed(escrow, 'Release', { requestId: bytes32(requestId), payer: ethAddress(deposit.payer), amount: uint256(deposit.amount), splitHash: bytes32(deposit.splitHash), expiry: uint256(deposit.expiry), committeeEpoch: uint256(committeeEpoch) });
}
export function escrowRotation(escrow, newCommittee, nonce, committeeEpoch, deadline) {
  return typed(escrow, 'RotateCommittee', { newCommittee: ethAddress(newCommittee), nonce: uint256(nonce), committeeEpoch: uint256(committeeEpoch), deadline: uint256(deadline) });
}
export function committeeAddress(publicKey) {
  return '0x' + hex(keccak(secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false).subarray(1)).subarray(12));
}
export function ethereumSignature(signature) {
  const order = secp256k1.CURVE.n, r = BigInt(signature.r); let s = BigInt(signature.s), v = signature.v;
  check(r > 0n && r < order && s > 0n && s < order && (v === 0 || v === 1), 'ethereum_signature');
  if (s > order / 2n) { s = order - s; v ^= 1; }
  return '0x' + r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0') + (v + 27).toString(16);
}
export function expectedEscrowSplit(fees, destinations, compound = false, payer = null) {
  const recipient = (amount, address) => amount === '0' ? ZERO_ADDRESS : ethAddress(address);
  const split = {};
  for (const role of ['treasury', 'finder', 'landowner', 'discoverer']) {
    const source = role === 'finder' && compound ? 'firstMaker' : role;
    const amount = payer && destinations[source]?.toLowerCase() === payer.toLowerCase() ? '0' : fees[source];
    split[role + 'Amount'] = amount;
    split[role] = recipient(amount, destinations[source]);
  }
  return normalizeSplit({ ...split, burnAmount: fees.burn });
}
export function escrowSplitForItems(items) {
  const split = Object.fromEntries(TYPES.Split.map(({ name, type }) => [name, type === 'address' ? ZERO_ADDRESS : '0']));
  for (const item of items) {
    const role = item.role === 'firstMaker' ? 'finder' : item.role;
    check(Object.hasOwn(split, role + 'Amount') && split[role + 'Amount'] === '0', 'escrow_fee_role');
    split[role + 'Amount'] = uint256(item.amount);
    if (role !== 'burn') split[role] = ethAddress(item.to);
  }
  return normalizeSplit(split);
}
