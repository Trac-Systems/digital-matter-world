import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Store } from '../../service/src/store.mjs';
import { serve } from '../../service/src/http.mjs';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { bindingFixture } from '../../service/test/bindings-fixture.mjs';
import { agent, temp } from '../../service/test/helpers.mjs';
import { bindTestPayoutWallets, bindSavedTestPayoutWallets } from '../payout-wallets.mjs';
import { preparePlayer } from '../kit-player.mjs';

test('local players bind both test wallets through HTTP and retain a later human replacement', async () => {
  const directory = await temp('playground-binding-'), store = await Store.open(join(directory, 'service')), f = bindingFixture(store), who = agent(77);
  const http = await serve({ intake: { store }, files: { serve: async () => false }, bindings: f.bindings });
  const service = new ServiceClient({ origin: http.url, network: 'dmw-regtest', receiptSigners: f.members });
  const options = { directory: join(directory, 'player'), wallet: f.wallet(who), service };
  try {
    const wallets = await bindTestPayoutWallets(options);
    assert.match(wallets.tap, /^bcrt1p/); assert.match(wallets.ethereum, /^0x[0-9a-f]{40}$/);
    assert.deepEqual(await bindTestPayoutWallets(options), wallets);
    const current = f.bindings.current(who.address, 'tap');
    const human = await f.bind(who, 'tap', agent(78).secret.toString('hex'), (BigInt(current.request.nonce) + 1n).toString());
    assert.equal((await bindTestPayoutWallets(options)).tap, human.request.address);
    assert.equal(store.count('payoutBindings'), 3);
    await assert.rejects(bindTestPayoutWallets({ ...options, service: { network: 'mainnet' } }), /local_payout_network/);
  } finally { await http.close(); await store.close(); }
});

test('startup replaces invalid certificates and unexpired invalid cached requests through payout binding verification', async () => {
  const directory = await temp('playground-rebind-'), store = await Store.open(join(directory, 'service')), f = bindingFixture(store), who = agent(78);
  const http = await serve({ intake: { store }, files: { serve: async () => false }, bindings: f.bindings });
  const service = new ServiceClient({ origin: http.url, network: 'dmw-regtest', receiptSigners: f.members });
  const options = { directory: join(directory, 'player'), wallet: f.wallet(who), service };
  try {
    const wallets = await bindTestPayoutWallets(options), ids = {};
    const path = join(options.directory, 'payout-wallets.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    for (const rail of ['tap', 'ethereum']) {
      const record = f.bindings.current(who.address, rail); ids[rail] = record.id;
      await store.put('payoutBindings', record.id, { ...record, agentSignature: '00'.repeat(64) });
      saved.requests[rail].agentSignature = '00'.repeat(64);
      assert.ok(saved.requests[rail].request.expiry > Date.now());
      assert.equal(f.bindings.current(who.address, rail), null);
    }
    await writeFile(path, JSON.stringify(saved));
    assert.deepEqual(await bindTestPayoutWallets(options), wallets);
    for (const rail of ['tap', 'ethereum']) {
      const rebound = f.bindings.current(who.address, rail);
      assert.notEqual(rebound.id, ids[rail]); assert.equal(rebound.attestations.length, 5);
      assert.equal(rebound.request.address, wallets[rail]);
    }
    assert.deepEqual(await bindTestPayoutWallets(options), wallets);
    assert.equal(store.count('payoutBindings'), 4);
  } finally { await http.close(); await store.close(); }
});

test('startup binds saved inactive bots and kit players in their existing wallet directories', async () => {
  const directory = await temp('playground-saved-'), store = await Store.open(join(directory, 'service')), f = bindingFixture(store);
  const http = await serve({ intake: { store }, files: { serve: async () => false }, bindings: f.bindings });
  const service = new ServiceClient({ origin: http.url, network: 'dmw-regtest', receiptSigners: f.members });
  const playersDirectory = join(directory, 'players'), payoutDirectory = join(directory, 'payout-wallets');
  try {
    const bot = await preparePlayer(['status', '--player', 'bot-9'], { root: playersDirectory, env: {} });
    const kit = await preparePlayer(['status', '--player', 'named-kit'], { root: join(playersDirectory, 'agents'), env: {} });
    await bindSavedTestPayoutWallets({ playersDirectory, payoutDirectory, service });
    for (const [player, isKit] of [[bot, false], [kit, true]]) {
      const { address } = JSON.parse(await readFile(join(player.directory, 'keystore.json'), 'utf8'));
      const path = join(isKit ? join(payoutDirectory, address) : player.directory, 'payout-wallets.json');
      assert.equal(JSON.parse(await readFile(path, 'utf8')).agent, address);
      for (const rail of ['tap', 'ethereum']) assert.equal(f.bindings.current(address, rail).attestations.length, 5);
    }
    await bindSavedTestPayoutWallets({ playersDirectory, payoutDirectory, service });
    assert.equal(store.count('payoutBindings'), 4);
  } finally { await http.close(); await store.close(); }
});
