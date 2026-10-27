import { BUILD as configuredBuildRoot } from '../common.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { BUILD, ROOT, run, current, bitcoin, rpc, ordJson, receiveAddress, mine, waitFor, jsonFile } from '../common.mjs';
import { prove } from '../prove.mjs';
import { proveCompounds, provePayments } from '../prove-payments.mjs';
import { proveCancellable } from './cancellable-proof.mjs';

const fixtures = await jsonFile(new URL('./fixtures/wallet-requests.json', import.meta.url));
const cli = (...args) => run(process.execPath, [`${ROOT}/local/stack.mjs`, ...args], { timeout: 240000, maxBuffer: 8 * 1024 * 1024 });

test('fresh local stack and wallet route families', { timeout: 600000 }, async t => {
  let manifest;
  try {
    await cli('up'); manifest = await current();
    let proof;
    const replace = value => typeof value === 'string' ? value.replace(/\{(address|recipient|ticker|authority|inscription|txid|rawTx)\}/g, (_, key) => ({ address: proof?.alice || manifest.bitcoin.inscriberAddress, recipient: proof?.bob, ticker: proof?.ticker, authority: proof?.tokenAuthority, inscription: proof?.mint, txid: proof?.mint.slice(0, 64) })[key]) : JSON.parse(replace(JSON.stringify(value)));
    const request = async fixture => {
      const response = await fetch(manifest.gateway.url + replace(fixture.path), { method: fixture.method || 'GET', ...(fixture.body ? { body: typeof fixture.body === 'string' ? replace(fixture.body) : JSON.stringify(replace(fixture.body)), headers: { 'content-type': fixture.contentType || 'application/json' } } : {}) });
      assert.equal(response.status, fixture.status || 200, `${fixture.method} ${fixture.path}: ${await response.clone().text()}`);
      return response;
    };
    await t.test('Bitcoin regtest wallet is funded and txindex is synced', async () => {
      assert.equal((await bitcoin(manifest, 'getblockchaininfo')).chain, 'regtest');
      assert.equal((await bitcoin(manifest, 'getindexinfo')).txindex.synced, true);
      assert((await bitcoin(manifest, 'getbalance', [], 'faucet')) > 0);
      assert((await bitcoin(manifest, 'getbalance', [], 'ord')) > 0);
    });
    await t.test('ord uses vendored RE2 and tracks block making', async () => {
      assert.equal((await ordJson(manifest, '/r/tap/getRegexBackend')).result, 'vendored-re2-2024-06-01');
      const old = await bitcoin(manifest, 'getblockcount'); await mine(manifest, 2);
      assert.equal(await bitcoin(manifest, 'getblockcount'), old + 2);
    });
    await t.test('supervised interval miner starts and stops without another process', async () => {
      const old = await bitcoin(manifest, 'getblockcount');
      await cli('mine', '1', '0.1');
      await waitFor(async () => await bitcoin(manifest, 'getblockcount') >= old + 2, 'interval mining');
      await cli('mine', 'stop');
      assert.equal((await jsonFile(`${manifest.root}/manifest.json`)).mining, null);
      assert.equal((await jsonFile(`${manifest.root}/manifest.json`)).processes.length, 4);
    });
    await t.test('second up refuses to disrupt an active stack', async () => { await assert.rejects(cli('up'), /stack lock exists/); });
    await t.test('Anvil token is deployed with 18 decimals and funded accounts', async () => {
      assert.equal(await rpc(manifest.ethereum.rpc, 'eth_chainId'), '0x7a69');
      const call = data => rpc(manifest.ethereum.rpc, 'eth_call', [{ to: manifest.ethereum.token, data }, 'latest']);
      assert.equal(BigInt(await call('0x313ce567')), 18n);
      for (const account of manifest.ethereum.accounts.slice(0, 3)) assert.equal(BigInt(await call('0x70a08231' + account.slice(2).padStart(64, '0'))), 1000000n * 10n ** 18n);
    });
    await t.test('Foundry deployment script broadcasts and mints on local Anvil', async () => {
      const [admin, recipient] = manifest.ethereum.accounts;
      await run(`${ROOT}/eth/foundry`, ['script', 'script/Deploy.s.sol:Deploy', '--sig', 'run(address,address)', admin, recipient, '--rpc-url', manifest.ethereum.rpc, '--unlocked', '--sender', admin, '--broadcast'], { cwd: `${ROOT}/eth`, timeout: 120000 });
      const broadcast = await jsonFile(`${BUILD}/target/eth-broadcast/Deploy.s.sol/31337/run-latest.json`);
      const deployed = broadcast.transactions.find(tx => tx.transactionType === 'CREATE').contractAddress;
      for (const address of [admin, recipient]) {
        const balance = await rpc(manifest.ethereum.rpc, 'eth_call', [{ to: deployed, data: '0x70a08231' + address.slice(2).padStart(64, '0') }, 'latest']);
        assert.equal(BigInt(balance), 1000000n * 10n ** 18n);
      }
    });
    await t.test('DMT mint, replay refusal, transfer and HTLC round trip', { timeout: 300000 }, async () => { proof = await prove(manifest, message => t.diagnostic(message)); });
    assert(proof, 'protocol proof is required for route tests');
    await t.test('electrs and mempool read request fixtures', async () => {
      for (const fixture of fixtures.bitcoin.filter(f => f.method === 'GET')) await request(fixture);
      const utxos = await (await request(fixtures.bitcoin[1])).json();
      assert(utxos.length > 0); assert.equal(typeof utxos[0].value, 'number'); assert(utxos[0].status.confirmed);
      const history = await (await request(fixtures.bitcoin[3])).json(); assert(history.length > 0); assert(Array.isArray(history[0].vin));
    });
    await t.test('wallet-shaped raw transaction broadcast and pending UTXO', async () => {
      const receiver = await receiveAddress(manifest);
      const raw = await bitcoin(manifest, 'createrawtransaction', [[], [{ [receiver]: 0.001 }]]);
      const funded = await bitcoin(manifest, 'fundrawtransaction', [raw], 'faucet');
      const signed = await bitcoin(manifest, 'signrawtransactionwithwallet', [funded.hex], 'faucet');
      const response = await request({ method: 'POST', path: '/tx', contentType: 'text/plain', body: signed.hex });
      const txid = await response.json(); assert.match(txid, /^[a-f0-9]{64}$/);
      const pending = await (await request({ path: `/address/${receiver}/utxo` })).json(); assert.equal(pending[0].status.confirmed, false);
      await mine(manifest);
      const confirmed = await (await request({ path: `/address/${receiver}/utxo` })).json(); assert.equal(confirmed[0].status.confirmed, true);
    });
    await t.test('ordinal request fixtures expose real inscription metadata and content', async () => {
      for (const fixture of fixtures.ordinal) await request(fixture);
      const data = await (await request(fixtures.ordinal[2])).json();
      assert(data.data.utxo.some(u => u.inscriptions.some(i => i.inscriptionId === proof.mint)));
      const content = await (await request(fixtures.ordinal[7])).json(); assert.equal(content.op, 'dmt-mint');
      const cardinals = await (await request(fixtures.ordinal[1])).json(); assert(cardinals.data.utxo.every(u => u.inscriptions.length === 0));
    });
    await t.test('TAP reader fixtures preserve envelopes and token metadata', async () => {
      for (const fixture of fixtures.tap) await request(fixture);
      const balances = await (await request(fixtures.tap[1])).json();
      const token = balances.data.list.find(v => v.ticker === proof.ticker);
      assert(token.tokenInfo.dmt); assert.equal(token.overallBalance, proof.balances.alice);
    });
    await t.test('text order requires payment and automatically inscribes after confirmation', async () => {
      const order = (await (await request({ method: 'POST', path: '/v1/inscribe/order/texts', body: fixtures.textOrder })).json()).data;
      await request({ method: 'POST', path: `/v1/inscribe/order/paid/${order.id}`, body: {}, status: 409 });
      await bitcoin(manifest, 'sendtoaddress', [order.payAddress, order.totalFee / 1e8], 'faucet'); await mine(manifest);
      const paid = await waitFor(async () => {
        const result = (await (await request({ path: `/v2/inscribe/order/${order.id}` })).json()).data;
        return result.state === 'inscribed' ? result : false;
      }, 'paid order inscription');
      assert.match(paid.files[0].inscriptionId, /^[a-f0-9]{64}i0$/);
      await mine(manifest);
      const retry = (await (await request({ method: 'POST', path: `/v1/inscribe/order/paid/${order.id}`, body: {} })).json()).data;
      assert.equal(retry.files[0].inscriptionId, paid.files[0].inscriptionId);
      await request({ method: 'POST', path: `/v1/inscribe/order/tapping/${order.id}`, body: {} });
      for (const fixture of fixtures.inscriberReads) await request(fixture);
    });
    await t.test('transfer order and unpaid cancellation', async () => {
      const order = (await (await request({ method: 'POST', path: '/v1/inscribe/order/tapTransfer', body: fixtures.transferOrder })).json()).data;
      assert.equal(order.files[0].receiver, proof.alice, 'transferable is first inscribed to token owner');
      await request({ method: 'POST', path: `/v1/inscribe/order/cancel/${order.id}`, body: {} });
      await request({ method: 'POST', path: `/v1/inscribe/order/paid/${order.id}`, body: {}, status: 409 });
    });
    await t.test('TRAC fixtures are explicit stubs and never fake a broadcast', async () => {
      for (const fixture of fixtures.trac) { const response = await request(fixture); const data = await response.json(); if (fixture.method === 'GET') assert.equal(data.stub, true); else assert.match(data.error, /no transaction was broadcast/); }
    });
    await t.test('price fixtures return zero test prices', async () => {
      for (const fixture of fixtures.prices) { const data = await (await request(fixture)).json(); assert.equal(data.stub, true); assert.equal(data.data.price_usd || data.data.amount, '0'); }
    });
    await t.test('bad requests and unsupported routes fail explicitly', async () => {
      await request({ path: '/missing', status: 404 });
      await request({ method: 'POST', path: '/tx', contentType: 'text/plain', body: 'not-hex', status: 400 });
      await request({ path: '/address/invalid/utxo', status: 400 });
      await request({ path: '/v1/indexer/address/{address}/utxo-data?cursor=-1', status: 400 });
    });
    await t.test('wipe rejects the data root and relative paths', async () => {
      await assert.rejects(cli('wipe', `${configuredBuildRoot}/data`), /exact absolute run/);
      await assert.rejects(cli('wipe', 'data/run-test'), /exact absolute run/);
    });
    let compound;
    await t.test('compound permits enforce amount, receiver, signer and replay protection in batched mints', async () => { compound = await proveCompounds(manifest, message => t.diagnostic(message)); });
    assert(compound, 'compound proof is required for payment tests');
    await t.test('wallet payment locks split and burn atomically, refund at expiry and settle only once', async () => { await provePayments(manifest, compound, message => t.diagnostic(message)); });
    await proveCancellable(manifest, t);
  } finally {
    if (manifest) { await cli('down', manifest.root); t.diagnostic(`Stopped run retained at ${manifest.root}`); }
  }
  await t.test('fresh restart uses a different run and exact wipe removes only it', async () => {
    let next;
    try { await cli('up'); next = await current(); assert.notEqual(next.root, manifest.root); assert.equal(await bitcoin(next, 'getblockcount'), 111); }
    finally { if (next) await cli('wipe', next.root); }
    await assert.rejects(access(next.root)); await access(manifest.root);
  });
});
