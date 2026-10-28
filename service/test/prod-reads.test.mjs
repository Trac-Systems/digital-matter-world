import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Store } from '../src/store.mjs';
import { heightKey } from '../src/util.mjs';
import { configFixture } from '../prod/test/helpers.mjs';
import { createFeePolicy } from '../src/fees.mjs';
import { calldata } from '../../committee/signer/escrow.mjs';
import { join } from 'node:path';
import { PublicViews } from '../src/public-views.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { cachePublicReads } from '../src/public-cache.mjs';
import { serve } from '../src/http.mjs';
import { Files } from '../src/files.mjs';
import { fixtureHistory } from './helpers.mjs';
import { PublicIndex } from '../src/public-index.mjs';
import { harness, alice, bob, signedRequest, nonce, deployment } from '../../contract/tests/helpers/harness.mjs';
import { bytesToHex, requestDigest } from '../../contract/signing.js';
import { TapReader } from '../prod/tap.mjs';

let active;
mock.module('../prod/bitcoin.mjs', { exports: {
  createBitcoin: async () => ({ tip: async () => ({ height: active.head.tip.height, hash: active.head.tip.hash }) }),
  BitcoinViews: class { async view() {} close() {} }
} });
mock.module('../prod/tap.mjs', { exports: { createTap: async () => ({
  async stamp() {
    active.stamps = (active.stamps ?? 0) + 1;
    this.observedTip = { height: active.head.tip.height, hash: active.head.tip.hash, checkedAt: Date.now() };
    return { height: this.observedTip.height, hash: this.observedTip.hash };
  },
  tap: path => active.tap(path), at: (_view, read) => read()
}) } });
mock.module('../prod/ethereum.mjs', { exports: { createEthereum: async () => ({
  rpc: (...args) => active.rpc(...args), escrow: { deposit: async () => active.deposit }
}) } });
mock.module('../prod/trac.mjs', { exports: { configuredTrac: async () => {
  const f = active, trac = async (method, args = []) => {
    f.calls.push([method, ...args]);
    if (method === 'head') return f.head;
    if (method === 'batchLast') return { n: f.last, to: f.last };
    if (method === 'root') return f.roots.get(args[0]) ?? null;
    if (method === 'pending') return f.mints.get(args[0]) ?? null;
    if (method === 'stamp') return { counted: 1000000, last: { n: f.last, to: f.last }, revision: f.revision };
    if (method === 'read') return f.contract.get(args[0]) ?? null;
    assert.fail('Unexpected Trac call: ' + method);
  };
  trac.close = async () => {}; return trac;
} } });
const { productionReads } = await import('../prod/reads.mjs');
const { createAdapters } = await import('../prod/adapter.mjs');

async function fixture(t, adapter = false) {
  let f, store;
  t.after(async () => { await f?.reads?.close(); await store?.close(); });
  const { config, root } = await configFixture(t); store = await Store.open(root + '/store');
  f = active = { config, store, calls: [], last: 0, revision: 1, roots: new Map(), mints: new Map(), contract: new Map(),
    head: { tip: { height: 1000006, hash: 'ab'.repeat(32) }, counted: 1000000 },
    tap: path => assert.fail('Unexpected TAP call: ' + path), rpc: method => assert.fail('Unexpected Ethereum call: ' + method) };
  const instance = adapter ? await createAdapters({ config, store, history: {} }) : { reads: await productionReads(config, store) };
  f.reads = instance.reads;
  f.batch = async ops => {
    const n = ++f.last, root = String(n).padStart(64, '0'); f.roots.set(n, root);
    await store.put('batches', heightKey(n), { batch: { n, root, ops } });
  };
  return f;
}

test('unchanged and lower verified tips do not rewrite the durable highest tip', async t => {
  const f = await fixture(t), before = f.store.sequence;
  assert.equal((await f.reads.tip()).highestTip, 1000006);
  assert.equal(f.store.sequence, before + 1);
  await f.reads.tip(); assert.equal(f.store.sequence, before + 1);
  f.head.tip.height--;
  assert.deepEqual(await f.reads.tip(), { tip: 1000005, tipHash: f.head.tip.hash, highestTip: 1000006 });
  assert.equal(f.store.sequence, before + 1);
  f.head.tip.height += 2;
  assert.equal((await f.reads.tip()).highestTip, 1000007);
  assert.equal(f.store.sequence, before + 2);
  await f.reads.close(); f.reads = await productionReads(f.config, f.store);
  await f.reads.tip(); assert.equal(f.store.sequence, before + 2);
});

