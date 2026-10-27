import { createRequire } from 'node:module';
import { Bindings } from '../src/bindings.mjs';
import { bindingMessage } from '../../rules/src/payout-bindings.mjs';
import { endorseBinding } from '../../committee/signer/bindings.mjs';
import { signTestPayout, testPayoutAddress } from './payout-wallets.mjs';
const { ed25519 } = createRequire(new URL('../../rules/package.json', import.meta.url))('@noble/curves/ed25519');
export function bindingFixture(store, { network = 'dmw-regtest', bitcoinNetwork = 'regtest', now = Date.now, numericIds = false } = {}) {
  const identities = Array.from({ length: 5 }, (_, i) => Buffer.alloc(32, 180 + i));
  const members = identities.map((secret, i) => ({ id: numericIds ? i + 1 : 'payout-' + i, identity: Buffer.from(ed25519.getPublicKey(secret)).toString('hex') }));
  const journals = members.map(() => ({ records: [], async append(type, fields) { this.records.push({ type, ...structuredClone(fields) }); } }));
  const endorse = (record, i) => endorseBinding(record, { config: { network, id: members[i].id }, secrets: { identity: identities[i].toString('hex') }, journal: journals[i], bitcoinNetwork, now: now() });
  const committee = { bindPayout: record => Promise.all(members.map((_, i) => endorse(record, i))) };
  const bindings = new Bindings({ store, network, bitcoinNetwork, members, committee, now });
  const wallet = who => ({ publicKey: who.address, sign: bytes => ed25519.sign(bytes, who.secret) });
  const packet = (who, rail, walletKey, nonce = String(now()), expiry = now() + 3600000) => {
    const address = testPayoutAddress(walletKey, rail, bitcoinNetwork), request = { agent: who.address, rail, address, nonce, expiry };
    const message = bindingMessage(network, bitcoinNetwork, request);
    return { request, agentSignature: Buffer.from(ed25519.sign(Buffer.from(message), who.secret)).toString('hex'), walletSignature: signTestPayout(message, walletKey, rail, bitcoinNetwork) };
  };
  const bind = async (who, rail, walletKey = who.secret.toString('hex'), nonce) => {
    const { walletSignature, ...body } = packet(who, rail, walletKey, nonce);
    const pending = await bindings.request(body); return bindings.complete({ id: pending.id, walletSignature });
  };
  return { bindings, members, committee, journals, endorse, packet, bind, wallet, config: members.map(peer => ({ id: peer.id, peer })) };
}
