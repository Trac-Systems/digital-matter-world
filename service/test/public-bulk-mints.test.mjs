import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { publicMintSourceFixture } from './public-mint-source-fixture.mjs';
import { newStore } from './helpers.mjs';
import { PublicMints } from '../src/public-mints.mjs';
import { assetResources } from '../src/asset-resources.mjs';
import { KeyedWork } from '../src/keyed-work.mjs';
import { rules as r } from '../src/rules.mjs';
import { MintSenderView } from '../src/mint-sender-view.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { publicScanKey, publicRefundKey } from '../../contract/public-mint.js';
import { capacityKey } from '../../contract/financial-capacity.js';
import { permit } from '../../committee/signer/adapter.mjs';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { discoverPublicMintPayments } from '../src/public-mint-discovery.mjs';

async function fixture(t, resources = {}, chainOptions = {}) {
  const chain = publicMintSourceFixture({ publicPaymentV2Height: '100', ...chainOptions }), store = await newStore();
  let server;
  const sender = new MintSenderView({ seed: new Uint8Array(32).fill(17), network: 'regtest', settings: mintSenderSettings({
    enabled: true, directory: join(store.directory, 'sender'), seedFile: join(store.directory, 'seed'), bitcoinApiUrlFile: join(store.directory, 'source') }) });
  sender.ready = () => true;
  t.after(async () => { await server?.close(); sender.close(); await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  const setHeight = async height => { chain.setHeight(height); await store.put('meta', 'ruleState', { counted: height }); };
  await setHeight('105');
  await store.put('patternsByAsset', 'p2:0', chain.context.pattern);
  const reads = chain.reads;
  reads.batchStamp = async () => ({ counted: await reads.counted() });
  reads.financialDeployment = async () => ({ existing: true });
  reads.feeQuotes.now = Date.now;
  const included = reads.included;
  reads.included = id => chain.included.has(id) ? included(id) : null;
  const parent = { store, reads, network: 'test', bitcoinNetwork: 'regtest', document: chain.document,
    resources: assetResources(resources), mintSender: sender, mintWork: new KeyedWork(), financial: { admissionReady: async () => true } };
  const single = parent.publicMints = new PublicMints(parent);
  single.state = () => ({ state: 'public' });
  parent.public = (id, secret) => single.public(id, secret);
  parent.payment = (input, secret) => parent.mintWork.run(input.id, () => single.payment(input, secret));
  const bulk = single.bulk, secret = r.hash('local requester fixture'), input = { asset: 'p2:0', blocks: ['100', '101', '102'], tapAddress: chain.input.tapAddress };
  const sync = async () => {
    const writes = [...chain.records].map(([id, value]) => ({ space: 'accountRecords', id, value }));
    for (const [key, value] of chain.records) if (key.startsWith('fp/public-refund/')) writes.push({ space: 'publicMintRefundsByRequest/' + value.id, id: key.split('/').at(-1), value });
    await store.transact(writes);
  };
  const rows = id => bulk.row(id).members.map(id => store.get('mints', id));
  const start = (extra = {}) => bulk.start({ ...input, nonce: r.hash('order nonce'), ...extra }, { requesterSecret: secret, clientIP: '127.0.0.1' });
  const register = async id => { for (const row of rows(id)) await chain.register(row.quote); await sync(); };
  const seed = (block, height, winner = null) => chain.records.set(publicScanKey(r.publicPlotId(input.asset, block)), {
    next: { height, transactionIndex: '0', inscriptionIndex: '0' }, scannedHeight: String(BigInt(height) - 1n), blockHash: r.hash('block/' + (BigInt(height) - 1n)), winner });
  const settle = async id => {
    const height = await reads.counted(), evidences = [];
    for (const row of rows(id)) {
      const winner = chain.records.get(publicScanKey(r.publicPlotId(row.request.asset, row.request.block)))?.winner ?? null;
      seed(row.request.block, height, winner);
      evidences.push(await chain.settle(row.request.block, { claimed: !!(await reads.assetContext(input.asset, row.request.block)).find }));
    }
    await sync(); return evidences;
  };
  const pay = async (id, { partialBlock, height = '106' } = {}) => {
    await setHeight(height);
    const fees = rows(id).flatMap(row => row.quote.fees.map(f => row.request.block === partialBlock ? { ...f, amount: '1' } : f));
    const prior = chain.records.get(publicScanKey(r.publicPlotId(input.asset, '100')));
    const reference = chain.pay({ fees });
    if (prior?.winner) chain.records.set(publicScanKey(r.publicPlotId(input.asset, '100')), prior);
    return reference;
  };
  const reveal = async (id, reference) => { for (const row of rows(id)) await chain.reveal(row.quote, reference); await sync(); };
  const complete = async id => {
    for (const row of rows(id)) {
      const winner = chain.records.get(publicScanKey(r.publicPlotId(row.request.asset, row.request.block)))?.winner;
      if (winner?.id !== row.id) continue;
      parent.committee = { signature: async () => {
        const { source } = await reads.publicMintPermit(row.id, await reads.batchStamp());
        const p = permit('test', source.request, source.deployment, source.receiver, row.id, winner.paymentHash);
        return { payload: { ...p.payload, prv: { hash: p.digest, address: p.address } } };
      } };
      await single.issue(winner, await reads.batchStamp());
      const minted = r.hash('mint/' + row.id) + 'i0';
      await bulk.inscriptions(id, { inscriptions: [{ requestId: row.id, inscription: minted }] }, secret);
      parent.verifyMint = () => true; reads.mint = async () => ({ accepted: true });
      // Confirmed on Bitcoin: minted at once, while the contract's finish waits for a batch.
      const finishes = []; parent.financial.submit = async t => { finishes.push(t); return { id: 'queued', state: 'queued' }; };
      chain.records.set('dc/' + row.id, { ...chain.records.get('dc/' + row.id), state: 'issued' });
      await single.issue(winner, await reads.batchStamp());
      assert.equal(store.get('mints', row.id).state, 'minted'); assert.equal(store.get('mints', row.id).finishing, true);
      assert.deepEqual(finishes.map(t => t.action.type), ['capacity-finish']);
      chain.records.set('dc/' + row.id, { ...chain.records.get('dc/' + row.id), state: 'minted' });
      await single.issue(winner, await reads.batchStamp());
      assert.equal(store.get('mints', row.id).state, 'minted'); assert.equal(store.get('mints', row.id).finishing, undefined);
      delete parent.financial.submit;
    }
  };
  return { chain, store, reads, parent, single, bulk, input, secret, start, register, pay, reveal, settle, complete, rows, setHeight, sync,
    async http() { server = await serve({ intake: { store }, mints: parent, files: { serve: async () => false }, web: createWeb({ mints: parent }) }); return server; } };
}

test('public bulk quote/start/one payment/independent settlement/permits/mint completes several blocks without an agent', async t => {
  const f = await fixture(t), quote = await f.bulk.quote(f.input);
  assert.equal(quote.orderId, null); assert.equal(quote.payable, false); assert.equal(f.store.count('mints'), 0);
  const started = await f.start(), id = started.orderId;
  assert.equal(started.state, 'registering'); assert.equal(started.unitsConsumed, false); assert.equal(started.reservation, 'none');
  assert.equal(f.store.count('mints'), 3); assert.equal(f.chain.records.has('ar/' + f.input.tapAddress), false);
  assert.equal(f.rows(id).every(row => !row.request.owner && !row.permit), true);
  await f.register(id);
  const ready = f.bulk.status(id, f.secret);
  assert.equal(ready.state, 'awaiting_payment'); assert.equal(ready.payable, true);
  assert.equal(ready.extraOutputs.length, 3); assert.equal(new Set(ready.extraOutputs.map(o => o.address)).size, 3);
  assert.deepEqual(ready.redeem.items, r.walletFeeItems(f.rows(id).flatMap(row => row.quote.fees), 'regtest'));
  for (const row of f.rows(id)) {
    const single = await f.reads.publicMintQuote({ asset: f.input.asset, block: row.request.block, tapAddress: f.input.tapAddress });
    assert.deepEqual(row.quote.split, single.split); assert.equal(row.quote.price, single.price);
    assert.deepEqual(row.quote.fees.map(({ dta, ...f }) => f), single.fees.map(({ dta, ...f }) => f));
  }
  const reference = await f.pay(id);
  const reported = await f.bulk.payment(id, { paymentId: reference }, f.secret);
  assert.equal(reported.state, 'scanning'); assert.equal(reported.payable, false);
  assert.equal(f.store.count('publicMintPaidPlots'), 3);
  await f.reveal(id, reference);
  const pages = await f.settle(id);
  assert.equal(pages.every(p => p.payments.length === 1 && p.payments[0].reference === reference && p.payments[0].complete), true);
  assert.equal(f.bulk.status(id, f.secret).state, 'minting');
  await f.complete(id);
  const done = f.bulk.status(id, f.secret);
  assert.equal(done.state, 'minted'); assert.equal(done.counts.minted, 3);
  assert.equal(done.members.every(m => m.receiver === f.input.tapAddress && m.state === 'minted'), true);
});

test('one earlier confirmed payer wins one member, refunds exactly that share, and the other members mint', async t => {
  const f = await fixture(t), started = await f.start(), id = started.orderId;
  const other = await f.reads.publicMintQuote({ ...f.chain.input, tapAddress: 'bcrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsqysakq' });
  await f.chain.register(other); await f.register(id);
  await f.setHeight('106'); const prior = f.chain.pay(other, other.intent.tapAddress);
  await f.chain.reveal(other, prior); await f.chain.settle();
  const reference = await f.pay(id, { height: '107' });
  await f.bulk.payment(id, { paymentId: reference }, f.secret); await f.reveal(id, reference); await f.settle(id); await f.complete(id);
  const status = f.bulk.status(id, f.secret), lost = status.members.find(m => m.block === '100');
  assert.equal(status.state, 'completed_with_refunds'); assert.equal(status.counts.minted, 2); assert.equal(status.counts.refundable, 1);
  assert.equal(lost.refunds.length, 1); assert.equal(lost.refunds[0].reason, 'someone_paid_first');
  assert.equal(lost.refunds[0].fees.reduce((n, f) => n + BigInt(f.amount), 0n).toString(), lost.payableAmount);
  assert.equal(f.chain.records.get(publicScanKey(r.publicPlotId('p2:0', '100'))).winner.id, other.id);
});

test('public bulk pays every member holder fee in one redeem and books no deferred holder shares', async t => {
  const f = await fixture(t, {}, { deployerShareBps: 500 }), started = await f.start(), id = started.orderId;
  await f.register(id);
  const ready = f.bulk.status(id, f.secret), rows = f.rows(id);
  for (const row of rows) {
    const fee = row.quote.fees.find(f => f.role === 'deployer'); assert.ok(fee);
    assert.ok(ready.redeem.items.some(item => item.dta === fee.dta && item.address === fee.to));
    assert.equal(row.quote.legacyDeploy, undefined); assert.equal(row.quote.deployer, undefined);
  }
  const reference = await f.pay(id);
  await f.bulk.payment(id, { paymentId: reference }, f.secret); await f.reveal(id, reference);
  const pages = await f.settle(id);
  assert.ok(pages.every(page => page.payments[0].complete && page.payments[0].reference === reference &&
    !page.payments[0].source.deployer && !page.payments[0].source.legacyDeploy));
  await f.complete(id); assert.equal(f.bulk.status(id, f.secret).counts.minted, rows.length);
});

test('a payment sent before the deadline survives restart and confirms after it without expiry refunds', async t => {
  const f = await fixture(t), started = await f.start(), id = started.orderId;
  await f.register(id); const reference = await f.pay(id);
  f.chain.setConfirmations(0);
  const waiting = await f.bulk.payment(id, { paymentId: reference }, f.secret);
  assert.equal(waiting.state, 'confirming'); assert.equal(f.store.count('publicMintPaidPlots'), 0);
  const height = r.nextUint(started.payBy.untilBlock);
  const txs = f.chain.blocks.get('106'); f.chain.blocks.delete('106'); f.chain.blocks.set(height, txs); f.chain.included.set(reference, height);
  await f.setHeight(height); f.chain.setConfirmations(1);
  const resumed = new PublicMints(f.parent);
  await resumed.bulk.tick();
  assert.equal(f.store.count('publicMintPaidPlots'), 3); assert.equal(resumed.bulk.status(id, f.secret).payable, false);
  await f.reveal(id, reference); const pages = await f.settle(id); await f.complete(id);
  assert.ok(pages.every(p => p.payments[0].complete && !p.payments[0].refusal));
  assert.equal(f.bulk.status(id, f.secret).state, 'minted');
});

test('partial payment refunds only received atoms for the incomplete member and cannot mint it', async t => {
  const f = await fixture(t), started = await f.start(), id = started.orderId;
  await f.register(id); const reference = await f.pay(id, { partialBlock: '101' });
  await f.bulk.payment(id, { paymentId: reference }, f.secret); await f.reveal(id, reference); await f.settle(id); await f.complete(id);
  const status = f.bulk.status(id, f.secret), lost = status.members.find(m => m.block === '101');
  assert.equal(status.counts.minted, 2); assert.equal(lost.refunds[0].reason, 'public_payment_incomplete');
  assert.equal(lost.refunds[0].fees.reduce((n, f) => n + BigInt(f.amount), 0n), BigInt(lost.fees.length));
  assert.equal(lost.mintContent, undefined);
});

test('idempotent starts and payment retries cannot duplicate members or refunds; wrong secrets cannot mutate an order', async t => {
  const f = await fixture(t), [a, b] = await Promise.all([f.start(), f.start()]);
  assert.equal(a.orderId, b.orderId); assert.equal(f.store.count('mints'), 3);
  assert.equal(f.store.get('publicMintStartRates', r.hash('127.0.0.1')).count, 1);
  await assert.rejects(f.start({ blocks: ['100'] }), /public_bulk_conflict/);
  await assert.rejects(f.bulk.payment(a.orderId, { paymentId: r.hash('unknown') + 'i0' }, 'wrong'), /requester_required/);
  const hidden = f.bulk.status(a.orderId);
  assert.equal(hidden.requesterRequired, true); assert.equal(hidden.members, undefined); assert.equal(hidden.asset, undefined); assert.equal(hidden.redeem, undefined);
  assert.ok(!JSON.stringify(f.bulk.row(a.orderId)).includes(f.secret));
  await f.register(a.orderId); const reference = await f.pay(a.orderId);
  await Promise.all([f.bulk.payment(a.orderId, { paymentId: reference }, f.secret), f.bulk.payment(a.orderId, { paymentIds: [reference, reference] }, f.secret)]);
  assert.equal(f.store.count('publicMintPaidPlots'), 3); assert.deepEqual(f.bulk.row(a.orderId).paymentIds, [reference]);
  assert.ok(f.rows(a.orderId).every(row => row.paymentIds.length === 1));
  await f.reveal(a.orderId, reference); await f.settle(a.orderId);
  await assert.rejects(f.chain.reveal(f.rows(a.orderId)[0].quote, reference), /public_payment_reveal/);
});

test('limits, duplicate blocks, inactive opaque payments and unavailable sender fail before creating requests', async t => {
  const f = await fixture(t, { publicBulkMintBlocks: 2 });
  await assert.rejects(f.start(), /public_bulk_blocks/);
  await assert.rejects(f.start({ blocks: ['100', '100'] }), /public_bulk_blocks/);
  await assert.rejects(f.start({ blocks: ['01'] }), /public_bulk_blocks/);
  await assert.rejects(f.start({ blocks: ['100'], asset: 'c2:' + r.hash('compound') }), /public_bulk_input/);
  f.parent.mintSender.ready = () => false;
  await assert.rejects(f.start({ blocks: ['100'] }), /public_bulk_sender_unavailable/);
  assert.equal(f.store.count('mints'), 0); assert.equal(f.store.count('publicBulkOrders'), 0);
});

test('unreported multi-intent wallet payments are discovered for every distinct plot after restart', async t => {
  const f = await fixture(t), started = await f.start(), id = started.orderId;
  await f.register(id); const reference = await f.pay(id); await f.reveal(id, reference);
  await f.store.put('meta', 'publicMintDiscovery', { height: '106', transactionIndex: 0, inscriptionIndex: 0 });
  await discoverPublicMintPayments(new PublicMints(f.parent), await f.reads.batchStamp());
  assert.equal(f.store.count('publicMintPaidPlots'), 3);
  assert.deepEqual(f.store.list('publicMintPaidPlots', { limit: 10 }).map(r => r.value.block).sort(), f.input.blocks);
  assert.equal(f.store.get('meta', 'publicMintDiscovery').height, '107');
  await discoverPublicMintPayments(f.single, await f.reads.batchStamp());
  assert.equal(f.store.count('publicMintPaidPlots'), 3);
});

test('an agent claim refunds that block as claimed_first while the other public members still mint', async t => {
  const f = await fixture(t), started = await f.start(), id = started.orderId;
  await f.register(id); const reference = await f.pay(id);
  const context = f.chain.context;
  f.reads.assetContext = async (_asset, block) => block === '101' ? { ...context, find: { finder: 'agent' } } : context;
  await f.bulk.payment(id, { paymentId: reference }, f.secret); await f.reveal(id, reference); await f.settle(id); await f.complete(id);
  const status = f.bulk.status(id, f.secret);
  assert.equal(status.counts.minted, 2);
  assert.equal(status.members.find(m => m.block === '101').refunds[0].reason, 'claimed_first');
});

test('an entirely unpaid member cannot mint or earn a refund and the order reports partial completion', async t => {
  const f = await fixture(t), started = await f.start(), id = started.orderId;
  await f.register(id); await f.setHeight('106');
  const paidRows = f.rows(id).filter(row => row.request.block !== '102');
  const reference = f.chain.pay({ fees: paidRows.flatMap(row => row.quote.fees) });
  const partial = await f.bulk.payment(id, { paymentId: reference }, f.secret);
  assert.equal(partial.state, 'partly_paid'); assert.equal(partial.payable, false);
  for (const row of paidRows) await f.chain.reveal(row.quote, reference);
  await f.sync(); await f.settle(id); await f.complete(id);
  const status = f.bulk.status(id, f.secret), unpaid = status.members.find(m => m.block === '102');
  assert.equal(status.state, 'completed_partial'); assert.equal(status.counts.minted, 2);
  assert.equal(status.counts.unpaid, 1); assert.equal(unpaid.refunds.length, 0); assert.equal(unpaid.mintContent, undefined);
  await f.setHeight(r.nextUint(started.payBy.untilBlock)); await f.single.releaseFinishedRequests(await f.reads.counted());
  assert.equal(f.store.count('publicMintRequests'), 0, 'an unpaid missing member does not keep expired admission capacity');
});

test('the default limit admits 64 public blocks in one order and refuses the 65th', async t => {
  const f = await fixture(t);
  await f.setHeight('1000');
  const blocks = Array.from({ length: 64 }, (_, i) => String(100 + i));
  const started = await f.start({ blocks });
  assert.equal(started.counts.total, 64); assert.equal(f.store.count('mints'), 64);
  assert.equal(f.store.count('publicBulkOrders'), 1);
  await assert.rejects(f.start({ blocks: [...blocks, '164'], nonce: r.hash('another order') }), /public_bulk_blocks/);
});

test('changed snapshots, insufficient global capacity and oversized responses leave no partial order', async t => {
  const f = await fixture(t, { activeMints: 2 });
  await assert.rejects(f.start(), /mint_capacity/);
  assert.equal(f.store.count('mints'), 0);
  f.parent.resources.activeMints = 20;
  let calls = 0; f.reads.batchStamp = async () => ({ counted: ++calls === 1 ? '105' : '106' });
  await assert.rejects(f.start(), /financial_snapshot_changed/);
  f.reads.batchStamp = async () => ({ counted: '105' });
  f.parent.resources.publicBulkResponseBytes = 1;
  await assert.rejects(f.start(), /public_bulk_response_bytes/);
  assert.equal(f.store.count('mints'), 0); assert.equal(f.store.count('publicBulkOrders'), 0);
});

test('an offline reader retains the payment hint and later retries without another wallet payment', async t => {
  const f = await fixture(t), started = await f.start(), id = started.orderId;
  await f.register(id); const reference = await f.pay(id), batchStamp = f.reads.batchStamp;
  f.reads.batchStamp = async () => { throw Error('tap_snapshot_unavailable'); };
  const result = await f.bulk.payment(id, { paymentId: reference }, f.secret);
  assert.equal(result.state, 'confirming'); assert.equal(result.retryReason, 'tap_snapshot_unavailable');
  assert.equal(f.store.get('publicBulkPending', id), true);
  await f.bulk.tick(); assert.equal(f.store.get('publicBulkPending', id), true);
  f.reads.batchStamp = batchStamp; await f.bulk.tick();
  assert.equal(f.bulk.status(id, f.secret).state, 'scanning');
  assert.equal(f.store.get('publicBulkPending', id), null);
});

test('a bulk expiry marker is signed and cannot be added to an ordinary public quote', async t => {
  const f = await fixture(t), q = await f.reads.publicMintQuote(f.chain.input);
  await f.chain.register(q);
  const forged = { ...q.intent, publicBulkOrderId: r.hash('forged bulk') };
  await assert.rejects(f.reads.publicMintPayment({ action: 'reveal', id: q.registration.commitment,
    intent: forged, reference: r.hash('payment') + 'i0' }, await f.reads.batchStamp()), /public_payment_commitment/);
  await assert.rejects(f.reads.publicMintQuote(f.chain.input, await f.reads.batchStamp(), { publicBulkOrderId: 'invalid' }), /public_bulk_payment_version/);
});

test('an expired unpaid bulk order releases admission but keeps late-payment recovery and identity', async t => {
  const f = await fixture(t, { publicMintsPerPayer: 1 }), started = await f.start(), id = started.orderId;
  await f.register(id);
  await f.store.put('publicBulkOrders', id, { ...f.bulk.row(id), expiresAt: Date.now() - 1 });
  assert.equal(f.bulk.status(id, f.secret).state, 'expired');
  const next = await f.start({ nonce: r.hash('fresh after expiry') });
  assert.notEqual(next.orderId, id); assert.equal(f.store.count('mints'), 6);
  assert.equal((await f.start()).orderId, id, 'same nonce never creates replacement terms');
  const reference = await f.pay(id); await f.bulk.payment(id, { paymentId: reference }, f.secret);
  await f.reveal(id, reference); await f.settle(id); await f.complete(id);
  assert.equal(f.bulk.status(id, f.secret).state, 'minted');
});

test('lowering the block limit affects new orders and preserves exact retries of an admitted order', async t => {
  const f = await fixture(t), started = await f.start();
  f.parent.resources.publicBulkMintBlocks = 1;
  assert.equal((await f.start()).orderId, started.orderId);
  await assert.rejects(f.start({ nonce: r.hash('new after limit change') }), /public_bulk_blocks/);
  assert.equal(f.store.count('mints'), 3);
});

test('bulk HTTP and website aliases expose the same private order with origin and body checks', async t => {
  const f = await fixture(t), server = await f.http(), body = { ...f.input, nonce: r.hash('http nonce') };
  const request = (path, payload, headers = {}) => fetch(server.url + path, { method: payload ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-mint-requester-secret': f.secret, ...headers }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const preview = await request('/web-api/public-mints/bulk/quote', f.input); assert.equal(preview.status, 200);
  const start = await request('/web-api/public-mints/bulk/start', body); assert.equal(start.status, 200);
  const order = await start.json();
  for (const prefix of ['', '/web-api']) {
    const limits = await fetch(server.url + prefix + '/public-mints/bulk/limits');
    assert.equal(limits.status, 200); assert.deepEqual(await limits.json(), { blocks: 64 });
    const response = await request(prefix + '/public-mints/bulk/' + order.orderId);
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private, no-store/);
    assert.equal((await response.json()).members.length, 3);
    const head = await fetch(server.url + prefix + '/public-mints/bulk/' + order.orderId, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }
  const hidden = await fetch(server.url + '/public-mints/bulk/' + order.orderId);
  assert.equal((await hidden.json()).requesterRequired, true);
  assert.equal((await request('/public-mints/bulk/start', body, { origin: 'https://unrelated.invalid' })).status, 403);
  assert.equal((await request('/public-mints/bulk/quote', { ...f.input, padding: 'x'.repeat(f.bulk.resources.publicBulkInputBytes) })).status, 413);
});

test('bulk totals retain each block own landowner, discoverer and payer self-share split', async t => {
  const f = await fixture(t, {}, { bitmapMintOpenHeight: '100' });
  const other = 'bcrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsqysakq', context = f.chain.context;
  f.reads.assetContext = async (_asset, block) => ({ ...context, discoverer: other,
    ...(block === '101' ? { link: { block }, bitmapHolder: { address: other } } : {}) });
  const started = await f.start(), rows = f.rows(started.orderId);
  const linked = rows.find(row => row.request.block === '101');
  assert.ok(linked.quote.fees.some(fee => fee.role === 'landowner' && fee.to === other));
  assert.ok(rows.every(row => row.quote.fees.some(fee => fee.role === 'discoverer' && fee.to === other)));
  for (const row of rows) {
    const single = await f.reads.publicMintQuote({ ...f.chain.input, block: row.request.block });
    assert.deepEqual(row.quote.split, single.split);
    assert.deepEqual(row.quote.fees.map(({ dta, ...fee }) => fee), single.fees.map(({ dta, ...fee }) => fee));
    assert.ok(row.quote.fees.every(fee => fee.to !== f.input.tapAddress));
  }
  assert.equal(started.payableAmount, rows.reduce((n, row) => n + BigInt(row.quote.payableAmount), 0n).toString());
});

test('aggregate supply and outstanding capacity are checked before any member becomes payable', async t => {
  const f = await fixture(t), d = f.chain.context.deployment, generation = f.chain.records.get('fd/generation');
  d.remaining = '8';
  await assert.rejects(f.start(), /public_bulk_capacity/);
  d.remaining = '9';
  f.chain.records.set('fd/generation', { ...generation, maximum: '8' });
  await assert.rejects(f.start(), /public_bulk_capacity/);
  f.chain.records.set('fd/generation', generation);
  f.chain.records.set(capacityKey(d.id), '1');
  await assert.rejects(f.start(), /public_bulk_capacity/);
  f.chain.records.delete(capacityKey(d.id));
  d.limit = '2'; await assert.rejects(f.start(), /public_bulk_capacity/);
  assert.equal(f.store.count('mints'), 0);
  d.limit = '3'; const started = await f.start();
  assert.equal(started.counts.total, 3);
});

test('Bitcoin confirmation with a lagging TAP index retains the shared payment for every member', async t => {
  const f = await fixture(t), started = await f.start(), id = started.orderId;
  await f.register(id); const reference = await f.pay(id);
  const transfers = f.chain.transfers.get(reference);
  f.chain.transfers.set(reference, []);
  await f.bulk.payment(id, { paymentId: reference }, f.secret);
  assert.equal(f.store.get('publicBulkPending', id), true);
  assert.equal(f.store.count('publicMintPaidPlots'), 0);
  const missing = f.rows(id).find(row => row.request.block === '102').quote.fees.map(fee => fee.dta);
  f.chain.transfers.set(reference, transfers.filter(t => !missing.includes(t.dta)));
  await f.bulk.tick();
  assert.equal(f.store.get('publicBulkPending', id), true);
  assert.equal(f.store.count('publicMintPaidPlots'), 2);
  f.chain.transfers.set(reference, transfers);
  await new PublicMints(f.parent).bulk.tick();
  assert.equal(f.store.get('publicBulkPending', id), null);
  assert.equal(f.store.count('publicMintPaidPlots'), 3);
});
