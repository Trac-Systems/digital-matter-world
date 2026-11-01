import { newRequesterSecret, requesterSecretHash } from '../src/public-mint-privacy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import * as actualRules from '../../rules/src/index.js';

const { PublicMints, publicMintAcceptedWrites } = await import('../src/public-mints.mjs');
const { FinancialExecution } = await import('../src/financial-execution.mjs');
const { publicScanKey, publicRefundKey } = await import('../../contract/public-mint.js');
const { plotKey } = await import('../../contract/financial-capacity.js');
const { newStore } = await import('./helpers.mjs');
const { serve } = await import('../src/http.mjs');
const r = actualRules;

async function fixture(t, legacy = false, height = '1108') {
  const store = await newStore();
  t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  const document = r.settingsRevision({ network: 'test', effectiveBatch: '1', effectiveBitcoinWindow: '100', values: {
    ...r.SETTINGS_PROFILE, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100', claimsNeverCloseHeight: '100' } });
  const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: '100' } }, height);
  const storage = new r.ClaimStorage({ get: key => store.get('claimNodes', key), cacheSize: 8 });
  const claims = storage.load({ ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot) });
  claims.counted = height;
  const save = async () => { const saved = storage.save(claims); await store.transact([...saved.writes, { space: 'meta', id: 'ruleState', value: saved.state }]); };
  await save();
  const pattern = { number: '0', key: r.hash('pattern'), pat: '[0-9]', fld: 4, dt: 'n', tier: 1, ...(legacy ? { legacy: { asset: 'p0' } } : {}) };
  await store.put('patternsByAsset', 'p2:0', pattern);
  const occurrence = async block => store.put('claimed2/p2:0', r.uintKeyV2(block), { height: block, pattern: '0', count: '3', found: false, minted: false });
  const parent = { store, document, reads: {}, resources: { workPage: 2 } }, mints = new PublicMints(parent);
  return { store, document, pattern, claims, save, occurrence, parent, mints, asset: legacy ? 'p0' : 'p2:0' };
}

for (const legacy of [false, true]) test(`new public reads use accepted claims and the catalog alias; legacy=${legacy}`, async t => {
  const f = await fixture(t, legacy);
  await f.occurrence('100');
  for (const asset of new Set(['p2:0', f.asset])) {
    const state = f.mints.state(asset, '100');
    assert.equal(state.state, 'public', 'an untaken block is public once its finder week has passed');
    assert.equal(state.ledgerAsset, f.asset);
    assert.equal(Object.hasOwn(state, 'claimDeadline'), false);
  }
  const get = () => f.mints.state('p2:0', '100');
  for (const field of ['finds', 'claimReservations']) {
    f.claims[field] = r.recordSet(f.claims[field], r.findIdV2('100', '0'), { asset: f.asset, count: '3' }); await f.save();
    assert.equal(get().state, 'claimed');
    await assert.rejects(f.mints.quote({ asset: 'p2:0', block: '100', tapAddress: 'unused' }), /claimed/);
    f.claims[field] = r.recordSet(f.claims[field], r.findIdV2('100', '0'), null); await f.save();
  }
  f.claims.headerAwards = r.recordSet(f.claims.headerAwards, '100', { senderCount: '1', catalog: { nextNumber: '1' } }); await f.save();
  assert.equal(get().state, 'claimed');
  await f.store.put('accountRecords', plotKey(f.asset, '100'), 'public-checkout');
  assert.equal(get().state, 'claimed', 'an agent mint reservation does not label an unminted find as minted');
  await f.store.put('accountRecords', publicScanKey(r.publicPlotId(f.asset, '100')), { winner: { id: 'public-checkout', tapAddress: 'wallet' } });
  assert.equal(get().state, 'paid');
  await f.store.put('mints', 'public-checkout', { permit: {} });
  assert.equal(get().state, 'permit_issued');
  await f.store.put('minted', f.asset + '/100', { id: 'public-checkout' });
  assert.equal(get().state, 'already_minted');
});

