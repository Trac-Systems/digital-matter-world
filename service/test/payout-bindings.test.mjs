import { encodeTracAddress } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Bindings } from '../src/bindings.mjs';
import { agent, temp } from './helpers.mjs';
import { bindingFixture } from './bindings-fixture.mjs';
import { verifyWalletBinding, verifyBinding, verifyBip322Simple, BINDING_DOMAIN, attestBinding } from '../../rules/src/payout-bindings.mjs';
import { hash, stableJSON } from '../../rules/src/core.js';
import { createRequire } from 'node:module';
import { signTestPayout } from './payout-wallets.mjs';
import { createServer } from 'node:http';
import { Committee } from '../src/committee.mjs';
import { signTapWalletMessage } from '../../rules/test/tap-wallet-signing.mjs';
const { ed25519 } = createRequire(new URL('../../rules/package.json', import.meta.url))('@noble/curves/ed25519');

for (const bitcoinNetwork of ['mainnet', 'regtest']) test(`TAP Wallet legacy binding survives committee acceptance, history, quote use and restart (${bitcoinNetwork})`, async t => {
  const directory = await temp('tap-wallet-binding-'); let store = await Store.open(directory), now = Date.now();
  t.after(() => store.close());
  const f = bindingFixture(store, { bitcoinNetwork, now: () => now }), who = agent(81);
  const packet = f.packet(who, 'tap', who.secret.toString('hex'), '1');
  const { walletSignature: unused, ...body } = packet, pending = await f.bindings.request(body);
  const walletSignature = signTapWalletMessage(pending.message, who.secret);
  const accepted = await f.bindings.complete({ id: pending.id, walletSignature });
  assert.equal(accepted.walletSignature, walletSignature, 'attest the exact wallet bytes, without rewriting');
  assert.equal(accepted.attestations.length, 5);
  assert.deepEqual(await f.bindings.complete({ id: pending.id, walletSignature }), accepted);
  for (let i = 0; i < 5; i++) {
    assert.equal(f.journals[i].records.length, 1);
    assert.deepEqual(await f.endorse(f.journals[i].records[0].record, i), accepted.attestations[i]);
  }
  const route = `/payout-bindings/${encodeTracAddress(who.address)}/tap`, snapshot = { issuedAt: now, payouts: { finder: accepted.id } };
  assert.equal(f.bindings.read(route).binding.id, accepted.id);
  assert.equal(f.bindings.read(route + '/history').bindings[0].walletSignature, walletSignature);
  assert.deepEqual(f.bindings.owners(accepted.request.address), [who.address]);
  const anotherValidSignature = signTapWalletMessage(pending.message, who.secret, false);
  assert.throws(() => verifyBinding({ ...accepted, walletSignature: anotherValidSignature }, f.bindings.options()), /binding_attestation/);
  now += 10;
  const replacement = await f.bind(who, 'tap', agent(82).secret.toString('hex'), '2');
  now += 86400000; await store.close(); store = await Store.open(directory);
  const reopened = new Bindings({ store, network: f.bindings.network, bitcoinNetwork, members: f.members, now: () => now });
  assert.equal(reopened.current(who.address, 'tap').id, replacement.id);
  assert.deepEqual(reopened.proof(accepted.id), accepted);
  assert.equal(reopened.resolve(who.address, 'tap', snapshot, 'finder').id, accepted.id);
  assert.equal(reopened.read(route + '/history').total, 2);
});

