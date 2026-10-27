import {createRequire} from 'node:module';
import {bitcoinNetwork,bip322Transaction,personalMessageHash} from '../../rules/src/payout-bindings.mjs';
const require=createRequire(new URL('../../rules/package.json',import.meta.url));
const btc=require('@scure/btc-signer');
const {secp256k1,schnorr}=require('@noble/curves/secp256k1');
const {keccak_256}=require('@noble/hashes/sha3');
export function testPayoutAddress(secret, rail, chain = 'regtest') {
  const bytes = Buffer.from(secret, 'hex');
  if (rail === 'tap') return btc.p2tr(schnorr.getPublicKey(bytes), undefined, bitcoinNetwork(chain)).address;
  return '0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(bytes, false).subarray(1))).subarray(12).toString('hex');
}
export function signTestPayout(message, secret, rail, chain = 'regtest') {
  const bytes = Buffer.from(secret, 'hex');
  if (rail === 'ethereum') {
    const signature = secp256k1.sign(personalMessageHash(message), bytes, { lowS: true });
    return '0x' + signature.toCompactHex() + (signature.recovery + 27).toString(16);
  }
  const { sign } = bip322Transaction(message, testPayoutAddress(secret, rail, chain), chain);
  sign.updateInput(0, { tapInternalKey: schnorr.getPublicKey(bytes) });
  sign.signIdx(bytes, 0); sign.finalize();
  return Buffer.from(btc.RawWitness.encode(sign.getInput(0).finalScriptWitness)).toString('base64');
}

// Disposable bindings through the actual public protocol, without loading any
// playground configuration or persistent player wallet.
export async function bindTestPayoutWallets({ wallet, service }) {
  const { randomBytes } = await import('node:crypto');
  const { bindingMessage, verifyBinding } = await import('../../rules/src/payout-bindings.mjs');
  const { wireIdentities } = await import('../../rules/src/trac-address.js');
  if (!service.network.includes('regtest')) throw Error('local_payout_network');
  const result = {};
  for (const rail of ['tap','ethereum']) {
    const key = randomBytes(32).toString('hex'), address = testPayoutAddress(key, rail), now = Date.now();
    const request = { agent: wallet.publicKey, rail, address, nonce: String(now), expiry: now + 3600000 };
    const message = bindingMessage(service.network, 'regtest', request);
    const pending = await service.requestPayoutBinding({ request, agentSignature: await wallet.sign(Buffer.from(message)) });
    const binding = wireIdentities(await service.request('/payout-bindings/complete', { value: { id: pending.id, walletSignature: signTestPayout(message,key,rail) } }));
    verifyBinding(binding, { network: service.network, bitcoinNetwork: 'regtest', members: service.receiptSigners });
    result[rail] = address;
  }
  return result;
}