test('production supply matches balances plus mint escrow and locks, with exact integer burns and restart', async t => {
  const f = await fixture(t), id = '01'.repeat(32), large = 9007199254740993n;
  assert.deepEqual(await f.reads.assetSupply(), {});
  await f.batch([{ op: 'mk', asset: 'p0', amount: large.toString() }, { op: 'ac', assets: [['p0', '12'], ['p1', '4']] },
    { op: 'rq', request: { asset: 'p0', amount: '5' } }, { op: 'mp', id }]);
  // The same units may be in spendable balances, expired/live escrow or HTLCs;
  // reservations, expiry and payment holds do not change their combined sum.
  assert.deepEqual(await f.reads.assetSupply(), { p0: (large + 12n).toString(), p1: '4' });
  await f.batch([{ op: 'xc', request: { in: [['p0', '7'], ['p1', '4']], out: [['c1', '3']] } }, { op: 'mc', id }, { op: 'mc', id }]);
  f.mints.set(id, { s: 1, asset: 'p0', amount: '5' });
  assert.deepEqual(await f.reads.assetSupply(), { p0: large.toString(), c1: '3' });
  await f.reads.close(); f.reads = await productionReads(f.config, f.store);
  await f.batch([{ op: 'mc', id }, { op: 'rx', id: 'expired' }, { op: 'rl', id }, { op: 'kv', key: 'link/1', value: '{}' }]);
  assert.deepEqual(await f.reads.assetSupply(), { p0: large.toString(), c1: '3' });
  f.calls.length = 0;
  assert.deepEqual(await f.reads.assetSupply(), { p0: large.toString(), c1: '3' });
  assert.deepEqual(f.calls.map(c => c[0]), ['batchLast', 'root', 'batchLast'], 'unchanged polls use three keyed reads');
});

test('production supply catchup is bounded, resumes without partial totals and rejects changed/missing evidence', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 33; i++) await f.batch([{ op: 'ac', assets: [['p0', '1']] }]);
  await assert.rejects(f.reads.assetSupply(), /asset_supply_pending/);
  assert.equal(f.calls.filter(c => c[0] === 'root').length, 32);
  assert.equal(f.store.get('prodAssetSupply', 'checkpoint').n, 32);
  assert.deepEqual(await f.reads.assetSupply(), { p0: '33' });
  f.roots.set(33, 'changed'); await assert.rejects(f.reads.assetSupply(), /asset_supply_rewound/);
  f.roots.set(33, String(33).padStart(64, '0'));
  f.last++; await assert.rejects(f.reads.assetSupply(), /asset_supply_batch_missing/);
  assert.equal(f.store.get('prodAssetSupply', 'checkpoint').n, 33);
  f.last--; await f.batch([{ op: 'ac', assets: [['p0', '2']] }]);
  f.roots.set(34, 'wrong'); await assert.rejects(f.reads.assetSupply(), /asset_supply_batch_binding/);
  f.roots.set(34, String(34).padStart(64, '0'));
  assert.deepEqual(await f.reads.assetSupply(), { p0: '35' });
  f.last = 32; await assert.rejects(f.reads.assetSupply(), /asset_supply_rewound/);
});

test('production supply also bounds operations per refresh', async t => {
  const f = await fixture(t), ops = Array.from({ length: 400 }, () => ({ op: 'mk', asset: 'p0', amount: '1' }));
  await f.batch(ops); await f.batch(ops);
  await assert.rejects(f.reads.assetSupply(), /asset_supply_pending/);
  assert.equal(f.store.get('prodAssetSupply', 'checkpoint').n, 1);
  assert.deepEqual(await f.reads.assetSupply(), { p0: '800' });
});

