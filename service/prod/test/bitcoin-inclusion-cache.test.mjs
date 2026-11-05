import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BitcoinSource } from '../bitcoin.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/ord-regtest.json', import.meta.url)));
function sourceFixture() {
  const f = structuredClone(fixture), requests = [], txid = Object.keys(f.transactions)[1];
  let canonical = f.hash;
  const client = new BitcoinSource({ network: 'regtest', source: { request: async path => {
    requests.push(path);
    if (path.startsWith('/inscription/')) return { id: path.slice(13), height: f.height };
    if (path === '/r/blockhash/' + f.height) return canonical;
    if (path === '/r/blockinfo/' + f.hash) return f.info;
    if (path === '/block/' + f.hash) return f.block;
    if (path.startsWith('/r/tx/')) return f.transactions[path.slice(6)];
    throw Error('unexpected_route');
  } } });
  const at = { tip: f.height, tipHash: f.hash }, history = { length: f.height + 1, hashAt: () => f.hash };
  return { f, client, requests, txid, at, history, orphan: () => { canonical = 'ff'.repeat(32); } };
}

test('concurrent inscriptions and fresh financial snapshots share only the verified block', async () => {
  const f = sourceFixture(), included = i => f.client.included(f.txid + 'i' + i, f.at, f.history);
  const proofs = await Promise.all(Array.from({ length: 44 }, (_, i) => included(i)));
  assert.ok(proofs.every(p => p.confirmations === 1 && p.blockHash === f.f.hash));
  assert.equal(f.requests.filter(p => p.startsWith('/block/')).length, 1);
  assert.equal(f.requests.filter(p => p.startsWith('/r/blockinfo/')).length, 1);
  assert.equal(f.requests.filter(p => p.startsWith('/r/tx/')).length, 44, 'raw witness binding is still checked per read');
  assert.equal(f.requests.filter(p => p.startsWith('/r/blockhash/')).length, 132, 'canonical fences are never cached');
  proofs[0].tx.hex = '00';
  assert.equal((await included(0)).tx.hex, f.f.transactions[f.txid]);
  f.orphan(); assert.equal(await included(0), null);
  assert.equal(f.requests.filter(p => p.startsWith('/block/')).length, 1);
});

test('cached blocks cannot authorize corrupt transaction witnesses, missing transactions or a different retained branch', async () => {
  const f = sourceFixture(), id = f.txid + 'i0';
  await f.client.included(id, f.at, f.history);
  const raw = f.f.transactions[f.txid];
  f.f.transactions[f.txid] = raw.slice(0, -12) + (raw.slice(-12, -10) === '00' ? '01' : '00') + raw.slice(-10);
  assert.equal(f.client.decode(f.f.transactions[f.txid]).txid, f.txid);
  await assert.rejects(f.client.included(id, f.at, f.history), /bitcoin_tx_witness_binding/);
  f.f.transactions[f.txid] = raw;
  await assert.rejects(f.client.included(id, f.at, { ...f.history, hashAt: () => 'ff'.repeat(32) }), /bitcoin_view/);
  f.f.transactions[f.txid] = undefined;
  await assert.rejects(f.client.included(id, f.at, f.history), /bitcoin_transaction/);
});

test('new tips recompute depth and an intervening reorg still refuses cached membership', async () => {
  const f = sourceFixture(), id = f.txid + 'i0';
  await f.client.included(id, f.at, f.history);
  const request = f.client.source.request, tip = f.at.tip + 1, tipHash = 'ab'.repeat(32);
  let reorg = false;
  f.client.source.request = async path => {
    if (path === '/r/blockhash/' + tip) return tipHash;
    const value = await request(path);
    if (reorg && path.startsWith('/r/tx/')) f.orphan();
    return value;
  };
  const history = { length: tip + 1, hashAt: n => n === tip ? tipHash : f.f.hash };
  assert.equal((await f.client.included(id, { tip, tipHash }, history)).confirmations, 2);
  reorg = true;
  assert.equal(await f.client.included(id, { tip, tipHash }, history), null);
  assert.equal(f.requests.filter(p => p.startsWith('/block/')).length, 1);
});

test('invalid block witnesses never enter the cache and a repaired source can retry', async () => {
  const f = sourceFixture(), witness = f.f.block.transactions[1].input[0].witness[0];
  f.f.block.transactions[1].input[0].witness[0] = '00'.repeat(64);
  const include = () => f.client.included(f.txid + 'i0', f.at, f.history);
  await assert.rejects(include(), /bitcoin_witness_commitment/);
  f.f.block.transactions[1].input[0].witness[0] = witness;
  assert.equal((await include()).blockHash, f.f.hash);
  await include(); assert.equal(f.requests.filter(p => p.startsWith('/block/')).length, 2);
});