for (const rail of ['tap', 'ethereum']) test(`${rail} hex-message signatures never establish a binding, even with a quorum`, async t => {
  const store = await Store.open(await temp('binding-format-')); t.after(() => store.close());
  const f = bindingFixture(store), who = agent(79), packet = f.packet(who, rail, who.secret.toString('hex'), '1');
  const message = `${BINDING_DOMAIN}\n${stableJSON({ network: 'dmw-regtest', bitcoinNetwork: 'regtest', ...packet.request })}`;
  const record = { ...packet, id: hash(message), acceptedAt: Date.now(),
    agentSignature: Buffer.from(ed25519.sign(Buffer.from(message), who.secret)).toString('hex'),
    walletSignature: signTestPayout(message, who.secret.toString('hex'), rail), attestations: [] };
  for (let i = 0; i < 5; i++) record.attestations.push(attestBinding(record, { ...f.bindings.options(), signer: f.members[i].id, secret: Buffer.alloc(32, 180 + i).toString('hex') }));
  assert.throws(() => verifyBinding(record, f.bindings.options()), /binding_agent_signature/);
  assert.throws(() => verifyBinding(record, { ...f.bindings.options(), rosterHistory: [{ members: f.members }] }), /binding_agent_signature/);
  await assert.rejects(f.endorse(record, 0), /binding_agent_signature/);
  await assert.rejects(f.bindings.request({ request: record.request, agentSignature: record.agentSignature }), /binding_agent_signature/);
  const key = who.address + '/' + rail;
  await store.transact([{ space: 'payoutBindings', id: record.id, value: record }, { space: 'payoutCurrent', id: key, value: record.id },
    { space: 'payoutHistory/' + key, id: '1'.padStart(20, '0'), value: record.id }]);
  const route = `/payout-bindings/${encodeTracAddress(who.address)}/${rail}`;
  assert.equal(f.bindings.read(route).binding, null);
  assert.equal(f.bindings.read(route + '/history').total, 0);
  assert.deepEqual(f.bindings.owners(record.request.address), []);
  assert.throws(() => f.bindings.proof(record.id), /binding_agent_signature/);
  assert.throws(() => f.bindings.resolve(who.address, rail, null, 'finder'), /finder_address_missing/);
  const rebound = await f.bind(who, rail, who.secret.toString('hex'), '2');
  assert.equal(f.bindings.current(who.address, rail).id, rebound.id);
  assert.equal(f.bindings.read(route + '/history').total, 1);
  assert.throws(() => f.bindings.resolve(who.address, rail, { issuedAt: record.acceptedAt, payouts: { finder: record.id } }, 'finder'), /binding_agent_signature/);
});

for (const rail of ['tap', 'ethereum']) test(`${rail} bindings require both signatures, the exact network and an unexpired request`, async t => {
  const store = await Store.open(await temp('payout-')); t.after(() => store.close());
  const f = bindingFixture(store), who = agent(12), packet = f.packet(who, rail, who.secret.toString('hex'));
  const options = f.bindings.options();
  assert.ok(verifyWalletBinding(packet, options));
  assert.throws(() => verifyWalletBinding({ ...packet, agentSignature: '00'.repeat(64) }, options), /binding_agent_signature/);
  assert.throws(() => verifyWalletBinding({ ...packet, walletSignature: '00' }, options), /binding_wallet_signature/);
  assert.throws(() => verifyWalletBinding(packet, { ...options, network: 'foreign' }), /binding_agent_signature/);
  assert.throws(() => verifyWalletBinding(packet, { ...options, now: packet.request.expiry }), /binding_expired/);
  const other = f.packet(who, rail, agent(13).secret.toString('hex'));
  assert.throws(() => verifyWalletBinding({ ...other, walletSignature: packet.walletSignature }, options), /binding_wallet_signature/);
  if (rail === 'tap') assert.throws(() => verifyWalletBinding(packet, { ...options, bitcoinNetwork: 'mainnet' }));
  const { walletSignature, ...request } = packet, pending = await f.bindings.request(request);
  assert.deepEqual(await f.bindings.request(request), pending);
  const accepted = await f.bindings.complete({ id: pending.id, walletSignature });
  assert.equal(accepted.attestations.length, 5);
  assert.deepEqual(await f.bindings.complete({ id: pending.id, walletSignature }), accepted);
  for (let i = 0; i < 5; i++) assert.equal(f.journals[i].records.length, 1);
  assert.throws(() => verifyBinding({ ...accepted, attestations: accepted.attestations.slice(0, 2) }, options), /binding_quorum/);
  assert.throws(() => verifyBinding({ ...accepted, walletSignature: 'bad' }, options), /binding_wallet_signature/);
});

