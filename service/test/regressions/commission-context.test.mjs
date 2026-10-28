import { bindingFixture } from '../bindings-fixture.mjs';
import { createFeePolicy } from '../../src/fees.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Store } from '../../src/store.mjs';
import { rules } from '../../src/rules.mjs';
import { hash, heightKey } from '../../src/util.mjs';
import { withTapSource, temp, agent } from '../helpers.mjs';
import { BitcoinViews } from '../../prod/bitcoin.mjs';
const { secp256k1 } = createRequire(new URL('../../../local/package.json', import.meta.url))('@noble/curves/secp256k1');
const privilege = 'ac'.repeat(32) + 'i0', deployment = 'ad'.repeat(32) + 'i0', key = Buffer.alloc(32, 3);
const auth = { auth: { fixture: true }, salt: 'local' }; auth.hash = hash(JSON.stringify(auth.auth) + auth.salt);
const signature = secp256k1.sign(auth.hash, key); auth.sig = { r: signature.r.toString(), s: signature.s.toString(), v: signature.recovery };
const publicKey = Buffer.from(secp256k1.getPublicKey(key)).toString('hex');
mock.module('../../prod/bitcoin.mjs', { exports: { BitcoinViews, createBitcoin: async () => ({ kind: 'ord', network: 'regtest', source: { request: async path => {
  if (path.startsWith('/content/')) return JSON.stringify(auth);
  return { result: path.includes('getDeployment/') ? { ins: deployment, prv: privilege, dec: 0 } : path.includes('getPrivilegeAuthList') ? [{ ins: privilege }] : '100' };
} } }) } });
const { localReads } = await import('../../local/reads.mjs');
function deploymentEvidence(reads) {
  const element = 'ae'.repeat(32) + 'i0', originalTap = reads.tap;
  reads.withTapSnapshot = async (_view, fn) => fn();
  reads.element = async () => ({ ins: element, tick:'fixture-element', pat:'[0-9]', fld:4 });
  reads.privilegeAuthority = async () => ({ ins:privilege });
  reads.tip = async () => ({ tip: 100 });
  reads.included = async () => ({ confirmations: 20, height: 81, blockHash: hash('deployment-block') });
  reads.content = async id => {
    if (id === privilege) return auth;
    if (id === element) return 'fixture-element.[0-9].4.element';
    const entry = Object.values((await reads.registry()).assets).find(e => e.id === id);
    return entry.kind === 'dmt' ? { p: 'tap', op: 'dmt-deploy', tick: entry.tick, elem: element, dt: entry.pattern.dt, prv: privilege } : { p: 'tap', op: 'token-deploy', tick: entry.tick, prv: privilege, max: '18446744073709551615', dec: '0' };
  };
  reads.tap = async path => {
    if (path.startsWith('getPrivilegeAuthCancelled/')) return false;
    if (path === 'getCurrentBlock') return 100;
    if (path === 'getDmtElementsListLength') return 1;
    if (path.startsWith('getDmtElementsList?')) return [{ ins: element, tick: 'fixture-element', pat: '[0-9]', fld: 4 }];
    if (path.startsWith('getDeployment/')) {
      const entry = Object.values((await reads.registry()).assets).find(e => (e.indexTick ?? e.tick) === path.slice(14));
      return { ins: entry.id, prv: privilege, tick: entry.indexTick ?? entry.tick, dec: '0', elem: element, dt: entry.pattern?.dt, max: '18446744073709551615' };
    }
    return originalTap(path);
  };
}
test('concrete reads resolve audited finder, discoverer and first-maker bindings on both rails', async () => {
  const directory = await temp('attribution-'), store = await Store.open(join(directory, 'data'));
  const fixture = bindingFixture(store);
  const owner = agent(1).address, discoverer = agent(2).address, otherMaker = agent(3).address, block = 5, findId = rules.findId(block, 0);
  const file = { v: 4, observation: 1, height: 10, settlements: [{ window: 1, complete: true, winners: [{ id: findId, block, pattern: 0, asset: 'p0', count: 1, winner: owner, source: 'claim' }] }],
    discoveries: [{ record: { number: 0, discoverer } }], crafts: [{ id: 'c1', firstMaker: owner }] };
  const bytes = rules.encodeBinary(file), root = rules.merkleRoot([bytes]);
  const endpoints = { bitcoind: 'http://127.0.0.1:18443', indexer: 'http://127.0.0.1:55888', trac: 'http://127.0.0.1:59000', ethereum: 'http://127.0.0.1:58545' };
  const config = { network: 'dmw-regtest', committee: fixture.config, data: store.directory, endpoints, local: { manifest: join(directory, 'manifest.json'), registry: join(directory, 'registry.json'), escrow: { chainId: '31337', address: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20) } } };
  const f = mock.method(globalThis, 'fetch', async (url, options) => {
    const value = String(url).includes('/content/') ? auth : { result: JSON.parse(options.body).method === 'root' ? root : JSON.parse(options.body).method === 'record' ? null : { committee: publicKey } };
    return new Response(JSON.stringify(value));
  });
  let reads;
  try {
    await mkdir(join(store.directory, 'static', 'blocks'), { recursive: true }); await writeFile(join(store.directory, 'static', 'blocks', 'attribution.bin'), bytes);
    await writeFile(config.local.manifest, JSON.stringify({ bitcoin: { rpc: endpoints.bitcoind }, ord: { url: endpoints.indexer } }));
    await writeFile(config.local.registry, JSON.stringify({ feePolicy: createFeePolicy('100'), assets: {
      p0: { id: deployment, tick: 'digit', indexTick: 'dmt-digit', kind: 'dmt', privilege, pattern: { number: 0, pat: '[0-9]', fld: 4, dt: 'n' }, tap: { treasury: 'treasury' }, ethereum: { treasury: '0x' + '11'.repeat(20) } },
      c1: { id: 'af'.repeat(32) + 'i0', tick: 'compound', kind: 'compound', privilege, firstMaker: otherMaker, tap: { treasury: 'treasury' }, ethereum: { treasury: '0x' + '11'.repeat(20) } }
    } }));
    await store.transact([
      { space: 'meta', id: 'patterns', value: [{ number: 0, discoverer }] }, { space: 'patternProvenance', id: 'p0', value: 1 },
      { space: 'types', id: 'c1', value: { firstMaker: owner } }, { space: 'typeProvenance', id: 'c1', value: 1 },
      { space: 'finds', id: findId, value: { block, pattern: 0, asset: 'p0', count: 1, finder: owner, findHeight: 10, window: 1, source: 'claim' } }, { space: 'findProvenance', id: findId, value: 1 },
      { space: 'batches', id: heightKey(1), value: { batch: { root }, publications: [{ audit: { path: '/blocks/attribution.bin' } }] } },
    ]);
    const expected = {};
    for (const rail of ['tap', 'ethereum']) {
      expected[rail] = { finder: (await fixture.bind(agent(1), rail)).request.address, discoverer: (await fixture.bind(agent(2), rail)).request.address };
    }
    reads = await localReads(await withTapSource(config), store); deploymentEvidence(reads);
    for (const rail of ['tap', 'ethereum']) {
      const context = await reads.assetContext('p0', block, rail);
      assert.equal(context.finderAddress, expected[rail].finder); assert.equal(context.discoverer, expected[rail].discoverer);
      assert.equal((await reads.assetContext('c1', undefined, rail)).firstMakerAddress, expected[rail].finder, 'registry attribution cannot replace the accepted first maker');
    }
    await store.put('types', 'c1', { firstMaker: otherMaker }); await assert.rejects(reads.assetContext('c1', undefined, 'tap'), /first_maker_binding/);
    await store.put('patternProvenance', 'p0'); await assert.rejects(reads.assetContext('p0', block, 'tap'), /pattern_provenance_missing/);
  } finally { reads?.close(); f.mock.restore(); await store.close(); }
});

