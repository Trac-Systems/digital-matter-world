import { encodeTracAddress } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { serve } from '../src/http.mjs';
import { agent, temp } from './helpers.mjs';
import { bindingFixture } from './bindings-fixture.mjs';
import { testPayoutAddress } from './payout-wallets.mjs';

async function setup(t) {
  let now = Date.now();
  const store = await Store.open(await temp('wallet-lookup-')); t.after(() => store.close());
  const f = bindingFixture(store, { now: () => now++ });
  const http = await serve({ intake: { store }, files: { serve: async () => false }, bindings: f.bindings });
  t.after(() => http.close());
  const read = async path => { const r = await fetch(http.url + path); return { status: r.status, body: await r.json() }; };
  return { store, f, read };
}

test('a wallet lists the players whose current accepted binding names it, per rail', async t => {
  const { f, read } = await setup(t), key = agent(60).secret.toString('hex');
  const one = agent(61), two = agent(62), other = agent(63);
  await f.bind(one, 'tap', key, '1'); await f.bind(two, 'tap', key, '1'); await f.bind(other, 'tap', agent(64).secret.toString('hex'), '1');
  const tap = testPayoutAddress(key, 'tap');
  const found = await read('/wallets/' + tap);
  assert.equal(found.status, 200);
  assert.equal(found.body.address, tap); assert.equal(found.body.rail, 'tap'); assert.equal(found.body.more, false);
  assert.deepEqual(found.body.players.map(p => p.agent).sort(), [one, two].map(w => encodeTracAddress(w.address)).sort());
  assert.ok(found.body.players.every(p => p.rail === 'tap' && /^[0-9a-f]{64}$/.test(p.binding) && Number.isSafeInteger(p.acceptedAt)));
  assert.equal(JSON.stringify(found.body).includes('Signature'), false, 'no signatures or certificates in the lookup');

  await f.bind(one, 'ethereum', key, '1');
  const eth = testPayoutAddress(key, 'ethereum'), mixed = '0x' + eth.slice(2).toUpperCase();
  const byEth = await read('/wallets/' + mixed);
  assert.equal(byEth.status, 200); assert.equal(byEth.body.address, eth); assert.equal(byEth.body.rail, 'ethereum');
  assert.deepEqual(byEth.body.players.map(p => [p.agent, p.rail]), [[encodeTracAddress(one.address), 'ethereum']]);

  const unknown = await read('/wallets/' + testPayoutAddress(agent(65).secret.toString('hex'), 'tap'));
  assert.deepEqual(unknown.body.players, []);
});

test('a replaced or invalid binding no longer links the wallet to its player', async t => {
  const { store, f, read } = await setup(t), who = agent(70), first = agent(71).secret.toString('hex');
  await f.bind(who, 'tap', first, '1');
  await f.bind(who, 'tap', agent(72).secret.toString('hex'), '2');
  assert.deepEqual((await read('/wallets/' + testPayoutAddress(first, 'tap'))).body.players, []);
  assert.equal((await read('/wallets/' + testPayoutAddress(agent(72).secret.toString('hex'), 'tap'))).body.players.length, 1);

  // A stored record without a valid quorum never counts, even if it names the wallet.
  const forged = agent(73), accepted = await f.bind(forged, 'tap', agent(74).secret.toString('hex'), '1');
  await store.put('payoutBindings', accepted.id, { ...accepted, attestations: [] });
  assert.deepEqual((await read('/wallets/' + testPayoutAddress(agent(74).secret.toString('hex'), 'tap'))).body.players, []);
});

test('the lookup is bounded and rejects anything but a TAP Taproot or Ethereum address', async t => {
  const { f, read } = await setup(t), key = agent(80).secret.toString('hex');
  for (let i = 0; i < 17; i++) await f.bind(agent(100 + i), 'tap', key, '1');
  const page = await read('/wallets/' + testPayoutAddress(key, 'tap'));
  assert.equal(page.body.players.length, 16); assert.equal(page.body.more, true);
  for (const bad of ['trac1qqqq', '0x' + '0'.repeat(40), '0x1234', testPayoutAddress(key, 'tap', 'mainnet'), testPayoutAddress(key, 'tap').toUpperCase(), 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'])
    assert.deepEqual(await read('/wallets/' + bad), { status: 400, body: { error: 'wallet_address' } }, bad);
  assert.equal((await read('/wallets/' + 'a'.repeat(101))).status, 404);
  assert.equal((await read('/wallets/' + testPayoutAddress(key, 'tap') + '/x')).status, 404);
});
