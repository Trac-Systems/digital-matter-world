import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { bindingMessage, bitcoinNetwork, verifyTapMessage, verifyWalletBinding, verifyBip322Simple } from '../src/payout-bindings.mjs';
import { signTapWalletMessage } from './tap-wallet-signing.mjs';

for (const chain of ['mainnet', 'regtest']) for (const parity of [2, 3]) {
  test(`TAP Wallet legacy binding: ${chain}, internal key parity ${parity}`, () => {
    let key;
    do { key = secp256k1.utils.randomPrivateKey(); } while (secp256k1.getPublicKey(key)[0] !== parity);
    const agentKey = ed25519.utils.randomPrivateKey(), network = 'dmw-wallet-test';
    const address = btc.p2tr(schnorr.getPublicKey(key), undefined, bitcoinNetwork(chain)).address;
    const request = { agent: Buffer.from(ed25519.getPublicKey(agentKey)).toString('hex'), rail: 'tap', address, nonce: '1', expiry: Date.now() + 3600000 };
    const message = bindingMessage(network, chain, request);
    assert.ok(Buffer.byteLength(message) > 252, 'real binding message exercises CompactSize, not a one-byte length');
    const packet = { request, agentSignature: Buffer.from(ed25519.sign(Buffer.from(message), agentKey)).toString('hex'), walletSignature: signTapWalletMessage(message, key) };
    const options = { network, bitcoinNetwork: chain };
    assert.ok(verifyWalletBinding(packet, options));
    assert.equal(verifyTapMessage(message, address, signTapWalletMessage(message, key, false), chain), true);
    assert.throws(() => verifyBip322Simple(message, address, packet.walletSignature, chain), /binding_wallet_signature/, 'old kits reject the legacy proof');
    const reject = (m = message, a = address, s = packet.walletSignature, c = chain) => assert.throws(() => verifyTapMessage(m, a, s, c), /binding_wallet_signature/);
    reject(message + 'x');
    reject(message, address, packet.walletSignature, chain === 'mainnet' ? 'regtest' : 'mainnet');
    reject(message, btc.p2tr(schnorr.getPublicKey(secp256k1.utils.randomPrivateKey()), undefined, bitcoinNetwork(chain)).address);
    reject(message, address.toUpperCase());
    reject(message, btc.p2pkh(secp256k1.getPublicKey(key), bitcoinNetwork(chain)).address);
    reject(message, btc.p2wpkh(secp256k1.getPublicKey(key), bitcoinNetwork(chain)).address);
    reject(message, btc.Address(bitcoinNetwork(chain)).encode({ type: 'tr', pubkey: schnorr.getPublicKey(key) }));
    const raw = Buffer.from(packet.walletSignature, 'base64'), sig = secp256k1.Signature.fromCompact(raw.subarray(1));
    const high = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s);
    reject(message, address, Buffer.concat([Buffer.from([27 + ((raw[0] - 27) ^ 1)]), high.toCompactRawBytes()]).toString('base64'));
    for (const header of [0, 1, 26, 35, 38, 39, 42, 255]) {
      const bad = Buffer.from(raw); bad[0] = header; reject(message, address, bad.toString('base64'));
    }
    for (const bad of ['', '!', packet.walletSignature + '\n', packet.walletSignature.slice(0, -1), 'A'.repeat(97), Buffer.alloc(65, 31).toString('base64')]) reject(message, address, bad);
    const zero = Buffer.alloc(65); zero[0] = 31; reject(message, address, zero.toString('base64'));
    for (const text of ['wallet proof', 'é'.repeat(200), 'x'.repeat(4096)]) {
      assert.equal(verifyTapMessage(text, address, signTapWalletMessage(text, key), chain), true);
    }
    for (const text of ['x'.repeat(4097), 'é'.repeat(2049)]) reject(text, address, signTapWalletMessage(text, key));
    const tampered = { ...request, nonce: '2' }, changed = bindingMessage(network, chain, tampered);
    assert.throws(() => verifyWalletBinding({ ...packet, request: tampered, agentSignature: Buffer.from(ed25519.sign(Buffer.from(changed), agentKey)).toString('hex') }, options), /binding_wallet_signature/);
  });
}

test('TAP message dispatch keeps the independent BIP-322 reference vector valid', () => {
  const message = 'PURVOQ544B6HUATVBJZN5EZJUU', address = 'bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38';
  const signature = 'smpAUB6B2Rbupzua8LTQIF06516wzl+cwKy1be8RgoiW0riyXdKwe6GTz/5Hnb37m67pJwIKCh+D5jDueG6KpvYpmu8';
  for (const s of [signature, signature.slice(3)]) assert.equal(verifyTapMessage(message, address, s, 'mainnet'), true);
  assert.throws(() => verifyTapMessage(message + 'x', address, signature, 'mainnet'), /binding_wallet_signature/);
});