test('verified block retention is bounded by count and bytes, with immutable results and retryable failures', async () => {
  const client = new BitcoinSource({ source: {}, network: 'regtest' }), reads = [];
  let bytes = 2, fail = false;
  client.block = async hash => {
    reads.push(hash); if (fail) throw Error('unavailable');
    return { hash, raw: '00'.repeat(80), tx: ['01'.repeat(32)], transactions: ['00'.repeat(bytes)] };
  };
  for (let i = 0; i < 5; i++) await client.inclusionBlock(String(i));
  await client.inclusionBlock('4'); assert.equal(reads.length, 5);
  await client.inclusionBlock('0'); assert.equal(reads.length, 6, 'fifth block evicts oldest');
  const block = await client.inclusionBlock('0');
  assert.throws(() => { block.transactions[0] = 'ff'; }, TypeError);
  bytes = 2_000_000;
  await client.inclusionBlock('large-a'); await client.inclusionBlock('large-b');
  const before = reads.length; await client.inclusionBlock('large-a');
  assert.equal(reads.length, before + 1, 'two large blocks exceed the byte budget');
  bytes = 4_000_000;
  await client.inclusionBlock('oversized'); await client.inclusionBlock('oversized');
  assert.equal(reads.filter(h => h === 'oversized').length, 2, 'oversized values are not retained');
  fail = true; await assert.rejects(client.inclusionBlock('failure'), /unavailable/);
  fail = false; await client.inclusionBlock('failure'); assert.equal(reads.filter(h => h === 'failure').length, 2);
});

test('transaction membership survives full-block eviction across preparation retries', async () => {
  const f = sourceFixture(), hashes = Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(64, '0'));
  const headers = new Map(hashes.map((hash, i) => [i, hash])), raw = f.f.transactions[f.txid], blocks = [];
  f.client.source.request = async path => {
    if (path.startsWith('/inscription/')) return { id: path.slice(13), height: Number(path.split('i').at(-1)) };
    if (path.startsWith('/r/blockhash/')) return headers.get(Number(path.split('/').at(-1)));
    if (path.startsWith('/r/tx/')) return raw;
    throw Error('unexpected_route');
  };
  // Supply the independently verified block boundary; the real ord block and
  // witness verifier is exercised above with captured bytes and corruption.
  f.client.block = async hash => {
    blocks.push(hash);
    return { hash, height: hashes.indexOf(hash), raw: '00'.repeat(80), tx: [f.txid], transactions: [raw] };
  };
  const history = { length: 8, hashAt: h => headers.get(h) }, at = { tip: 7, tipHash: hashes[7] };
  const prepare = async () => { for (let i = 0; i < 8; i++) assert.equal((await f.client.included(f.txid + 'i' + i, at, history)).height, i); };
  await prepare(); assert.equal(blocks.length, 8);
  await prepare(); assert.equal(blocks.length, 8, 'compact proofs survive the four-block cache');
  for (let i = 8; i < 513; i++) { const hash = String(i + 1).padStart(64, '0'); hashes.push(hash); headers.set(i, hash); }
  const longer = { length: 513, hashAt: h => headers.get(h) }, later = { tip: 512, tipHash: hashes[512] };
  for (let i = 8; i < 513; i++) await f.client.included(f.txid + 'i' + i, later, longer);
  assert.equal(blocks.length, 513);
  await f.client.included(f.txid + 'i0', later, longer);
  assert.equal(blocks.length, 514, 'compact proofs are bounded to 512 transactions');
  headers.set(0, 'ff'.repeat(32));
  assert.equal(await f.client.included(f.txid + 'i0', at, { ...history, hashAt: h => hashes[h] }), null);
});

test('compact inclusion proofs also obey a byte budget', async () => {
  const f = sourceFixture(), raw = '00'.repeat(2_000_000), blocks = [], hashes = ['01', '02'].map(v => v.repeat(32));
  f.client.source.request = async path => {
    if (path.startsWith('/inscription/')) return { id: path.slice(13), height: Number(path.split('i').at(-1)) };
    if (path.startsWith('/r/blockhash/')) return hashes[Number(path.split('/').at(-1))];
    throw Error('unexpected_route');
  };
  f.client.transaction = async txid => ({ txid, hex: raw });
  f.client.block = async hash => { blocks.push(hash); return { hash, height: hashes.indexOf(hash), raw: '00'.repeat(80), tx: [f.txid], transactions: [raw] }; };
  const history = { length: 2, hashAt: h => hashes[h] }, at = { tip: 1, tipHash: hashes[1] };
  for (const i of [0, 1, 0]) await f.client.included(f.txid + 'i' + i, at, history);
  assert.equal(blocks.length, 3, 'two large proofs exceed the byte budget');
});