test('production supply equals the local v/e/l sum across real contract transitions', async t => {
  const f = await fixture(t), h = harness();
  const compare = async () => {
    const totals = new Map(), add = (asset, amount) => totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(amount));
    for (const [key, value] of h.db) {
      if (key.startsWith('v/')) add(key.split('/')[2], value);
      if (key.startsWith('e/')) for (const [, amount] of value) add(key.split('/')[2], amount);
      if (key.startsWith('l/') && value?.assets) for (const [asset, amount] of value.assets) add(asset, amount);
      if (key.startsWith('m/')) f.mints.set(key.slice(2), value);
    }
    assert.deepEqual(await f.reads.assetSupply(), Object.fromEntries([...totals].map(([asset, amount]) => [asset, amount.toString()])));
  };
  const batch = async ops => { assert.equal(await h.tickBatch(ops), null); await f.batch(ops); await compare(); };
  await batch([{ op: 'ac', to: alice.address, assets: [['p0', '100']] }]);
  assert.equal(await h.run('tf', { to: bob.address, assets: [['p0', '10']] }), null); await compare();
  assert.equal(await h.run('hl', { to: bob.address, assets: [['p0', '10']], hash: nonce(90), refund: 100 }), null); await compare();
  const request = signedRequest('rq', { owner: alice.address, asset: 'p0', amount: '30', receive: nonce(9), nonce: nonce(1), until: 1000, expires: 20 });
  const id = bytesToHex(requestDigest(deployment.network, 'rq', request.request));
  await batch([request]);
  await h.advance(30); await compare(); // Expired escrow still counts until settled.
  assert.equal(await h.run('rx', { id }), null); await compare();
  await batch([{ op: 'mp', id }]); // Late payment reserves the same units again.
  const consume = { op: 'mc', id, permitHash: nonce(21), payments: [{ key: nonce(20), amount: '100', total: '100' }] };
  await batch([consume]); await batch([consume]);
  await batch([signedRequest('xc', { owner: alice.address, in: [['p0', '5']], out: [['c1', '2']], nonce: nonce(2), until: 1000 })]);
});

test('public views, cache, records and index methods all exist on the production reader and adapter', async t => {
  const f = await fixture(t, true), names = new Set();
  for (const file of ['public-views', 'public-cache', 'web-records', 'public-index']) {
    const source = await readFile(new URL(`../src/${file}.mjs`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\breads(?:\?\.|\.)([A-Za-z]+)\b/g)) if (match[1] !== 'bindings') names.add(match[1]);
  }
  assert.ok(names.has('assetSupply') && names.has('publicTreasury') && names.has('publicTransactions'));
  for (const name of names) assert.equal(typeof f.reads[name], 'function', `production reads.${name}`);
  assert.deepEqual(await f.reads.head(), f.head);
  assert.deepEqual(await f.reads.assetSupply(), {});
});

test('production public transaction pages use bounded pinned contract keys', async t => {
  const f = await fixture(t), row = { tx: 'tx', ipk: 'owner', val: { type: 'tf' }, err: null };
  f.contract.set('txl', 1000000); f.contract.set('txi/999998', row); f.contract.set('txi/999999', row);
  assert.deepEqual(await f.reads.publicTransactions(999998, 2), { rows: [{ index: 999998, ...row }, { index: 999999, ...row }], next: 1000000, total: 1000000 });
  assert.deepEqual(f.calls.filter(c => c[0] === 'read').map(c => c[1]), ['txl', 'txi/999998', 'txi/999999']);
  await assert.rejects(f.reads.publicTransactions(0, 201), /transaction_page/);
  await assert.rejects(f.reads.publicTransactions(1000001, 1), /transaction_index_changed/);
  await assert.rejects(f.reads.publicTransactions(0, 1), /transaction_index_missing/);
});

test('production transaction indexing accepts empty and non-transfer pages before header catchup', async t => {
  const f = await fixture(t), index = new PublicIndex({ store: f.store, reads: f.reads,
    history: { get: () => assert.fail('no new transfer needs a timestamp') } });
  await index.tick();
  f.contract.set('txl', 1); f.contract.set('txi/0', { tx: 'header', val: { type: 'hd' }, err: null });
  await index.tick(); assert.equal(f.store.get('meta', 'publicTransaction'), 1);
});

test('production bitmaps use the configured TAP reader and filter historical transfers', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.reads.bitmaps('unbound'), []);
  assert.equal(f.stamps, undefined, 'unbound agents never check the TAP/Bitcoin tip');
  f.reads.bindings.current = () => ({ request: { address: 'wallet' } });
  await f.store.put('links', heightKey(2), { block: 2 });
  const rows = { 'getBitmapWalletHistoricListLength/wallet': 3, 'getBitmapWalletHistoricList/wallet?offset=0&max=500': ['a', 'b', 'c'],
    'getBitmapByInscription/a': { ownr: 'wallet', ins: 'a', bm: 2 }, 'getBitmapByInscription/b': { ownr: 'elsewhere', ins: 'b', bm: 1 },
    'getBitmapByInscription/c': { ownr: 'wallet', ins: 'c', bm: 0 } };
  f.tap = path => { assert.ok(Object.hasOwn(rows, path), path); return rows[path]; };
  assert.deepEqual(await f.reads.bitmaps('owner'), [{ height: 0, inscription: 'c', linked: false }, { height: 2, inscription: 'a', linked: true }]);
  assert.equal(f.stamps, 2);
  f.tap = () => assert.fail('cached wallet must not call TAP');
  const snapshot = await f.reads.bitmapSnapshot('owner');
  assert.equal(snapshot.bitmapContext.cached, true); assert.equal(f.stamps, 2);
  assert.deepEqual(snapshot.bitmapContext.tip, f.head.tip);
});

