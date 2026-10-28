import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TapReader } from '../tap.mjs';
import { inscriptionContents } from '../../src/mint-payments.mjs';
import { BitcoinSource, ordHeader, ordTransaction, BitcoinViews } from '../bitcoin.mjs';
import { REGTEST_PARAMS } from '../../../contract/beacon/bitcoin.js';
import { genesisInfo, genesisBlock, genesisTx, genesisTxid } from './helpers.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/ord-regtest.json', import.meta.url)));
function setup() {
  const f = structuredClone(fixture), requests = [], inscription = Object.keys(f.transactions)[1] + 'i0';
  let missing = false, canonical = true;
  const source = { request: async path => {
    requests.push(path);
    if (path === '/r/blockheight') return f.height;
    if (path === '/r/blockhash' || path === '/r/blockhash/' + f.height) return canonical ? f.hash : 'ff'.repeat(32);
    if (path === '/r/blockinfo/' + f.hash) return f.info;
    if (path === '/block/' + f.hash) return f.block;
    if (path.startsWith('/r/tx/')) return f.transactions[path.slice(6)];
    if (path === '/inscription/' + inscription) { if (missing) throw Object.assign(Error('http_status'), { status: 404 }); return { id: inscription, height: f.height }; }
    throw Error('unexpected_route');
  } };
  const client = new BitcoinSource({ source, network: 'regtest' });
  const history = { length: f.height + 1, hashAt: n => n === f.height ? f.hash : null };
  return { f, client, requests, inscription, history, missing: () => { missing = true; }, orphan: () => { canonical = false; } };
}
test('captured ord blockinfo serializes the exact 80-byte header and validates PoW', () => {
  const { info, hash, rawBlock } = fixture;
  assert.equal(ordHeader(info, hash, REGTEST_PARAMS), rawBlock.slice(0, 160));
  for (const field of ['version', 'timestamp', 'bits', 'nonce']) assert.throws(() => ordHeader({ ...info, [field]: info[field] + 1 }, hash, REGTEST_PARAMS));
  assert.throws(() => ordHeader({ ...info, previous_block: null }, hash, REGTEST_PARAMS));
  assert.throws(() => ordHeader(info, hash), /bitcoin_pow/);
});
test('captured ord block JSON derives ordered txids; r/tx is a JSON hex string; reconstructed block is byte-exact', async () => {
  const { client, f, requests } = setup();
  assert.deepEqual(await client.tip(), { height: f.height, hash: f.hash });
  assert.deepEqual((await client.block(f.hash)).tx, Object.keys(f.transactions));
  for (const tx of f.block.transactions) { const raw = ordTransaction(tx), decoded = client.decode(raw); assert.equal(raw, f.transactions[decoded.txid]); }
  assert.equal((await client.rawBlock(f.hash)).toString('hex'), f.rawBlock);
  assert.ok(requests.every(p => p.startsWith('/r/') || p.startsWith('/block/')));
});
test('ordered transaction corruption, duplicates, truncation, raw identity and malformed shapes fail closed', async () => {
  for (const mutate of [f => f.block.transactions.reverse(), f => f.block.transactions.pop(), f => { f.block.transactions[1] = f.block.transactions[0]; }, f => { f.block.transactions[0].output[0].value++; }]) {
    const { client, f } = setup(); mutate(f); await assert.rejects(client.block(f.hash));
  }
  const { client, f } = setup(), ids = Object.keys(f.transactions); f.transactions[ids[1]] = f.transactions[ids[0]];
  await assert.rejects(client.transaction(ids[1]), /bitcoin_tx_binding/);
  assert.throws(() => client.decode('00'), /bitcoin_transaction/);
  assert.throws(() => ordTransaction({ ...f.block.transactions[0], version: '2' }), /bitcoin_transaction_shape/);
});
test('inscription height is a lookup hint; only proven membership and the supplied linked branch determine depth', async () => {
  const { client, f, inscription, history, orphan } = setup();
  f.info.confirmations = 999999;
  const inclusion = await client.included(inscription, { tip: f.height, tipHash: f.hash }, history);
  assert.equal(inclusion.confirmations, 1);
  orphan(); assert.equal(await client.included(inscription, { tip: f.height, tipHash: f.hash }, history), null);
  const absent = setup(); absent.missing(); assert.equal(await absent.client.included(absent.inscription), null);
  const mismatch = setup(); await assert.rejects(mismatch.client.included(mismatch.inscription, { tip: f.height, tipHash: f.hash }, { ...history, hashAt: () => 'ff'.repeat(32) }), /bitcoin_view/);
});
test('mainnet genesis validates through ord shapes and no Core or Esplora client can be constructed', async () => {
  const source = { request: async path => path.startsWith('/r/blockinfo/') ? genesisInfo : path.startsWith('/block/') ? genesisBlock : path.startsWith('/r/tx/') ? genesisTx : genesisInfo.hash };
  const client = new BitcoinSource({ source }); await client.verifyNetwork();
  assert.equal((await client.block(genesisInfo.hash)).tx[0], genesisTxid);
  for (const kind of ['core', 'esplora']) assert.throws(() => new BitcoinSource({ source, kind }), /bitcoin_source/);
  assert.equal(client.rpc, undefined);
  const views = new BitcoinViews(client, ':memory:');
  try { assert.equal((await views.view(0, genesisInfo.hash)).hashAt(0), genesisInfo.hash); } finally { views.close(); }
});

