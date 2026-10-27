import { encodeTracAddress, wireIdentities } from '../rules/src/trac-address.js';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { maybe, save, check, privateDir } from './common.mjs';
import { publicKey, unlock, wipeWallet } from '../kit/lib/keyring.mjs';
import { signBytes } from '../kit/lib/signing.mjs';
import { bindingMessage, bindingId, bitcoinNetwork, bip322Transaction, personalMessageHash, verifyBinding, verifyWalletBinding } from '../rules/src/payout-bindings.mjs';
const require = createRequire(new URL('../rules/package.json', import.meta.url));
const btc = require('@scure/btc-signer');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');

// Local test wallets only. These keys stay in the player's private directory;
// the HTTP flow receives only the same public signatures a human wallet sends.
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
export async function bindTestPayoutWallets({ directory, wallet, service }) {
  check(service.network.includes('regtest'), 'local_payout_network');
  await privateDir(directory);
  const agent = publicKey(wallet), path = join(directory, 'payout-wallets.json');
  let state = await maybe(path);
  if (!state) { state = { agent, tap: randomBytes(32).toString('hex'), ethereum: randomBytes(32).toString('hex'), requests: {} }; await save(path, state); }
  check(state.agent === agent, 'local_payout_agent');
  const result = {};
  for (const rail of ['tap', 'ethereum']) {
    const current = wireIdentities((await service.payoutBinding(encodeTracAddress(agent), rail)).binding);
    if (current) {
      verifyBinding(current, { network: service.network, bitcoinNetwork: 'regtest', members: service.receiptSigners });
      check(current.request.agent === agent && current.request.rail === rail, 'local_payout_binding');
      result[rail] = current.request.address; continue;
    }
    const address = testPayoutAddress(state[rail], rail), now = Date.now();
    let envelope = state.requests[rail];
    if (envelope) {
      try {
        verifyWalletBinding(envelope, { network: service.network, bitcoinNetwork: 'regtest', now });
        check(envelope.request.agent === agent && envelope.request.rail === rail && envelope.request.address === address, 'local_payout_request');
      } catch { envelope = null; }
    }
    if (!envelope) {
      const request = { agent, rail, address, nonce: String(now), expiry: now + 3600000 };
      const message = bindingMessage(service.network, 'regtest', request);
      envelope = { request, agentSignature: signBytes(wallet, Buffer.from(message)), walletSignature: signTestPayout(message, state[rail], rail) };
      state.requests[rail] = envelope; await save(path, state);
    }
    const { walletSignature, ...agentRequest } = envelope;
    const pending = await service.requestPayoutBinding(agentRequest);
    check(pending.id === bindingId(service.network, 'regtest', envelope.request), 'local_payout_request');
    const binding = wireIdentities(await service.request('/payout-bindings/complete', { value: { id: pending.id, walletSignature } }));
    verifyBinding(binding, { network: service.network, bitcoinNetwork: 'regtest', members: service.receiptSigners });
    check(binding.id === pending.id, 'local_payout_binding');
    result[rail] = address;
  }
  return result;
}

// Restore only identities owned by this playground, including saved kit players
// and bots outside the active count. External wallets bind when their kit starts.
export async function bindSavedTestPayoutWallets({ playersDirectory, payoutDirectory, service, active = new Set() }) {
  const directories = async path => {
    try { return (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const players = (await directories(playersDirectory)).filter(name => name !== 'agents').map(name => ({ directory: join(playersDirectory, name), kit: false }));
  players.push(...(await directories(join(playersDirectory, 'agents'))).map(name => ({ directory: join(playersDirectory, 'agents', name), kit: true })));
  for (const player of players) {
    const keyring = await maybe(join(player.directory, 'keystore.json'));
    if (!keyring || active.has(keyring.address)) continue;
    const password = await readFile(join(player.directory, 'password'), 'utf8');
    const wallet = await unlock({ directory: player.directory, password });
    try {
      await bindTestPayoutWallets({ directory: player.kit ? join(payoutDirectory, publicKey(wallet)) : player.directory, wallet, service });
    } finally { wipeWallet(wallet); }
  }
}
