import { createLocalReads } from '../../../committee/signer/reads.mjs';
import { bindingFixture } from '../bindings-fixture.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Store } from '../../src/store.mjs';
import { BitcoinViews } from '../../prod/bitcoin.mjs';
import { REGTEST_PARAMS } from '../../../contract/beacon/bitcoin.js';
import { rules } from '../../src/rules.mjs';
import { withTapSource, temp, agent, fixtureHistory, network, secret, gateway } from '../helpers.mjs';
import { hash } from '../../src/util.mjs';
import { FeeQuotes, changeBaseFee, createFeePolicy } from '../../src/fees.mjs';

const history = fixtureHistory(20), lockTx = 'ab'.repeat(32), releaseTx = 'cd'.repeat(32), lockId = lockTx + 'i0:0';
let lock, consumed, bitmap, inscriptionOwner, id, previous = null;
const client = { kind: 'ord', network: 'regtest', params: REGTEST_PARAMS, genesis: history.hashAt(0),
  tip: async () => ({ height: 15, hash: history.hashAt(15) }), blockHash: async n => history.hashAt(n),
  header: async id => history.raw(Array.from({ length: history.length }, (_, i) => i).find(n => history.hashAt(n) === id)),
  included: async id => { const n = id.startsWith(lockTx) ? 4 : 10; return { height: n, blockHash: history.hashAt(n), confirmations: 15 - n + 1 }; },
  block: async () => ({ tx: [lockTx] }),
  source: { request: async path => {
    if (path.startsWith('/content/')) return JSON.stringify({ redeem: { data: id } });
    if (path.startsWith('/inscription/')) return { address: inscriptionOwner };
    return { result: path.includes('getBitmap/') ? bitmap : path.includes('getLockConsume/') ? consumed : path.includes('getLock/') ? lock : null };
  } }
};
mock.module('../../prod/bitcoin.mjs', { exports: { BitcoinViews, createBitcoin: async () => client } });
const { localReads } = await import('../../local/reads.mjs');