test('real ord redeem envelopes preserve a zero pointer tag before the body delimiter', async () => {
  const tx = JSON.parse(await readFile(new URL('./fixtures/ord-redeem-raw.json', import.meta.url)));
  const parsed = inscriptionContents(tx.hex);
  assert.equal(parsed.txid, tx.txid); assert.equal(parsed.contents.length, 1);
  assert.equal(parsed.contents[0].op, 'token-auth'); assert.equal(parsed.contents[0].redeem.items.length, 3);
});
test('witness corruption is rejected even when txids and the header merkle root still match', async () => {
  const { client, f } = setup(); f.block.transactions[1].input[0].witness[0] = '00'.repeat(64);
  await assert.rejects(client.block(f.hash), /bitcoin_witness_commitment/);
});

test('captured inscription and raw transaction routes bind to the same verified block', async () => {
  const routes = JSON.parse(await readFile(new URL('./fixtures/ord-routes.json', import.meta.url)));
  const [insPath, inscription] = Object.entries(routes).find(([path]) => path.startsWith('/inscription/'));
  const [blockPath, block] = Object.entries(routes).find(([path]) => path.startsWith('/block/'));
  routes['/r/blockhash/' + inscription.height] = block.hash;
  const client = new BitcoinSource({ network: 'regtest', policy: { proofBytes: 0, transactionBytes: 0 }, source: { request: async path => { assert.ok(Object.hasOwn(routes, path), path); return routes[path]; } } });
  const at = { tip: inscription.height, tipHash: block.hash }, history = { length: at.tip + 1, hashAt: n => n === at.tip ? at.tipHash : null };
  assert.equal((await client.included(inscription.id, at, history)).confirmations, 1);
  assert.equal((await client.transaction(inscription.id.slice(0, 64))).txid, inscription.id.slice(0, 64));
  routes[insPath] = { ...inscription, id: '00'.repeat(32) + 'i0' };
  await assert.rejects(client.included(inscription.id, at, history), /bitcoin_inscription_binding/);
  routes[insPath] = inscription;
  const raw = routes['/r/tx/' + inscription.id.slice(0, 64)];
  // Change only a witness byte, leaving the txid unchanged.
  const changed = raw.slice(0, -12) + (raw.slice(-12, -10) === '00' ? '01' : '00') + raw.slice(-10);
  assert.equal(client.decode(changed).txid, inscription.id.slice(0, 64));
  routes['/r/tx/' + inscription.id.slice(0, 64)] = changed;
  await assert.rejects(client.included(inscription.id, at, history), /bitcoin_tx_witness_binding/);
});

test('captured ord content routes preserve plain element text and decode JSON mint content', async () => {
  const routes = JSON.parse(await readFile(new URL('./fixtures/ord-routes.json', import.meta.url)));
  const reader = new TapReader({ agreement: 1, sources: [{ request: async (path, options) => { assert.equal(options.format, 'rawText'); assert.equal(options.maxBytes, 200000); return routes[path]; } }] });
  const contents = await Promise.all(Object.keys(routes).filter(p => p.startsWith('/content/')).map(p => reader.content(p.slice(9))));
  assert.ok(contents.includes('reader.[0-9].4.element')); assert.ok(contents.some(c => c?.op === 'token-mint'));
});

test('linked header history retains PoW, retarget, parent and median-time checks', async () => {
  const { mine } = await import('../../../contract/tests/helpers/chain.mjs');
  const { parseHeader, retargetBits, targetFromBits } = await import('../../../contract/beacon/bitcoin.js');
  const params = { ...REGTEST_PARAMS, interval: 2, timespan: 1200, retarget: true };
  const raw = mine('00'.repeat(32), 1000), genesis = parseHeader(raw), views = new BitcoinViews({ params, genesis: genesis.hash }, ':memory:');
  try {
    const parent = views.insert(raw, 0), childRaw = mine(genesis.hash, 1600), child = views.insert(childRaw, 1, parent);
    const expectedBits = retargetBits(genesis.bits, 600, params);
    assert.throws(() => views.insert(mine(child.hash, 2200, genesis.bits), 2, child), /bitcoin_difficulty/);
    assert.throws(() => views.insert(mine(child.hash, 1600, expectedBits), 2, child), /bitcoin_time/);
    assert.throws(() => views.insert(mine('00'.repeat(32), 2200, expectedBits), 2, child), /bitcoin_link/);
    const boundary = views.insert(mine(child.hash, 2200, expectedBits), 2, child); assert.equal(boundary.periodTime, 2200);
    const invalid = Buffer.from(childRaw, 'hex');
    do { invalid.writeUInt32LE(invalid.readUInt32LE(76) + 1, 76); } while (BigInt('0x' + parseHeader(invalid.toString('hex')).hash) <= targetFromBits(genesis.bits));
    assert.throws(() => views.insert(invalid.toString('hex'), 1, parent), /bitcoin_pow/);
  } finally { views.close(); }
});