test('replacement advances the nonce, retains history and preserves the binding at quote time after expiry/restart', async t => {
  const directory = await temp('payout-history-'); let store = await Store.open(directory), now = Date.now();
  t.after(() => store.close());
  const f = bindingFixture(store, { now: () => now }), who = agent(22);
  const first = await f.bind(who, 'tap', who.secret.toString('hex'), '1');
  const snapshot = { issuedAt: now, payouts: { finder: first.id } }; now += 10;
  const second = await f.bind(who, 'tap', agent(23).secret.toString('hex'), '2');
  assert.equal(f.bindings.resolve(who.address, 'tap', snapshot, 'finder').id, first.id);
  assert.equal(f.bindings.resolve(who.address, 'tap', null, 'finder').id, second.id);
  assert.throws(() => f.bindings.resolve(who.address, 'tap', { ...snapshot, issuedAt: now }, 'finder'), /binding_superseded/);
  assert.throws(() => f.bindings.resolve(agent(24).address, 'tap', snapshot, 'finder'), /binding_role/);
  await assert.rejects(f.bind(who, 'tap', agent(24).secret.toString('hex'), '2'), /binding_nonce/);
  const route = `/payout-bindings/${encodeTracAddress(who.address)}/tap/history`, page = f.bindings.read(route + '?limit=1');
  assert.equal(page.total, 2); assert.equal(page.bindings[0].id, second.id);
  assert.equal(f.bindings.read(route + '?cursor=' + encodeURIComponent(page.next)).bindings[0].id, first.id);
  now += 86400000; await store.close(); store = await Store.open(directory);
  const reopened = new Bindings({ store, network: f.bindings.network, bitcoinNetwork: 'regtest', members: f.members, now: () => now });
  assert.equal(reopened.current(who.address, 'tap').id, second.id);
  assert.equal(reopened.resolve(who.address, 'tap', snapshot, 'finder').id, first.id);
});

test('a partial quorum cannot activate a binding; retry uses its original durable attempt', async t => {
  const store = await Store.open(await temp('payout-quorum-')); t.after(() => store.close());
  const f = bindingFixture(store), who = agent(27), packet = f.packet(who, 'ethereum', who.secret.toString('hex'));
  const { walletSignature, ...body } = packet, pending = await f.bindings.request(body);
  f.committee.bindPayout = record => Promise.all([0, 1].map(i => f.endorse(record, i)));
  await assert.rejects(f.bindings.complete({ id: pending.id, walletSignature }), /binding_quorum/);
  assert.equal(f.bindings.current(who.address, 'ethereum'), null);
  f.committee.bindPayout = record => Promise.all([0, 1, 2].map(i => f.endorse(record, i)));
  assert.equal((await f.bindings.complete({ id: pending.id, walletSignature })).attestations.length, 3);
  assert.equal(f.journals[0].records.length, 1);
});

// Public CC0 vector from bitcoin/bips bip-0322/generated-test-vectors.json.
test('BIP-322 Taproot matches the independent published reference vector', () => {
  const message = 'PURVOQ544B6HUATVBJZN5EZJUU', address = 'bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38';
  const signature = 'smpAUB6B2Rbupzua8LTQIF06516wzl+cwKy1be8RgoiW0riyXdKwe6GTz/5Hnb37m67pJwIKCh+D5jDueG6KpvYpmu8';
  assert.equal(verifyBip322Simple(message, address, signature, 'mainnet'), true);
  assert.equal(verifyBip322Simple(message, address, signature.slice(3), 'mainnet'), true);
  assert.throws(() => verifyBip322Simple(message + 'x', address, signature, 'mainnet'), /binding_wallet_signature/);
});

test('three valid signer HTTP endorsements activate a binding despite two invalid responses', async () => {
  const store = await Store.open(await temp('payout-signers-')), f = bindingFixture(store), who = agent(28);
  const server = createServer(async (req, res) => {
    try {
      const i = Number(req.url.split('/')[1]), chunks = []; for await (const chunk of req) chunks.push(chunk);
      const record = JSON.parse(Buffer.concat(chunks)), vote = await f.endorse(record, i);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(i < 3 ? vote : { ...vote, sig: '00'.repeat(64) }));
    } catch { res.writeHead(409); res.end('{"error":"binding_refused"}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    f.bindings.committee = new Committee({ store, network: 'dmw-regtest', signers: f.members.map((peer, i) => ({ id: peer.id, peer, token: 'local-test', url: `http://127.0.0.1:${server.address().port}/${i}` })) });
    assert.equal((await f.bind(who, 'tap')).attestations.length, 3);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close(); }
});