test('production public treasury reads configured unique addresses and token with integer precision', async t => {
  const f = await fixture(t), address = '0x' + '44'.repeat(20), large = 9007199254740993n;
  await writeFile(f.config.prod.registry, JSON.stringify({ feePolicy: createFeePolicy('100'), link: { treasury: 'tap-wallet' },
    assets: { p0: { tap: { treasury: 'tap-wallet' }, ethereum: { treasury: address } }, p1: { ethereum: { treasury: address } } } }));
  let tapCalls = 0, ethCalls = 0;
  f.tap = path => { assert.equal(path, 'getBalance/tap-wallet/tap'); tapCalls++; return large.toString(); };
  f.rpc = async (method, [call, block]) => {
    ethCalls++; assert.equal(method, 'eth_call'); assert.equal(call.to, f.config.prod.ethereum.token); assert.equal(block, 'latest');
    return call.data === calldata('totalSupply()', []) ? '0x64' : '0x' + large.toString(16);
  };
  const result = await f.reads.publicTreasury();
  assert.equal(result.treasury.tap, large.toString()); assert.equal(result.treasury.erc20, large.toString());
  assert.equal(result.outstandingSupply.ethereum, '100'); assert.equal(tapCalls, 1); assert.equal(ethCalls, 2);
});

test('production launch registry and ord-tap null balance produce a successful results view', async t => {
  const f = await fixture(t), treasury = 'bc1q' + 'a'.repeat(38);
  // renderConfig() starts with a link treasury and no registered assets.
  // The real ord-tap getBalance route returns {result:null} for an absent key.
  f.config.prod.ethereum.token = '0x5e7f6e008c6d9d7ad4c7eb75bd4ce62864cc7454';
  await writeFile(f.config.prod.registry, JSON.stringify({ feePolicy: createFeePolicy('22600000000000000000'), link: { treasury }, assets: {} }));
  const tap = new TapReader({ sources: [{ request: async path => {
    assert.equal(path, '/r/tap/getBalance/' + treasury + '/tap'); return { result: null };
  } }], agreement: 1 });
  f.tap = path => tap.tap(path);
  f.rpc = async (method, [call, block]) => {
    assert.equal(method, 'eth_call'); assert.equal(call.to, f.config.prod.ethereum.token);
    assert.equal(call.data, calldata('totalSupply()', [])); assert.equal(block, 'latest');
    return '0x' + (21000000n * 10n ** 18n).toString(16).padStart(64, '0');
  };
  const api = createPublicAPI({ views: new PublicViews({ store: f.store, history: fixtureHistory(0), reads: f.reads }) });
  const server = await serve({ intake: { store: f.store }, files: { serve: async () => false }, publicAPI: api });
  t.after(() => server.close());
  const response = await fetch(server.url + '/results', { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.treasury.tap, '0'); assert.equal(result.treasury.erc20, '0');
  assert.deepEqual(result.treasury.tapAccounts, [{ address: treasury, balance: '0' }]);
  assert.equal(result.outstandingSupply.ethereum, '21000000000000000000000000');
});

test('public treasury rejects malformed amounts without disguising upstream errors as zero', async t => {
  const f = await fixture(t);
  await writeFile(f.config.prod.registry, JSON.stringify({ feePolicy: createFeePolicy('100'), link: { treasury: 'wallet' }, assets: {} }));
  f.rpc = async () => '0x0';
  for (const value of [undefined, {}, [], 0, false, '', '-1', '1.5', 'NaN', '0x10']) {
    f.tap = () => value;
    await assert.rejects(f.reads.publicTreasury(), { message: 'treasury_tap_balance', status: 503 });
  }
  const upstream = Error('tap_quorum_unavailable'); f.tap = () => { throw upstream; };
  await assert.rejects(f.reads.publicTreasury(), e => e === upstream);
  f.tap = () => '0';
  for (const value of [null, {}, 0, '', '0x', 'wrong', '-1']) {
    f.rpc = async () => value;
    await assert.rejects(f.reads.publicTreasury(), { message: 'treasury_ethereum_amount', status: 503 });
  }
});

test('production public escrow uses the configured deployment start and rejects reorganized logs', async t => {
  const f = await fixture(t), payer = '0x' + '44'.repeat(20), id = '55'.repeat(32);
  f.config.prod.ethereum.fromBlock = '0x10';
  f.deposit = { address: f.config.prod.ethereum.address, blockNumber: '0x20', deposit: { amount: '7' } };
  const log = { removed: false, address: f.deposit.address, topics: ['event', '0x' + id, '0x' + payer.slice(2).padStart(64, '0')],
    blockNumber: '0x18', blockHash: 'canonical', transactionHash: 'tx', logIndex: '0x0' };
  let canonical = true;
  f.rpc = async (method, [filter]) => {
    if (method === 'eth_getLogs') { assert.equal(filter.fromBlock, '0x10'); assert.equal(filter.toBlock, '0x20'); return [log]; }
    assert.equal(method, 'eth_getBlockByNumber'); return { hash: canonical ? 'canonical' : 'reorg' };
  };
  assert.deepEqual((await f.reads.publicEscrow(payer, id)).transactions, [{ txid: 'tx', blockNumber: '0x18', blockHash: 'canonical', logIndex: '0x0', topic: 'event' }]);
  canonical = false; await assert.rejects(f.reads.publicEscrow(payer, id), /escrow_event_reorg/);
});

test('production public list failures log their cause and recover through the cached production reader', async t => {
  const f = await fixture(t), { store, reads } = f, files = new Files(join(store.directory, 'static'));
  f.rpc = async () => '0x0';
  const { assetSupply, publicTreasury } = reads;
  delete reads.assetSupply; delete reads.publicTreasury;
  const views = new PublicViews({ store, history: fixtureHistory(0), reads }), api = createPublicAPI({ views, files });
  const cache = cachePublicReads(views, { records: async () => ({}) });
  await assert.rejects(cache.catalog.refresh(), /assetSupply is not a function/);
  for (const path of ['/patterns', '/compounds']) await assert.rejects(api.read(path), { name: 'TypeError', message: 'this.reads.assetSupply is not a function' });
  await assert.rejects(api.read('/results'), { name: 'TypeError', message: 'this.reads.publicTreasury is not a function' });
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const server = await serve({ intake: { store }, files, publicAPI: api }); t.after(() => server.close());
  for (const path of ['/patterns', '/compounds', '/results']) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'request_failed' });
  }
  assert.ok(logs.some(line => line.includes('assetSupply is not a function')));
  assert.ok(logs.some(line => line.includes('publicTreasury is not a function')));
  Object.assign(reads, { assetSupply, publicTreasury });
  await cache.catalog.refresh();
  for (const path of ['/patterns', '/compounds', '/results']) assert.equal((await fetch(server.url + path)).status, 200);
  const results = await api.read('/results');
  assert.deepEqual(results.treasury, { bitcoin: null, ethereum: null, tap: '0', erc20: '0', tapAccounts: [], ethereumAccounts: [],
    counts: { tapAccounts: 0, ethereumAccounts: 0 }, pages: results.treasury.pages });
  assert.equal(results.outstandingSupply.ethereum, '0');
});

test('production supply retries a failed checkpoint without losing or duplicating the burn', async t => {
  const f = await fixture(t), id = '02'.repeat(32);
  await f.batch([{ op: 'ac', assets: [['p0', '10']] }]);
  assert.deepEqual(await f.reads.assetSupply(), { p0: '10' });
  await f.batch([{ op: 'mc', id }]);
  f.mints.set(id, { s: 1, asset: 'p0', amount: '3' });
  const transact = f.store.transact.bind(f.store);
  f.store.transact = async () => { throw Error('commit_failed'); };
  await assert.rejects(f.reads.assetSupply(), /commit_failed/);
  assert.equal(f.store.get('prodAssetSupply', 'checkpoint').n, 1);
  assert.equal(f.store.get('prodAssetSupplyBurns', id), null);
  f.store.transact = transact;
  assert.deepEqual(await f.reads.assetSupply(), { p0: '7' });
  await f.reads.close(); f.reads = await productionReads(f.config, f.store);
  assert.deepEqual(await f.reads.assetSupply(), { p0: '7' });
  assert.equal(f.store.get('prodAssetSupplyBurns', id), true);
});