for (const legacy of [false, true]) test(`fresh public reads and quote/start wait until publicFrom; legacy=${legacy}`, async t => {
  const f = await fixture(t, legacy, '100'), block = '100';
  const publicFrom = r.claimDeadline(f.pattern, block, f.document);
  assert.equal(publicFrom, '1108');
  await f.occurrence(block);
  const http = await serve({ intake: { store: f.store }, files: { serve: async () => false },
    mints: { document: f.document, publicMints: f.mints } }); t.after(() => http.close());
  for (const height of [block, String(BigInt(publicFrom) - 1n)]) {
    f.claims.counted = height; await f.save();
    for (const asset of new Set(['p2:0', f.asset])) {
      const response = await fetch(http.url + `/public-mints/${asset}/${block}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { asset: 'p2:0', ledgerAsset: f.asset, block, amount: '3',
        state: 'not_yet_public', publicFrom, bitmapHolderOnly: false, winner: null,
        refunds: '/public-mints/refunds?asset=p2%3A0&block=' + block });
      for (const endpoint of ['quote', 'start']) {
        const refused = await fetch(http.url + '/public-mints/' + endpoint, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ asset, block,
            tapAddress: 'bcrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsqysakq' }) });
        assert.equal(refused.status, 409); assert.deepEqual(await refused.json(), { error: 'not_yet_public' });
      }
    }
    assert.deepEqual(f.mints.list(new URLSearchParams({ asset: 'p2:0' })).rows, []);
    for (const path of ['/public-mints', '/mint-rights']) {
      const response = await fetch(http.url + path + '?asset=p2:0');
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.deepEqual(page.rows, []); assert.deepEqual(page.mintRights, []);
    }
    for (const space of ['mints', 'publicMintRequests', 'publicMintPlots', 'provisioning', 'financialQueue']) assert.equal(f.store.count(space), 0);
  }
  f.claims.counted = publicFrom; await f.save();
  for (const asset of new Set(['p2:0', f.asset])) {
    const response = await fetch(http.url + `/public-mints/${asset}/${block}`);
    assert.equal(response.status, 200);
    const row = await response.json();
    assert.equal(row.state, 'public'); assert.equal(Object.hasOwn(row, 'publicFrom'), false);
  }
  assert.deepEqual(f.mints.list(new URLSearchParams({ asset: 'p2:0' })).rows.map(row => row.block), [block]);
  for (const path of ['/public-mints', '/mint-rights']) {
    const response = await fetch(http.url + path + '?asset=p2:0');
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.deepEqual(page.rows, [f.mints.state('p2:0', block)]);
    assert.deepEqual(page.mintRights, page.rows);
  }
});

test('unindexed public block reads retain exact opening heights above the safe integer range', async t => {
  const f = await fixture(t, true, '100'), block = '550001';
  await f.store.put('patternsByAsset', 'p2:0', { ...f.pattern, releaseHeight: '9007199254740993' });
  const http = await serve({ intake: { store: f.store }, files: { serve: async () => false },
    mints: { document: f.document, publicMints: f.mints } }); t.after(() => http.close());
  for (const asset of ['p2:0', 'p0']) {
    const response = await fetch(http.url + `/public-mints/${asset}/${block}`);
    assert.equal(response.status, 200);
    const row = await response.json();
    assert.equal(row.state, 'not_yet_public'); assert.equal(row.amount, null);
    assert.equal(row.publicFrom, '9007199254742001');
  }
  await f.store.put('accountRecords', plotKey(f.asset, block), 'taken');
  const taken = f.mints.state('p2:0', block);
  assert.equal(taken.state, 'already_minted'); assert.equal(Object.hasOwn(taken, 'publicFrom'), false);
  await f.store.put('accountRecords', publicScanKey(r.publicPlotId(f.asset, block)), { winner: { id: 'taken', tapAddress: 'wallet' } });
  const paid = f.mints.state('p2:0', block);
  assert.equal(paid.state, 'paid'); assert.equal(Object.hasOwn(paid, 'publicFrom'), false);
});

test('unpaid public request and checkout reads retain the opening height until the block opens', async t => {
  // The opening height is part of the requester's own view; anonymous views keep hiding the target.
  const f = await fixture(t, true, '100'), id = r.hash('unopened-checkout'), secret = newRequesterSecret();
  await f.store.put('mints', id, { id, publicMint: true, catalogAsset: 'p2:0', kind: 'tap',
    request: { asset: f.asset, block: '100', amount: '3' }, quote: { fees: [] }, paymentIds: [],
    created: '100', expiry: '1208', state: 'awaiting_payment', payer: 'wallet', requesterSecretHash: requesterSecretHash(secret) });
  const mints = { document: f.document, publicMints: f.mints, public: (id, secret) => f.mints.public(id, secret) };
  const { WebCheckout } = await import('../src/web-checkout.mjs');
  const { createWeb } = await import('../src/web.mjs');
  const { createPublicAPI } = await import('../src/public-api.mjs');
  const checkout = new WebCheckout({ store: f.store, mints, reads: { counted: async () => f.claims.counted },
    config: { mode: 'regtest', network: 'test', endpoints: {}, local: { escrow: { chainId: '31337' } } } });
  const publicAPI = createPublicAPI({ views: { store: f.store, mints } });
  const http = await serve({ intake: { store: f.store }, files: { serve: async () => false }, mints, publicAPI,
    web: createWeb(checkout) }); t.after(() => http.close());
  for (const height of ['100', '1107', '1108']) {
    f.claims.counted = height; await f.save();
    for (const path of ['/mint/' + id, '/web-api/mint/' + id]) {
      const response = await fetch(http.url + path, { headers: { 'x-mint-requester-secret': secret } });
      assert.equal(response.status, 200);
      const row = await response.json(), open = height === '1108';
      const anonymous = await (await fetch(http.url + path)).json();
      assert.equal(Object.hasOwn(anonymous, 'publicFrom'), false);
      assert.equal(row.state, open ? 'awaiting_payment' : 'not_yet_public');
      assert.equal(row.payable, open);
      if (open) assert.equal(Object.hasOwn(row, 'publicFrom'), false);
      else assert.equal(row.publicFrom, '1108');
    }
  }
});

test('public list uses only submitted indexed evidence, skips taken rows and continues empty pages', async t => {
  const f = await fixture(t);
  for (const block of ['90', '99', '100']) await f.occurrence(block);
  f.claims.claimReservations = r.recordSet(f.claims.claimReservations, r.findIdV2('90', '0'), { window: '101' });
  f.claims.rounds.push({ window: '100', closed: false }); await f.save();
  await f.store.put('accountRecords', plotKey(f.asset, '99'), 'public-winner');
  const http = await serve({ intake: { store: f.store }, files: { serve: async () => false }, mints: { publicMints: f.mints } }); t.after(() => http.close());
  const list = async cursor => {
    const response = await fetch(http.url + '/public-mints?' + new URLSearchParams({ asset: 'p2:0', limit: '1', ...(cursor ? { cursor } : {}) }));
    assert.equal(response.status, 200); return response.json();
  };
  const first = await list(); assert.deepEqual(first.rows, []); assert.ok(first.nextCursor);
  const second = await list(first.nextCursor); assert.deepEqual(second.rows, []); assert.ok(second.nextCursor);
  const third = await list(second.nextCursor); assert.deepEqual(third.rows.map(row => row.block), ['100']); assert.equal(third.nextCursor, null);
  assert.doesNotMatch(JSON.stringify(third), /claimDeadline|claim_window_open/);
  assert.equal(f.store.count('claimed2/p2:0'), 3, 'no history enumeration or synthetic entries');
});

test('accepted contract refunds override apparently complete source payments in the same batch', async t => {
  const f = await fixture(t), id = r.hash('request'), plot = r.publicPlotId(f.asset, '100');
  const payment = { id, asset: f.asset, block: '100', tapAddress: 'wallet', reference: r.hash('payment') + 'i0', complete: true,
    height: '1108', transactionIndex: '0', inscriptionIndex: '0', fees: [{ amount: '10' }], source: { private: 'not public' } };
  const refund = { ...payment, complete: false, reason: 'claimed_first', state: 'owed', winner: null };
  const input = { transition: { type: 'public-scan', id: plot }, evidence: { payments: [payment] } };
  const accountWrites = [{ space: 'accountRecords', id: publicScanKey(plot), value: { winner: null } },
    { space: 'accountRecords', id: publicRefundKey(payment), value: refund }];
  const executor = { store: f.store, releaseAdmission: () => [] };
  const writes = FinancialExecution.prototype.acceptedOperations.call(executor, { proposal: { batch: { n: '2' } },
    items: [{ output: { accountWrites, file: { financialOperations: [input] } } }] });
  assert.equal(writes.some(w => w.space === 'financialCustodyPending'), false, 'a source-complete loser has no mint custody');
  await f.store.transact([...accountWrites, ...writes]);
  await f.store.put('mints', id, { id, publicMint: true, catalogAsset: 'p2:0', request: { asset: f.asset, block: '100', amount: '3' },
    quote: { fees: [], claimDeadline: '1108' }, paymentIds: [payment.reference], created: '1108', expiry: '1208', state: 'scanning', payer: 'wallet' });
  const request = f.mints.public(id);
  assert.equal(request.state, 'refundable'); assert.equal(request.reason, 'claimed_first'); assert.equal(request.payable, false);
  assert.equal(Object.hasOwn(request, 'claimDeadline'), false);
  assert.equal(request.refunds[0].reason, 'claimed_first'); assert.equal(Object.hasOwn(request.refunds[0], 'source'), false);
  const refunds = f.mints.refunds(new URLSearchParams({ tapAddress: 'wallet' }));
  assert.equal(refunds.rows.length, 1); assert.equal(refunds.rows[0].reason, 'claimed_first');
  assert.equal(refunds.rows[0].block, undefined);
  assert.deepEqual(f.mints.refunds(new URLSearchParams({ asset: 'p2:0', block: '100', tapAddress: 'wallet' })).rows, []);
});

test('only an accepted new winner schedules custody; existing winners and source-only winners do not', () => {
  const winner = { id: r.hash('winner'), reference: r.hash('payment') + 'i0' }, key = publicScanKey('plot');
  const input = { transition: { type: 'public-scan', id: 'plot' }, evidence: { payments: [{ ...winner, complete: true }] } };
  const empty = { get: () => null }, accepted = { get: (space, id) => id === key ? { winner } : null };
  assert.deepEqual(publicMintAcceptedWrites(empty, input, accepted), [{ space: 'financialCustodyPending', id: winner.id, value: true }]);
  assert.deepEqual(publicMintAcceptedWrites(accepted, input, accepted), []);
  assert.deepEqual(publicMintAcceptedWrites(empty, input, empty), []);
});

test('quote, deployment preparation and checkout omit deadlines and stop offering payment after an agent claim', async t => {
  const f = await fixture(t, true), address = 'bcrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsqysakq';
  const input = { asset: 'p2:0', block: '100', tapAddress: address };
  const q = { id: r.hash('checkout'), intent: {}, amount: '3', price: '100', split: {}, fees: [],
    feeQuote: { validFrom: '1108', validUntil: '1208', baseFee: '100' }, deployment: { id: 'deployment', tick: 'dmwtest' } };
  Object.assign(f.parent, { financial: { submit: async () => {} }, bitcoinNetwork: 'regtest', resources: { ...f.parent.resources, activeMints: 10 } });
  Object.assign(f.parent.reads, { batchStamp: async () => ({ counted: f.claims.counted }), financialDeployment: async () => ({ existing: true }), publicMintQuote: async body => { assert.equal(body.asset, 'p0'); return q; } });
  assert.equal(Object.hasOwn(await f.mints.quote(input), 'claimDeadline'), false);
  f.parent.provisioner = { request: async () => ({ state: 'needed' }) };
  const preparation = await f.mints.quote(input); assert.equal(preparation.state, 'deployment_needed'); assert.equal(Object.hasOwn(preparation, 'claimDeadline'), false);
  delete f.parent.provisioner;
  f.parent.reads.financialDeployment = async () => ({ existing: false });
  const waiting = await f.mints.quote(input); assert.equal(waiting.state, 'deployment_pending'); assert.equal(Object.hasOwn(waiting, 'claimDeadline'), false);
  f.parent.reads.financialDeployment = async () => ({ existing: true });
  const started = await f.mints.quote(input, true); assert.equal(started.payable, true); assert.equal(Object.hasOwn(started, 'claimDeadline'), false);
  f.claims.claimReservations = r.recordSet(f.claims.claimReservations, r.findIdV2('100', '0'), { window: f.claims.counted }); await f.save();
  const stale = f.mints.public(started.id); assert.equal(stale.payable, false); assert.equal(stale.state, 'claimed'); assert.equal(stale.reason, 'claimed');
  assert.equal(f.store.count('publicMintPlots'), 1, 'retain its payment scan so a delayed payment is still refunded');
  const { WebCheckout } = await import('../src/web-checkout.mjs');
  const checkout = new WebCheckout({ store: f.store, mints: { public: id => f.mints.public(id) }, reads: { counted: async () => f.claims.counted },
    config: { mode: 'regtest', network: 'test', endpoints: {}, local: { escrow: { chainId: '31337' } } } });
  const plan = await checkout.plan('mint', started.id);
  assert.equal(plan.payable, false); assert.deepEqual(plan.redeem.items, []); assert.equal(plan.reason, 'claimed');
});

test('agent public_minted refusal remains a bounded HTTP code for old and new clients', async t => {
  const http = await serve({ intake: { accept: async () => { throw Error('public_minted'); } }, files: { serve: async () => false } }); t.after(() => http.close());
  const response = await fetch(http.url + '/moves', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'public_minted' });
});

test('authenticated asset provenance no longer blocks an untaken slot on unrelated open rounds', async () => {
  const { acceptedAssetProvenance } = await import('../src/asset-provenance.mjs');
  const named = r.emptyNamedDiscovery(), key = r.hash('provenance'), pattern = { key, number: '0', pat: '[0-9]', fld: 4, dt: 'n', tier: 1 };
  named.records = r.namedSet(r.namedSet(named.records, 'number/0', key), 'pattern/' + key, pattern);
  const saved = new r.NamedStorage({ get: () => undefined, cacheSize: 8 }).save(named);
  const initial = r.initialClaimSnapshot({ bitcoinAnchor: { height: '100' } }, '101');
  const storage = new r.ClaimStorage({ get: () => undefined, cacheSize: 8 });
  const claims = storage.load({ ...initial.hot, claimSnapshot: initial, claimRoot: r.claimStateRoot(initial) });
  claims.counted = '101'; claims.rounds.push({ window: '100', closed: false });
  const claim = storage.save(claims), rows = new Map([...saved.writes, ...claim.writes].map(w => [w.space + '/' + w.id, w.value]));
  const checkpoint = { named: saved.snapshot, claims: claim.state.claimSnapshot };
  const document = r.settingsRevision({ network: 'test', effectiveBatch: '1', effectiveBitcoinWindow: '100', values: {
    ...r.SETTINGS_PROFILE, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100', claimsNeverCloseHeight: '100' } });
  const context = { ready: true, catalogRoot: r.namedStateRoot(named), claimsRoot: claim.state.claimRoot, settings: document };
  const result = await acceptedAssetProvenance({ store: { get: async (space, id) => space === 'assetCheckpoint' ? checkpoint : rows.get(space + '/' + id) },
    reads: { rulesContext: async () => context }, asset: 'p2:0', block: '100' });
  assert.equal(result.find, null); assert.equal(result.publicClaims.unsettled, false); assert.equal(result.publicClaims.headerAward, false);
});

test('public list stops labeling linked plots holder-only exactly at the open-mint height', async t => {
  const f = await fixture(t, false, '1108'); await f.occurrence('100');
  const { heightKey } = await import('../src/util.mjs');
  await f.store.put('links', heightKey('100'), { block: '100', linkHeight: '100' });
  f.parent.document = r.settingsRevision({ network: f.document.network, previous: f.document,
    effectiveBatch: '2', effectiveBitcoinWindow: '1108', values: { ...f.document.values, bitmapMintOpenHeight: '1109' } });
  assert.equal(f.mints.state('p2:0', '100').bitmapHolderOnly, true);
  f.claims.counted = '1109'; await f.save();
  assert.equal(f.mints.state('p2:0', '100').bitmapHolderOnly, false);
  assert.equal(f.mints.list(new URLSearchParams({ asset: 'p2:0' })).rows[0].bitmapHolderOnly, false);
});


test('public block detail and list distinguish an additional ticker pending or completed mint from the official ticker', async t => {
  const f = await fixture(t, false, r.PER_TICKER_SUPPLY_HEIGHT), block = '100'; await f.occurrence(block);
  const deployment = r.hash('read-extra') + 'i0', generation = r.hash('read-generation'), id = r.hash('read-mint');
  await f.store.transact([
    { space: 'accountRecords', id: 'fd/external/' + r.hashObject(deployment), value: generation },
    { space: 'accountRecords', id: 'fd/' + generation, value: { asset: f.asset, deployment, official: 'official-generation' } },
    { space: 'accountRecords', id: r.capacityPlotKey(f.asset, block, deployment), value: id },
    { space: 'accountRecords', id: 'dc/' + id, value: { state: 'reserved', asset: f.asset, plot: block, supplyScope: deployment } }
  ]);
  const chosen = () => f.mints.state(f.asset, block, undefined, deployment);
  assert.equal(chosen().state, 'block_pending'); assert.equal(f.mints.state(f.asset, block).state, 'public');
  assert.equal(f.mints.list(new URLSearchParams({ asset: f.asset, deployment })).rows.length, 0);
  assert.equal(f.mints.list(new URLSearchParams({ asset: f.asset })).rows.length, 1);
  await f.store.put('accountRecords', 'dc/' + id, { state: 'minted', asset: f.asset, plot: block, supplyScope: deployment });
  assert.equal(chosen().state, 'already_minted'); assert.equal(f.mints.state(f.asset, block).state, 'public');
});
