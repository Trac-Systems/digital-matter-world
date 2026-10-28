import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Mints } from '../src/mints.mjs';
import { serve } from '../src/http.mjs';
import { FeeQuotes, createFeePolicy } from '../src/fees.mjs';
import { rules } from '../src/rules.mjs';
import { hash, heightKey } from '../src/util.mjs';
import { Agent } from '../../kit/lib/agent.mjs';
import { Journal } from '../../kit/lib/journal.mjs';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { signPaymentIntent } from '../../kit/lib/signing.mjs';
import { signTestPayout } from '../../playground/payout-wallets.mjs';
import { bindingFixture } from './bindings-fixture.mjs';
import { agent, temp, secret, gateway } from './helpers.mjs';
import { jsonRequest, installLocalFetch } from '../src/http-client.mjs';
const { secp256k1 } = createRequire(new URL('../../rules/package.json', import.meta.url))('@noble/curves/secp256k1');
const privilege = 'ac'.repeat(32) + 'i0', deployment = 'ad'.repeat(32) + 'i0', key = Buffer.alloc(32, 3);
const auth = { auth: { fixture: true }, salt: 'local' }; auth.hash = hash(JSON.stringify(auth.auth) + auth.salt);
const signature = secp256k1.sign(auth.hash, key); auth.sig = { r: signature.r.toString(), s: signature.s.toString(), v: signature.recovery };
const publicKey = Buffer.from(secp256k1.getPublicKey(key)).toString('hex');
mock.module('../src/http-client.mjs', { exports: { jsonRequest, installLocalFetch,
  bitcoin: async () => ({ chain: 'regtest' }),
  ordJson: async (_manifest, path) => ({ result: path.includes('getDeployment/') ? { ins: deployment, prv: privilege, dec: 0 } : path.includes('getPrivilegeAuthList') ? [{ ins: privilege }] : '100' })
} });
const { localReads } = await import('../local/reads.mjs');