test('independent link reads follow current Bitmap ownership and bind every actual release allocation', async () => {
  const root = await temp('link-reads-'), store = await Store.open(join(root, 'data')), who = agent(31), other = agent(32);
  const fixture = bindingFixture(store), holder = (await fixture.bind(who, 'tap')).request.address, nextHolder = (await fixture.bind(other, 'tap')).request.address;
  const request = { owner: who.address, height: 1, nonce: hash('reader-link'), until: 50 }; id = rules.linkId(network, request);
  const terms = { payer: 'local-payer', treasury: 'local-treasury', hash: hash('payer-preimage'), baseFee: '100' }, row = { id, request, sig: rules.signLink(network, request, who.secret), terms, paymentId: lockId };
  const allocation = { tt: 'b', to: '1BitcoinEaterAddressDontSendf59kuE', amt: '1000', rl: 'bn' };
  lock = { owner: terms.payer, total: '2000', tick: 'tap', kind: 'htlc', condition: { type: 'hashlock', hash: terms.hash }, refund: terms.payer, claim: terms.treasury, amt: '1000', al: [allocation], refund_after: '200' };
  consumed = { lock: lockId, action: 'claim', kind: 'htlc', owner: terms.payer, target: terms.treasury, tick: 'tap', amt: '1000', total: '2000', al: [allocation], ins: releaseTx + 'i0' };
  bitmap = { bm: 1, ins: 'ef'.repeat(32) + 'i0', ownr: holder }; inscriptionOwner = bitmap.ownr;
  const endpoints = { bitcoind: 'http://127.0.0.1:18443', indexer: 'http://127.0.0.1:55888', trac: 'http://127.0.0.1:59000', ethereum: 'http://127.0.0.1:58545' };
  const config = { committee: fixture.config, data: store.directory, network, endpoints, local: { manifest: join(root, 'manifest.json'), registry: join(root, 'registry.json'), escrow: { chainId: '31337', address: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20) } } };
  const document = rules.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...rules.SETTINGS_PROFILE } });
  const fetch = mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/content/')) return Response.json({ redeem: { data: id } });
    const { method, args } = JSON.parse(options.body);
    if (method === 'settingsByHash') {
      assert.deepEqual(args, [rules.hashObject(document)], 'the real local Trac client must receive one hash argument');
      return Response.json({ result: document });
    }
    return Response.json({ result: method === 'record' ? previous : { counted: 10, tip: { height: 15, hash: history.hashAt(15) } } });
  });
  let reads;
  try {
    await writeFile(config.local.manifest, JSON.stringify({ bitcoin: { rpc: endpoints.bitcoind }, ord: { url: endpoints.indexer } }));
    await writeFile(config.local.registry, JSON.stringify({ feePolicy: createFeePolicy('100'), link: { treasury: terms.treasury } }));
    const registry = () => readFile(config.local.registry, 'utf8').then(JSON.parse);
    const issuer = new FeeQuotes({ network, secret, registry });
    const q = await issuer.issue('link/' + id, 10);
    const feeAuthorization = await issuer.accept(q, 'link/' + id, id, request.until, 10);
    terms.feeAuthorization = feeAuthorization;
    await store.put('linkRequests', id, row); reads = await localReads(await withTapSource(config), store, { gateway });
    assert.deepEqual(await reads.settingsByHash(rules.hashObject(document)), document);
    const signerReads = createLocalReads({ records: reads });
    for (const segment of [undefined, '0', '1']) {
      const key = `15/${history.hashAt(15)}${segment === undefined ? '' : '/' + segment}`;
      const observation = { seal: { segment: segment ?? 'legacy' }, receipts: [] }, certificate = { ...observation, attestations: [] };
      await store.put('receiptObservations', key, observation);
      await store.put('receiptCertificates', key, certificate);
      assert.deepEqual(await reads.receiptObservation(15, history.hashAt(15), segment), observation);
      assert.deepEqual(await reads.receiptCertificate(15, history.hashAt(15), segment), certificate);
      assert.deepEqual(await signerReads.receiptObservation(15, history.hashAt(15), segment), observation);
      assert.deepEqual(await signerReads.receiptCertificate(15, history.hashAt(15), segment), certificate);
    }
    await assert.rejects(signerReads.receiptObservation(15, history.hashAt(15), '2'), /receipt_observation_missing/);
    assert.equal(await signerReads.receiptCertificate(15, history.hashAt(15), '2'), null);
    assert.deepEqual(await reads.bitmap(1), { agent: who.address, address: holder });
    bitmap.ownr = inscriptionOwner = nextHolder; assert.equal((await reads.bitmap(1)).agent, other.address);
    inscriptionOwner = 'different'; await assert.rejects(reads.bitmap(1), /bitmap_owner/); inscriptionOwner = bitmap.ownr;
    assert.equal(await reads.link(1), null); previous = JSON.stringify({ block: 1, linkHeight: 10 }); assert.deepEqual(await reads.link(1), { block: 1, linkHeight: 10 });
    assert.deepEqual(await reads.linkTerms(id, request), terms);
    await store.put('linkRequests', id, { ...row, terms: { ...terms, feeAuthorization: undefined } });
    await assert.rejects(reads.linkTerms(id, request), /fee_quote_signature/);
    await store.put('linkRequests', id, row);
    let payment = await reads.linkPayment(id); assert.equal(payment.settlement.confirmations, 6);
    rules.verifyLinkInput({ request, sig: row.sig, terms, payment }, network, 10, 'link');
    const originalLock = lock;
    const { total: _total, ...withoutTotal } = lock;
    lock = { ...withoutTotal, amt: '1', al: [] };
    const dust = await reads.tapPayment(lockId, { requestId: id, payer: terms.payer });
    assert.equal(dust.total, '1'); assert.equal(dust.base, '1'); assert.deepEqual(dust.allocations, []);
    lock = originalLock;
    for (const [field, value] of [['lock', 'other'], ['owner', 'other'], ['target', 'other'], ['tick', 'other'], ['kind', 'other'], ['amt', '999'], ['total', '1999'], ['al', [{ ...allocation, amt: '999' }]]]) {
      const old = consumed[field]; consumed[field] = value; await assert.rejects(reads.linkPayment(id), /link_release_allocations/); consumed[field] = old;
    }
    consumed.action = 'refund'; payment = await reads.linkPayment(id);
    assert.throws(() => rules.verifyLinkInput({ request, sig: row.sig, terms, payment }, network, 10, 'link'), /link_unpaid/);
    consumed = null; payment = await reads.linkPayment(id);
    assert.throws(() => rules.verifyLinkInput({ request, sig: row.sig, terms, payment }, network, 10, 'link'), /link_unpaid/);
    await writeFile(config.local.registry, JSON.stringify(changeBaseFee(await registry(), '200')));
    assert.equal((await reads.linkTerms(id, request)).baseFee, '100');
    assert.equal((await issuer.issue('link/new', 10)).baseFee, '200');
    await store.put('linkRequests', id, { ...row, terms: { ...terms, feeAuthorization, baseFee: '1' } });
    await assert.rejects(reads.linkTerms(id, request), /link_policy/);
  } finally { reads?.close(); fetch.mock.restore(); await store.close(); }
});
