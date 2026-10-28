import { bindingFixture } from '../../../service/test/bindings-fixture.mjs';
import { agent } from '../../../service/test/helpers.mjs';
import { edPublic } from '../../../service/src/util.mjs';
import { createFeePolicy, changeBaseFee, FeeQuotes } from '../../../service/src/fees.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { productionReads } from '../../../service/prod/reads.mjs';
import { configFixture, MemoryStore, genesis, genesisTx, genesisTxid, genesisInfo, genesisBlock } from '../../../service/prod/test/helpers.mjs';
import { GENESIS } from '../../../contract/beacon/bitcoin.js';
import { createReads } from '../reads.mjs';
import { migrateRegistry, updateRegistryFees } from '../../../service/src/registry.mjs';

test('committee entry exports the configured reader factory', () => { assert.equal(typeof createReads, 'function'); });
test('production readers compose independent fixtures and preserve monotone observed tip', async t => {
  const { config, deployment, file } = await configFixture(t), store = new MemoryStore(), identity = agent(81).address, inscription = genesisTxid + 'i0';
  const fixture = bindingFixture(store, { network: config.network, bitcoinNetwork: 'mainnet' });
  config.committee = fixture.config; config.epoch = 1;
  config.prod.evidence = { network:config.network,epoch:1,member:config.committee[0].id,directory:config.data,endpoint:{urlFile:await file('evidence-url','https://evidence.invalid')} };
  const holder = (await fixture.bind(agent(81), 'tap')).request.address;
  config.prod.http = { requestsPerSecond: 100 };
  const registry = { feePolicy: createFeePolicy('100'), assets: {}, link: { treasury: 'fixture-treasury' } };
  config.prod.registry = await file('registry-read', registry);
  await migrateRegistry(config.prod.registry);
  const feeSecret = Buffer.alloc(32, 9), gateway = edPublic(feeSecret);
  const issuer = new FeeQuotes({ network: config.network, secret: feeSecret, registry: async () => registry });
  const state = { tip: 0, consumed: false, bitmapOwner: holder, conditions: { type: 'hashlock', hash: 'bb'.repeat(32) }, closed: false };
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    const u = new URL(url); assert.ok(u.hostname.endsWith('.invalid'));
    if (u.hostname === 'ethereum.invalid') {
      const r = JSON.parse(options.body), values = { eth_chainId: '0x1' };
      assert.ok(Object.hasOwn(values, r.method), r.method); return Response.json({ id: r.id, result: values[r.method] });
    }
    const path = u.pathname.replace('/api', '');
    if (path === '/r/blockheight') return Response.json(state.tip);
    if (path === '/r/blockinfo/' + GENESIS.hash) return Response.json(genesisInfo);
    if (path === '/block/' + GENESIS.hash) return Response.json(genesisBlock);
    if (path === '/r/tx/' + genesisTxid) return Response.json(genesisTx);
    if (path === '/r/blockhash' || path.startsWith('/r/blockhash/')) return Response.json(GENESIS.hash);
    if (path === '/r/tap/getCurrentBlock') return Response.json({ result: 0 });
    if (path === '/r/tap/getBitmap/0') return Response.json({ result: { bm: 0, ownr: state.bitmapOwner, ins: inscription } });
    if (path.startsWith('/inscription/')) return Response.json({ address: holder, id: inscription, height: 0 });
    if (path.startsWith('/content/')) return Response.json({ redeem: { data: 'request' } });
    if (path.startsWith('/r/tap/getLockConsume/')) return Response.json({ result: state.consumed ? { ins: inscription } : null });
    if (path.startsWith('/r/tap/getLock/')) return Response.json({ result: { owner: 'payer', kind: 'htlc', condition: state.conditions, tick: 'tap', amt: '1', total: '1', refund_after: 300 } });
    throw Error('unrecorded fixture request');
  };
  const manager = { connectedValidators: () => ['a', 'b', 'c'], pickRandomValidator: values => values[0], pickRandomConnectedValidator: () => 'a' };
  const bus = { config: { bootstrap: Buffer.from(config.prod.trac.msbBootstrap, 'hex'), networkId: 918 }, network: { validatorConnectionManager: manager, validatorMessageOrchestrator: { send: async () => true } } };
  const api = { dmwAuthority: async () => ({ network: config.network, epoch: 1, committee: deployment.committee }), dmwHead: async () => ({ counted: 0, tip: { height: 0, hash: GENESIS.hash } }), dmwBatchLast: async () => ({ n: 0, to: 0 }) };
  const peer = { config: { dmw: deployment }, base: { key: Buffer.from(config.prod.trac.bootstrap, 'hex'), update: async () => {}, view: { version: 0 } }, protocol: { instance: { api } } };
  const reads = await productionReads(config, store, { gateway, committee: true, runtime: { peer, bus, close: async () => { state.closed = true; } } });
  try {
    for (const method of ['preflight','receiptObservation','receiptCertificate','tip','mintCertificate','authority','counted','batchLast','batchRoot','balance','nonceUsed','pending','pendingAcceptance','mintExit','agentAddress','blockHold','settings','batchHeaders','batchStamp','batchContext','assetContext','mintFeeTerms','validateFeeTerms','bitmap','link','linkTerms','linkPayment','isMinted','payer','mintRequest','mintPayment','paymentUsed','escrowDeposit','mint','mintAuthorization','escrowRotation','committeeRotation']) assert.equal(typeof reads[method], 'function', method);
    const feeRows = await Promise.all(['link'].map(async kind => {
      const id = 'fee-' + kind, scope = `${kind}/${id}`, quote = await issuer.issue(scope, 0);
      const row = { id, request: { until: 100 }, terms: { treasury: 'fixture-treasury', payer: 'payer', hash: 'bb'.repeat(32), baseFee: quote.baseFee,
        feeAuthorization: await issuer.accept(quote, scope, id, 100, 0) } };
      await reads.validateFeeTerms(kind, row); return { kind, row };
    }));
    const changedAt = Date.now();
    Object.assign(registry, changeBaseFee(registry, '250', changedAt));
    await updateRegistryFees(config.prod.registry, { baseFee: '250' }, changedAt);
    for (const { kind, row } of feeRows) {
      assert.equal((await reads.validateFeeTerms(kind, row)).baseFee, '100');
      await assert.rejects(reads.validateFeeTerms(kind, { ...row, terms: { ...row.terms, feeAuthorization: undefined } }), /fee_quote_signature/);
      await assert.rejects(reads.validateFeeTerms(kind, { ...row, terms: { ...row.terms, baseFee: '1' } }), /_policy/);
      await assert.rejects(reads.validateFeeTerms(kind, { ...row, request: { until: 101 } }), /fee_quote_binding/);
    }
    assert.equal((await reads.authority()).network, config.network); assert.equal((await reads.batchStamp()).tap.hash, GENESIS.hash);
    assert.deepEqual(await reads.bitmap(0, { tip: 0, tipHash: GENESIS.hash }), { agent: identity, address: holder });
    state.bitmapOwner = 'another-holder'; await assert.rejects(reads.bitmap(0), /bitmap_owner/); state.bitmapOwner = holder;
    assert.equal((await reads.tapPayment(inscription + ':0', { requestId: 'request', payer: 'payer' })).consumed, false);
    state.consumed = true; assert.equal((await reads.tapPayment(inscription + ':0', { requestId: 'request', payer: 'payer' })).consumed, true);
    state.conditions.certificate = 'unconfigured'; await assert.rejects(reads.tapPayment(inscription + ':0', { requestId: 'request', payer: 'payer' }), /payment_lock_policy/);
    await store.put('prodBitcoin', 'highestTip', 5); assert.deepEqual(await reads.tip(), { tip: 0, tipHash: GENESIS.hash, highestTip: 5 });
    state.tip = 2; await assert.rejects(reads.tip(), /bitcoin_tip_changed/); state.tip = 0;
    assert.equal(await reads.committeeRotation(), null);
  } finally { await reads.close(); }
  assert.equal(state.closed, true);
});