test('kit request -> human wallet proof -> five independent signers -> accepted discovery mint quote', async () => {
  const directory = await temp('binding-e2e-'), store = await Store.open(join(directory, 'data')), who = agent(61), block = 5, network = 'dmw-regtest';
  const fixture = bindingFixture(store), endpoints = { bitcoind: 'http://127.0.0.1:18443', indexer: 'http://127.0.0.1:55888', trac: 'http://127.0.0.1:59000', ethereum: 'http://127.0.0.1:58545' };
  const config = { data: store.directory, network, endpoints, committee: fixture.config, local: { manifest: join(directory, 'manifest.json'), registry: join(directory, 'registry.json'), escrow: { chainId: '31337', address: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20) } } };
  const file = { observation: 1, height: 10, discoveries: [{ record: { number: 0, discoverer: who.address } }],
    settlements: [{ window: 1, winners: [{ id: rules.findId(block, 0), asset: 'p0', count: 1, winner: who.address }] }] };
  const bytes = rules.encodeBinary(file), root = rules.merkleRoot([bytes]);
  const nativeFetch = globalThis.fetch, upstream = mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/content/')) return Response.json(auth);
    const method = JSON.parse(options.body).method;
    return Response.json({ result: method === 'root' ? root : method === 'record' ? null : method === 'head' ? { counted: 10 } : { committee: publicKey } });
  });
  let reads, http, journal;
  try {
    await mkdir(join(store.directory, 'static', 'blocks'), { recursive: true }); await writeFile(join(store.directory, 'static', 'blocks', 'discovery.bin'), bytes);
    await writeFile(config.local.manifest, JSON.stringify({ bitcoin: { rpc: endpoints.bitcoind }, ord: { url: endpoints.indexer } }));
    const registry = { feePolicy: createFeePolicy('100'), assets: { p0: { id: deployment, tick: 'digit', kind: 'dmt', privilege, pattern: { number: 0 }, tap: { treasury: 'treasury' }, ethereum: { treasury: '0x' + '11'.repeat(20) } } } };
    await writeFile(config.local.registry, JSON.stringify(registry));
    await store.transact([
      { space: 'meta', id: 'patterns', value: [{ number: 0, discoverer: who.address }] }, { space: 'patternProvenance', id: 'p0', value: 1 },
      { space: 'finds', id: rules.findId(block, 0), value: { block, pattern: 0, asset: 'p0', count: 1, finder: who.address, findHeight: 10, window: 1 } },
      { space: 'findProvenance', id: rules.findId(block, 0), value: 1 },
      { space: 'batches', id: heightKey(1), value: { batch: { root }, publications: [{ audit: { path: '/blocks/discovery.bin' } }] } }
    ]);
    reads = await localReads(config, store); reads.feeQuotes = new FeeQuotes({ network, secret, registry: async () => registry });
    reads.balance = async () => '100'; reads.isMinted = async () => false;
    const mints = new Mints({ store, network, reads, operations: { supportsMintBatches: true }, payments: {}, inscriber: { quote: async () => '1000' } });
    http = await serve({ intake: { store }, files: { serve: async () => false }, mints, bindings: fixture.bindings });
    const service = new ServiceClient({ origin: http.url, network, gateway, receiptSigners: fixture.members, fetchImpl: nativeFetch });
    journal = await Journal.open(join(directory, 'kit'), network + '/' + who.address);
    const kit = new Agent({ wallet: fixture.wallet(who), service, trac: { network }, journal, network, dryRun: false, bitcoinNetwork: 'regtest' });
    for (const rail of ['tap', 'ethereum']) {
      const packet = fixture.packet(who, rail, who.secret.toString('hex'));
      await assert.rejects(mints.quote({ asset: 'p0', block, kind: rail }), /discoverer_address_missing/);
      const request = await kit.bindPayoutWallet({ actionId: 'bind-' + rail, rail, address: packet.request.address });
      assert.equal(new URL(request.bindingLink).pathname, '/bind-payout/' + request.request.id);
      assert.equal(new URL(request.bindingLink).search, '');
      const html = await nativeFetch(request.bindingLink); assert.equal(html.status, 200); assert.match(await html.text(), /Bind payout wallet/);
      const walletSignature = signTestPayout(request.request.message, who.secret.toString('hex'), rail);
      const binding = await service.request('/payout-bindings/complete', { value: { id: request.request.id, walletSignature } });
      assert.equal(binding.attestations.length, 5);
      const quote = await service.mintQuote({ asset: 'p0', block, kind: rail });
      assert.equal(quote.destinations.discoverer, packet.request.address);
      assert.equal(quote.feeDestinations.discoverer.to, packet.request.address);
      const requestBody = { request: { owner: who.address, asset: 'p0', block, amount: '1', receive: hash(packet.request.address), nonce: hash('binding-mint'), until: 22, expires: 442 },
        receiver: packet.request.address, payer: packet.request.address, kind: rail, feeQuote: quote.feeQuote };
      requestBody.signature = rules.signRequest('rq', network, requestBody.request, who.secret);
      requestBody.authorization = signPaymentIntent(fixture.wallet(who), network, requestBody);
      for (let i = 0; i < 5; i++) {
        assert.ok(fixture.journals[i].records.some(r => r.record.id === binding.id));
        const signerReads = await localReads({ ...config, local: { ...config.local, readerId: 'verify-' + i } }, undefined, { gateway });
        try {
          await signerReads.feeQuotes.validate(quote.feeQuote, quote.feeQuote.scope);
          assert.equal((await signerReads.assetContext('p0', block, undefined, quote.feeQuote)).discoverer, packet.request.address);
        } finally { signerReads.close(); }
      }
      const nextNonce = (BigInt(binding.request.nonce) + 1n).toString();
      const replacement = await fixture.bind(who, rail, agent(62).secret.toString('hex'), nextNonce);
      assert.equal((await mints.quote({ asset: 'p0', block, kind: rail, feeQuote: quote.feeQuote })).destinations.discoverer, packet.request.address);
      const freshQuote = await service.mintQuote({ asset: 'p0', block, kind: rail });
      assert.equal(freshQuote.destinations.discoverer, replacement.request.address);
      if (rail === 'tap') {
        const admitted = await service.requestMint(requestBody);
        assert.equal(store.get('mints', admitted.id).quote.destinations.discoverer, packet.request.address);
        assert.equal((await reads.mintFeeTerms(admitted.id)).payoutSnapshot.payouts.discoverer, binding.id);
        await assert.rejects(service.requestMint({ ...requestBody, feeQuote: freshQuote.feeQuote }), /payer_authorization/);
      }
    }
  } finally { await http?.close(); journal?.close(); reads?.close(); upstream.mock.restore(); await store.close(); }
});
