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

async function fixture(t, legacy = false) {
  const store = await newStore();
  t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  const document = r.settingsRevision({ network: 'test', effectiveBatch: '1', effectiveBitcoinWindow: '100', values: {
    ...r.SETTINGS_PROFILE, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100', claimsNeverCloseHeight: '100' } });
  const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: '100' } }, '101');
  const storage = new r.ClaimStorage({ get: key => store.get('claimNodes', key), cacheSize: 8 });
  const claims = storage.load({ ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot) });
  claims.counted = '101';
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
    assert.equal(state.state, 'public', 'a recent untaken block is immediately public');
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
    height: '101', transactionIndex: '0', inscriptionIndex: '0', fees: [{ amount: '10' }], source: { private: 'not public' } };
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
    quote: { fees: [], claimDeadline: '1108' }, paymentIds: [payment.reference], created: '100', expiry: '200', state: 'scanning', payer: 'wallet' });
  const request = f.mints.public(id);
  assert.equal(request.state, 'refundable'); assert.equal(request.reason, 'claimed_first'); assert.equal(request.payable, false);
  assert.equal(Object.hasOwn(request, 'claimDeadline'), false);
  assert.equal(request.refunds[0].reason, 'claimed_first'); assert.equal(Object.hasOwn(request.refunds[0], 'source'), false);
  const refunds = f.mints.refunds(new URLSearchParams({ asset: 'p2:0', block: '100', tapAddress: 'wallet' }));
  assert.equal(refunds.rows.length, 1); assert.equal(refunds.rows[0].reason, 'claimed_first');
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
    feeQuote: { validFrom: '100', validUntil: '200', baseFee: '100' }, deployment: { id: 'deployment', tick: 'dmwtest' } };
  Object.assign(f.parent, { financial: { submit: async () => {} }, bitcoinNetwork: 'regtest', resources: { ...f.parent.resources, activeMints: 10 } });
  Object.assign(f.parent.reads, { batchStamp: async () => ({ counted: '101' }), financialDeployment: async () => ({ existing: true }), publicMintQuote: async body => { assert.equal(body.asset, 'p0'); return q; } });
  assert.equal(Object.hasOwn(await f.mints.quote(input), 'claimDeadline'), false);
  f.parent.provisioner = { request: async () => ({ state: 'needed' }) };
  const preparation = await f.mints.quote(input); assert.equal(preparation.state, 'deployment_needed'); assert.equal(Object.hasOwn(preparation, 'claimDeadline'), false);
  delete f.parent.provisioner;
  f.parent.reads.financialDeployment = async () => ({ existing: false });
  const waiting = await f.mints.quote(input); assert.equal(waiting.state, 'deployment_pending'); assert.equal(Object.hasOwn(waiting, 'claimDeadline'), false);
  f.parent.reads.financialDeployment = async () => ({ existing: true });
  const started = await f.mints.quote(input, true); assert.equal(started.payable, true); assert.equal(Object.hasOwn(started, 'claimDeadline'), false);
  f.claims.claimReservations = r.recordSet(f.claims.claimReservations, r.findIdV2('100', '0'), { window: '101' }); await f.save();
  const stale = f.mints.public(started.id); assert.equal(stale.payable, false); assert.equal(stale.state, 'claimed'); assert.equal(stale.reason, 'claimed');
  assert.equal(f.store.count('publicMintPlots'), 1, 'retain its payment scan so a delayed payment is still refunded');
  const { WebCheckout } = await import('../src/web-checkout.mjs');
  const checkout = new WebCheckout({ store: f.store, mints: { public: id => f.mints.public(id) }, reads: { counted: async () => '101' },
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
