import { encodeTracAddress } from './trac-address.js';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import * as btc from '@scure/btc-signer';
import { assert, exactKeys, hex, integer, stableJSON, networkId, hash, hashBytes, utf8 } from './core.js';

export const BINDING_DOMAIN = 'dmw-payout-binding-v1';
export const bindingKey = (agent, rail) => `${agent}/${rail}`;
export const bitcoinNetwork = name => {
  assert(['mainnet', 'regtest'].includes(name), 'binding_network');
  return name === 'regtest' ? { ...btc.TEST_NETWORK, bech32: 'bcrt' } : btc.NETWORK;
};
export function payoutAddress(rail, address, chain) {
  assert(typeof address === 'string' && address.length <= 90, 'binding_address');
  if (rail === 'ethereum') {
    assert(/^0x[0-9a-f]{40}$/.test(address) && !/^0x0{40}$/.test(address), 'binding_address');
  } else {
    assert(rail === 'tap' && ['mainnet', 'regtest'].includes(chain) && address === address.toLowerCase(), 'binding_address');
    const decoded = btc.Address(bitcoinNetwork(chain)).decode(address);
    assert(decoded.type === 'tr', 'binding_taproot_required');
  }
  return address;
}
export function bindingMessage(network, chain, request) {
  networkId(network);
  assert(['mainnet', 'regtest'].includes(chain) && exactKeys(request, ['agent', 'rail', 'address', 'nonce', 'expiry']) && hex(request.agent, 32) &&
    typeof request.nonce === 'string' && /^[1-9][0-9]{0,19}$/.test(request.nonce) && integer(request.expiry) && request.expiry > 0, 'binding_request');
  payoutAddress(request.rail, request.address, chain);
  return `${BINDING_DOMAIN}\n${stableJSON({ network, bitcoinNetwork: chain, ...request, agent: encodeTracAddress(request.agent) })}`;
}
export const bindingId = (network, chain, request) => hash(bindingMessage(network, chain, request));
export function verifyAgentBinding(envelope, { network, bitcoinNetwork: chain, now = Date.now(), historical = false }) {
  const message = bindingMessage(network, chain, envelope.request);
  assert(hex(envelope.agentSignature, 64) && ed25519.verify(envelope.agentSignature, utf8(message), envelope.request.agent, { zip215: false }), 'binding_agent_signature');
  assert(historical || envelope.request.expiry > now && envelope.request.expiry <= now + 86400000, 'binding_expired');
  return message;
}
export function personalMessageHash(message) {
  const bytes = utf8(message);
  return keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes]));
}
// Only the BIP-322 simple Taproot key path is accepted: one Schnorr signature,
// DEFAULT or ALL, with no annex, script path, timelocks or extra inputs.
export function bip322Transaction(message, address, chain) {
  const decoded = btc.Address(bitcoinNetwork(chain)).decode(address);
  assert(decoded.type === 'tr', 'binding_taproot_required');
  const script = btc.OutScript.encode(decoded), tag = hashBytes('BIP0322-signed-message');
  const messageHash = hashBytes(Buffer.concat([tag, tag, utf8(message)]));
  const options = { version: 0, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true };
  const spend = new btc.Transaction(options);
  spend.addOutput({ amount: 0n, script });
  spend.addInput({ txid: '00'.repeat(32), index: 0xffffffff, sequence: 0, finalScriptSig: Buffer.concat([Buffer.from([0, 32]), messageHash]) });
  const sign = new btc.Transaction(options);
  sign.addInput({ txid: spend.id, index: 0, sequence: 0, witnessUtxo: { amount: 0n, script } });
  sign.addOutput({ amount: 0n, script: Buffer.from([0x6a]) });
  return { sign, script, pubkey: decoded.pubkey };
}
export function verifyBip322Simple(message, address, signature, chain) {
  assert(typeof signature === 'string' && signature.length <= 96, 'binding_wallet_signature');
  const encoded = signature.startsWith('smp') ? signature.slice(3) : signature;
  const bytes = Buffer.from(encoded, 'base64');
  assert(bytes.toString('base64') === encoded && [66, 67].includes(bytes.length) && bytes[0] === 1 && bytes[1] === bytes.length - 2, 'binding_wallet_signature');
  const sig = bytes.subarray(2), hashType = sig.length === 64 ? 0 : sig[64];
  assert(sig.length === 64 || hashType === 1, 'binding_wallet_signature');
  const { sign, script, pubkey } = bip322Transaction(message, address, chain);
  assert(schnorr.verify(sig.subarray(0, 64), sign.preimageWitnessV1(0, [script], hashType, [0n]), pubkey), 'binding_wallet_signature');
  return true;
}
export function verifyWalletBinding(envelope, options) {
  const message = verifyAgentBinding(envelope, options), { request: r, walletSignature: signature } = envelope;
  assert(typeof signature === 'string' && signature.length <= 512, 'binding_wallet_signature');
  try {
    if (r.rail === 'ethereum') {
      assert(/^0x[0-9a-fA-F]{130}$/.test(signature), 'signature');
      const bytes = Buffer.from(signature.slice(2), 'hex'), v = bytes[64];
      assert([0, 1, 27, 28].includes(v), 'signature');
      const s = secp256k1.Signature.fromCompact(bytes.subarray(0, 64));
      assert(!s.hasHighS(), 'signature');
      const pub = s.addRecoveryBit(v >= 27 ? v - 27 : v).recoverPublicKey(personalMessageHash(message)).toRawBytes(false);
      assert('0x' + Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString('hex') === r.address, 'signature');
    } else {
      verifyBip322Simple(message, r.address, signature, options.bitcoinNetwork);
    }
  } catch { throw Error('binding_wallet_signature'); }
  return hash(message);
}
const certificateBody = (network, chain, record) => ({ domain: 'dmw-payout-acceptance-v1', network, bitcoinNetwork: chain,
  id: record.id, request: record.request, agentSignature: record.agentSignature, walletSignature: record.walletSignature, acceptedAt: record.acceptedAt });