test('local reader returns no find for an unclaimed historical slot', async () => {
  const directory = await temp('no-finder-read-'), store = await Store.open(join(directory, 'data'));
  const endpoints = { bitcoind: 'http://127.0.0.1:18443', indexer: 'http://127.0.0.1:55888', trac: 'http://127.0.0.1:59000', ethereum: 'http://127.0.0.1:58545' };
  const config = { data: store.directory, endpoints, local: { manifest: join(directory, 'manifest.json'), registry: join(directory, 'registry.json'), escrow: { chainId: '31337', address: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20) } } };
  let reads;
  const fetch = mock.method(globalThis, 'fetch', async (_url, options) => Response.json({ result: JSON.parse(options.body).method === 'record' ? null : { committee: publicKey } }));
  try {
    await writeFile(config.local.manifest, JSON.stringify({ bitcoin: { rpc: endpoints.bitcoind }, ord: { url: endpoints.indexer } }));
    await writeFile(config.local.registry, JSON.stringify({ feePolicy: createFeePolicy('100'), assets: { p0: { id: deployment, tick: 'digit', kind: 'dmt', privilege, pattern: { number: 0, pat: '[0-9]', fld: 4, dt: 'n' }, tap: { treasury: 'treasury' } } } }));
    reads = await localReads(await withTapSource(config), store); deploymentEvidence(reads);
    const context = await reads.assetContext('p0', 5, 'tap');
    assert.equal(context.find, null); assert.equal(context.finderAddress, null);
  } finally { reads?.close(); fetch.mock.restore(); await store.close(); }
});