export function attestBinding(record, { network, bitcoinNetwork: chain, signer, secret }) {
  return { signer, sig: Buffer.from(ed25519.sign(utf8(stableJSON(certificateBody(network, chain, record))), Buffer.from(secret, 'hex'))).toString('hex') };
}
export function verifyBindingAttestation(record, vote, { network, bitcoinNetwork: chain, members }) {
  try {
    const member = members.find(m => m.id === vote.signer);
    return !!member && hex(vote.sig, 64) && ed25519.verify(vote.sig, utf8(stableJSON(certificateBody(network, chain, record))), member.identity, { zip215: false });
  } catch { return false; }
}
export function verifyBinding(record, options) {
  if (options.rosterHistory?.length) {
    let last;
    for (const members of [options.members, ...options.rosterHistory.map(r => r.members)]) {
      try { return verifyBinding(record, { ...options, members, rosterHistory: undefined }); } catch (e) { last = e; }
    }
    throw last;
  }
  const { members } = options;
  assert(record && integer(record.acceptedAt) && record.acceptedAt < record.request.expiry, 'binding_certificate');
  assert(record.id === verifyWalletBinding(record, { ...options, historical: true }), 'binding_id');
  assert(Array.isArray(members) && members.length === 5 && new Set(members.map(m => m.id)).size === 5 && new Set(members.map(m => m.identity)).size === 5, 'binding_roster');
  const a = record.attestations;
  assert(Array.isArray(a) && a.length >= 3 && a.length <= 5 && new Set(a.map(v => v.signer)).size === a.length, 'binding_quorum');
  for (const vote of a) assert(verifyBindingAttestation(record, vote, options), 'binding_attestation');
  return record;
}
