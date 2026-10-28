import { assertPublicIdentities } from '../../rules/test/public-identities.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { PublicViews } from '../src/public-views.mjs';
import { PublicIndex } from '../src/public-index.mjs';
import { eventSpec } from '../src/read-specs.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { createFeePolicy } from '../src/fees.mjs';
import { Mints } from '../src/mints.mjs';
import { serve } from '../src/http.mjs';
import { rules } from '../src/rules.mjs';
import { hash, heightKey } from '../src/util.mjs';
import { agent, patterns, fixtureHistory, temp, network, makeMove, feeFixture } from './helpers.mjs';

async function fixture(t, bitcoinNetwork = 'mainnet') {
  const store = await Store.open(await temp('public-')), files = new Files(join(store.directory, 'static')), history = fixtureHistory(30), owner = agent().address, other = agent(2).address;
  const fees = feeFixture({ store }), table = Array.from({ length: 3 }, (_, number) => ({ ...patterns[0], number, name: 'dmw' + number, discoverer: number === 0 ? owner : null }));
  const registry = { feePolicy: createFeePolicy('100'), assets: Object.fromEntries(table.map(p => [rules.patternAsset(p), { id: 'deployment' }])) };
  let counted = 30;
  const reads = { ...fees, bindings: { bitcoinNetwork }, head: async () => ({ tip: { height: 30 }, counted }), counted: async () => counted, batchLast: async () => ({ n: 1, to: counted }),
    tip: async () => ({ tip: 30 }), settings: async () => ({ pending_blocks: 432 }), registry: async () => registry,
    assetSupply: async () => ({ p0: '100', p1: '100', p2: '100' }), bitmaps: async () => [], balance: async () => '100', link: async block => store.get('links', heightKey(block)),
    bitmap: async () => ({ agent: other, address: 'bitmap-address' }), tap: async () => ({ action: 'claim', total: '100', al: [{ tt: 'b', amt: '20' }] }),
    escrowDeposit: async () => ({ deposit: { status: 2, amount: '100', payer: 'payer' } }),
    publicTreasury: async () => ({ treasury: { tap: '20', erc20: '30' }, outstandingSupply: { ethereum: '1000' } }),
    assetContext: async () => ({ deployment: { active: true, kind: 'dmt' }, find: { count: 2, finder: owner }, treasury: 'treasury', finderAddress: 'finder', discoverer: 'discoverer', tier: 1 }),
  };
  const mints = new Mints({ store, network, reads });
  const ops = [{ space: 'meta', id: 'patterns', value: table }, { space: 'meta', id: 'head', value: { tip: 30, highestTip: 30 } },
    { space: 'meta', id: 'ruleState', value: { rounds: [], discoveryCommits: [{ agent: owner, commitment: hash('sealed'), tip: 30, proposal: { name: 'never-public' }, salt: 'never-public' }] } }];
  for (let block = 1; block < 5; block++) {
    const find = { block, pattern: 0, asset: 'p0', count: 1, finder: owner, findHeight: block + 3, window: block };
    ops.push({ space: 'finds', id: rules.findId(block, 0), value: find },
      { space: 'publicClaims', id: String(block), value: { block: 1, agent: owner, window: 1, reason: 'accepted', patterns: [0, 1, 2] } },
      { space: 'publicDraws', id: String(block), value: { block: 1, window: block, settledAt: block + 3, winners: [], slotUsage: { used: 0, total: 16 } } },
      { space: 'receiptObservations', id: block + '/' + hash(String(block)), value: { seal: { tip: block }, archive: null } });
  }
  for (let n = 0; n < 3; n++) {
    const id = hash('mint' + n), request = { owner, asset: 'p0', block: n + 1, amount: '1' };
    ops.push({ space: 'mints', id, value: { id, request, kind: n === 0 ? 'ethereum' : 'tap', state: 'minted', payer: 'payer', payment: n === 0 ? { depositFinal: true } : { requiredConfirmations: 1, receipts: [{ key: hash('paid'+n), origin:id, role:'burn', to:rules.tapBurnAddress(bitcoinNetwork), ticker:'tap', tt:'a', amount:'20', accepted:true, confirmations:n === 1 ? 1 : 0 }] }, secret: 'never-public', quote: { price: '100', baseFee: '100', split: { burn: '20' }, fees: [{role:'burn',to:n === 0 ? null : rules.tapBurnAddress(bitcoinNetwork),ticker:'tap',amount:'20',tt:n === 0 ? 'b' : 'a'}] } } },
      { space: 'payoutTotals', id, value: { beneficiary: 'beneficiary' + n, accrued: '25', paid: '10' } },
      { space: 'commissionOwed', id, value: { amount: '25', role: 'discoverer', to: 'beneficiary' + n } },
      { space: 'payoutPaid', id, value: { amount: '10', beneficiary: 'beneficiary' + n, txid: hash('payout' + n) } },
      { space: 'links', id: heightKey(n + 1), value: { block: n + 1, linkHeight: 0 } });
  }
  for (let n = 1; n <= 205; n++) ops.push({ space: 'publicEvents', id: heightKey(n), value: { sequence: n, id: hash('event' + n), at: n, type: 'claim', data: { agent: owner, patterns: [0, 1, 2] }, provenance: { height: n } } });
  for (let h = 0; h < history.length; h++) ops.push({ space: 'headers', id: heightKey(h), value: { fields: history.get(h), hash: history.hashAt(h) } });
  await store.transact(ops);
  const views = new PublicViews({ store, files, history, reads, mints, network }), api = createPublicAPI({ views, files });
  const http = await serve({ intake: { store }, files, mints, publicAPI: api });
  t.after(async () => { await http.close(); await store.close(); });
  const get = async path => { const r = await fetch(http.url + path); assert.equal(r.status, 200, path + ' ' + await r.clone().text()); const value = await r.json(); assertPublicIdentities(value); return value; };
  return { store, files, history, owner, other, reads, registry, views, api, http, get, setCounted: n => { counted = n; } };
}

test('each public collection is paged and its scoped cursor retrieves all rows', async t => {
  const f = await fixture(t);
  for (const [path, key] of [
    ['/world', 'plots'], ['/blocks', 'plots'], ['/patterns', 'patterns'], ['/table', 'patterns'], ['/patterns/p0/blocks', 'rows'],
    ['/finds', 'finds'], ['/receipts', 'receipts'], ['/agents', 'agents'], ['/events', 'events'], ['/feed', 'events'], ['/records/batches', 'batches'],
    [`/mint-rights?owner=${encodeTracAddress(f.owner)}`, 'mintRights'], [`/agents/${encodeTracAddress(f.owner)}/balances`, 'balances'], [`/agents/${encodeTracAddress(f.owner)}/finds`, 'finds'],
    [`/agents/${encodeTracAddress(f.owner)}/mintRights`, 'mintRights'], [`/agents/${encodeTracAddress(f.owner)}/bitmaps`, 'bitmaps'], [`/agents/${encodeTracAddress(f.owner)}/discoveries`, 'discoveries'], [`/agents/${encodeTracAddress(f.owner)}/history`, 'history'],
    ...['finds', 'claims', 'draws', 'matches', 'slotList', 'mintRights'].map(k => ['/blocks/1/' + k, k]),
    ...['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links'].map(k => ['/results/' + k, k]),
    ['/compounds', 'compounds'],
  ]) await t.test(path, async () => {
    const url = new URL(path, f.http.url); url.searchParams.set('limit', '2'); const rows = [];
    let total;
    for (let n = 0; n < 110; n++) {
      const page = await f.get(url.pathname + url.search); total ??= page.total;
      assert.ok(page[key].length <= 2); assert.equal(page.limit, 2); assert.equal(page.total, total);
      rows.push(...page[key]); if (!page.next) break; url.searchParams.set('cursor', page.next);
    }
    assert.equal(rows.length, total);
  });
});

test('public limits, filtering, nested pages, immutable artifacts, HEAD and ETags', async t => {
  const f = await fixture(t);
  assert.equal((await f.get('/events')).events.length, 50); assert.equal((await f.get('/events?limit=200')).events.length, 200);
  for (const path of ['/events?limit=201', '/events?limit=0', '/events?limit=1&limit=2', '/finds?minted=yes', '/finds?sort=no', '/events?category=private', '/blocks?from=3&to=2']) assert.equal((await fetch(f.http.url + path)).status, 400, path);
  assert.equal((await fetch(f.http.url + '/blocks/999')).status, 404);
  assert.equal((await f.get('/events?since=200&order=asc')).total, 5);
  const first = await f.get('/events?limit=2');
  assert.equal((await fetch(f.http.url + '/finds?cursor=' + first.next)).status, 400);
  const profile = await f.get('/agents/' + encodeTracAddress(f.owner) + '?limit=1');
  assert.equal(profile.discoveries.length, 1); assert.equal(profile.counts.discoveries, 2);
  assert.equal(JSON.stringify(profile).includes('never-public'), false);
  const sealed = await f.get(`/agents/${encodeTracAddress(f.owner)}/discoveries?state=sealed`);
  assert.deepEqual(sealed.discoveries[0], { state: 'sealed', exists: true, opensAt: 32 });
  const block = await f.get('/blocks/1?limit=1');
  assert.deepEqual(block.claimWindow, { window: 30, closesAt: 32, drawAt: 32, settlesAt: 32, claimable: true, claimsPerWindow: rules.CLAIM_DEFAULTS.claimsPerWindow });
  const nested = block.claims[0].pages.patterns;
  const nestedURL = new URL(nested.route, f.http.url); nestedURL.searchParams.set('cursor', nested.next); nestedURL.searchParams.set('limit', '1');
  assert.deepEqual((await f.get(nestedURL.pathname + nestedURL.search)).items, [1]);
  const results = await f.get('/results?limit=1'); assert.equal(results.mints.length, 1); assert.equal(results.counts.mints, 3); assert.equal(results.burn.tap, '20');
  assert.equal(JSON.stringify(results).includes('never-public'), false);
  assert.equal((await f.get('/results?kind=payouts&limit=1')).total, 3);
  const artifact = await f.files.json('patterns/p0/0-' + 'a'.repeat(64) + '.json', { rows: Array.from({ length: 256 }, (_, i) => i) }, { immutable: true });
  const raw = await fetch(f.http.url + artifact.path); assert.equal(hash(Buffer.from(await raw.text())), artifact.hash);
  const query = new URLSearchParams({ source: artifact.path, path: '/rows', limit: '1' }); assert.equal((await f.get('/list?' + query)).total, 256);
  for (const path of ['/table/index.json', '/table/0.json', `/agents/${encodeTracAddress(f.owner)}/0.json`, '/patterns/p0/index.json', '/patterns/p0/0.json', '/world.json', '/records/index.json']) {
    await f.files.json(path.slice(1), { rows: [1, 2], next: '1.json' });
    assert.equal((await fetch(f.http.url + path)).status, 404, path);
    assert.equal((await fetch(f.http.url + '/list?' + new URLSearchParams({ source: path, path: '/rows' }))).status, 404, path);
  }
  const res = await fetch(f.http.url + '/finds'); await res.arrayBuffer();
  assert.equal((await fetch(f.http.url + '/finds', { headers: { 'if-none-match': res.headers.get('etag') } })).status, 304);
  assert.equal(await (await fetch(f.http.url + '/finds', { method: 'HEAD' })).text(), '');
});

test('mint rights require finds and include other finders and expired finder windows; quotes explain units and liabilities', async t => {
  const f = await fixture(t);
  let rights = await f.get(`/mint-rights?owner=${encodeTracAddress(f.other)}&asset=p0`);
  assert.equal(rights.total, 4); assert.equal(rights.mintRights[0].allowed, false); assert.equal(rights.mintRights[0].reason, 'finder');
  const publicSlot = await f.get(`/mint-rights?owner=${encodeTracAddress(f.other)}&asset=p1&reason=public`); assert.equal(publicSlot.total, 0);
  f.setCounted(1100); rights = await f.get(`/mint-rights?owner=${encodeTracAddress(f.other)}&asset=p0&block=1`);
  assert.equal(rights.mintRights[0].reason, 'bitmap'); assert.equal(rights.mintRights[0].allowed, true);
  await f.store.put('minted', 'p0/1', 'inscription'); assert.equal((await f.get(`/mint-rights?owner=${encodeTracAddress(f.other)}&asset=p0&block=1`)).mintRights[0].reason, 'minted');
  const response = await fetch(f.http.url + '/mint/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ asset: 'p0', block: 1 }) });
  assert.equal(response.status, 200); const quote = await response.json(); assert.equal(quote.unitsUsed, '2'); assert.equal(quote.matterUnit.decimals, 0);
  assert.equal(quote.unit.decimals, 18); assert.equal(quote.feeDestinations.discoverer.settlement, 'direct'); assert.equal(quote.feeDestinations.finder.to, 'finder');
});

test('public event index replays accepted audits and transfers once, without exposing sealed payloads', async t => {
  const f = await fixture(t), move = makeMove(f.history, 10), file = { observation: 1, height: 10, tip: 10, receiptRoot: { network },
    moves: [{ move, reason: 'accepted' }], receipts: [], settlements: [], discoveries: [], crafts: [], mintOperations: [], linkOperations: [] };
  const audit = await f.files.immutable('blocks/public.bin', Buffer.from(rules.encodeBinary(file)));
  const root = rules.merkleRoot([rules.encodeBinary(file)]);
  await f.store.transact([{ space: 'publishedObservations', id: heightKey(1), value: { audit } }, { space: 'meta', id: 'publicSequence', value: 205 },
    { space: 'batches', id: heightKey(1), value: { batch: { n: 1, root }, publications: [{ observation: 1, audit }] } }]);
  f.reads.publicTransactions = async after => ({ rows: after ? [] : [{ index: 0, tx: hash('tx'), ipk: f.owner, val: { type: 'tf', value: { to: f.other, assets: [['p0', '1']] } }, err: null }], next: 1 });
  const index = new PublicIndex(f); await index.tick(); await index.tick();
  const events = await f.get('/events?since=205&order=asc'); assert.deepEqual(events.events.map(e => e.type), ['block', 'claim', 'transfer']);
  assert.equal(events.events[0].provenance.root, root);
  const batch = await f.get(events.events[0].provenance.manifest); assert.equal(batch.batch.root, root); assert.equal(batch.counts.publications, 1);
  assert.equal(events.events[2].at, f.history.get(30).time * 1000); assert.equal(events.events[2].provenance.timeSource, 'indexed_counted_block');
  assert.equal(events.events[2].provenance.transaction, hash('tx')); assert.equal(f.store.get('meta', 'publicSequence'), 208);
});

test('accepted discovery, craft, mint, link events carry only public selected fields', async t => {
  const f = await fixture(t), request = { owner: f.owner, asset: 'p0', block: 1, amount: '1', receive: hash('receiver'), nonce: hash('request'), until: 50, expires: 60 };
  const reveal = { ...makeMove(f.history, 10), t: 'discovery-reveal', p: { proposal: { name: 'dmwpublic', pat: '1', fld: 4, dt: 'n' }, salt: 'a'.repeat(64) } };
  const file = { observation: 1, height: 10, tip: 10, receiptRoot: { network }, moves: [{ move: reveal, reason: 'accepted' }], receipts: [],
    settlements: [{ window: 1, winners: [{ id: 'winner', block: 1, asset: 'p0', count: 1, winner: f.owner }] }],
    discoveries: [{ record: { ...patterns[0], discoverer: f.owner } }], crafts: [{ id: 'compound', firstMaker: f.other }], ops: [{ op: 'xc', request: { owner: f.owner } }],
    mintOperations: [{ op: 'rq', request }, { op: 'mc', request, evidence: { authorization: {permit:{hash:hash('permit')}}, private: 'never-public' } }, { op: 'rq', request }],
    mintOutcomes: [{ reason: 'accepted' }, { reason: 'accepted' }, { reason: 'deferred' }],
    linkOperations: [{ request: { owner: f.owner, height: 1 } }], linkOutcomes: [{ reason: 'accepted' }] };
  const audit = await f.files.immutable('blocks/types.bin', Buffer.from(rules.encodeBinary(file)));
  await f.store.transact([{ space: 'publishedObservations', id: heightKey(1), value: { audit } }, { space: 'meta', id: 'publicSequence', value: 205 }]);
  await new PublicIndex(f).tick();
  const events = (await f.get('/events?since=205&order=asc')).events;
  assert.deepEqual(events.map(e => e.type), ['block', 'discovery', 'find', 'discovery', 'craft', 'mint_request', 'mint_permit', 'link']);
  assert.deepEqual((await f.get('/events?since=205&category=money&order=asc')).events.map(e => e.type), ['mint_request', 'mint_permit', 'link']);
  assert.deepEqual(events.filter(e => eventSpec.match(e, { category: 'money' })).map(e => e.type), ['mint_request', 'mint_permit', 'link']);
  assert.equal(events.find(e => e.type === 'craft').data.owner, encodeTracAddress(f.owner)); assert.equal(JSON.stringify(events).includes('never-public'), false);
});

test('rights require live deployment registration, including compounds, filters and all indexed aliases', async t => {
  const f = await fixture(t);
  delete f.registry.assets.p1;
  for (let block = 1; block < 5; block++) await f.store.put('finds', rules.findId(block, 1), { block, pattern: 1, asset: 'p1', count: 1, finder: f.owner, findHeight: 3, window: 1, source: 'claim' });
  await f.store.put('types', 'c1', { id: 'c1', amount: '7', inputs: [['p0', '1']], recipe: 'fusion' });
  for (const path of [`/mint-rights?owner=${encodeTracAddress(f.owner)}`, `/agents/${encodeTracAddress(f.owner)}/mintRights`, `/blocks/1/mintRights?owner=${encodeTracAddress(f.owner)}`, '/blocks/1/mintRights']) {
    const url = new URL(path, f.http.url); url.searchParams.set('asset', 'p1');
    const page = await f.get(url.pathname + url.search);
    assert.ok(page.total); assert.ok(page.mintRights.every(r => r.rightAllowed && !r.allowed && !r.deploymentRegistered && r.reason === 'asset_unregistered'));
    url.searchParams.set('allowed', 'true'); assert.equal((await f.get(url.pathname + url.search)).total, 0);
    url.searchParams.delete('allowed'); url.searchParams.set('reason', 'asset_unregistered');
    assert.equal((await f.get(url.pathname + url.search)).total, page.total);
  }
  let rights = await f.get(`/agents/${encodeTracAddress(f.owner)}/mintRights?asset=c1`);
  assert.equal(rights.mintRights[0].allowed, false); assert.equal(rights.mintRights[0].rightAllowed, true);
  f.registry.assets.p1 = { id: 'p1-deployment' }; f.registry.assets.c1 = { id: 'c1-deployment' };
  for (const asset of ['p1', 'c1']) {
    rights = await f.get(`/agents/${encodeTracAddress(f.owner)}/mintRights?asset=${asset}&allowed=true&sort=reason&limit=1`);
    assert.ok(rights.total); assert.equal(rights.mintRights[0].deploymentRegistered, true);
    assert.equal(rights.mintRights[0].allowed, true);
  }
  delete f.registry.assets.p1;
  assert.equal((await f.get(`/agents/${encodeTracAddress(f.owner)}/mintRights?asset=p1&allowed=true`)).total, 0);
  assert.deepEqual((await f.views.rights(f.owner, 1)).map(r => [r.asset, r.allowed, r.deploymentRegistered]),
    (await f.get(`/blocks/1/mintRights?owner=${encodeTracAddress(f.owner)}&sort=asset&order=asc`)).mintRights.map(r => [r.asset, r.allowed, r.deploymentRegistered]));
  const compound = (await f.get('/compounds')).compounds[0];
  assert.equal(Object.hasOwn(compound, 'amount'), false); assert.equal(compound.supply, '0');
  assert.equal(f.store.get('types', 'c1').amount, '7', 'the craft record retains its amount');
});

test('public index progress compares ordinals and reports actual indexed heights and batch lag', async t => {
  const f = await fixture(t);
  const latest = { observation: 12, height: 25, tip: 30 };
  await f.store.transact([
    { space: 'meta', id: 'latest', value: latest },
    { space: 'publishedObservations', id: heightKey(11), value: { observation: 11, height: 24, tip: 29 } },
    { space: 'publishedObservations', id: heightKey(12), value: latest },
    { space: 'meta', id: 'publicObservation', value: heightKey(11) },
    { space: 'batches', id: heightKey(1), value: { batch: { n: 1, to: 25 } } },
  ]);
  let progress = (await f.get('/status')).publicIndex;
  assert.deepEqual(progress, { processedObservation: 11, latestObservation: 12, observationLag: 1,
    indexedHeight: 24, indexedTip: 29, latestHeight: 25, latestTip: 30, processedBatch: 0, latestBatch: 1,
    batchLag: 1, indexedBatchHeight: null, eventSequence: 0, caughtUp: false });
  await f.store.put('meta', 'publicObservation', heightKey(12));
  assert.equal((await f.get('/status')).publicIndex.caughtUp, false, 'batch provenance is still behind');
  await f.store.put('meta', 'publicBatch', heightKey(1));
  progress = (await f.get('/status')).publicIndex;
  assert.equal(progress.caughtUp, true); assert.equal(progress.indexedHeight, 25); assert.equal(progress.indexedBatchHeight, 25);
  await f.store.transact([{ space: 'meta', id: 'publicObservation' }, { space: 'meta', id: 'publicBatch' }]);
  progress = (await f.get('/status')).publicIndex;
  assert.equal(progress.indexedHeight, null); assert.equal(progress.observationLag, 12); assert.equal(progress.caughtUp, false);
});

test('results show item receipts and count final burns once across payment credits', async t => {
  const f = await fixture(t);
  f.reads.tap = async () => { throw Error('mint_must_not_read_retired_locks'); };
  const original=f.store.get('mints',hash('mint1')), credit=f.store.get('mints',hash('mint2'));
  await f.store.put('mints',credit.id,{...credit,payment:{...credit.payment,receipts:[...credit.payment.receipts,...original.payment.receipts]}});
  f.reads.escrowDeposit = async () => ({ deposit: { status: 2, split: { burnAmount: '30' } } });
  let result = await f.get('/results');
  assert.deepEqual(result.burn, { tap: '20', ethereum: '30' });
  assert.equal(result.counts.payments,2);
  assert.equal((await f.get('/results/payments?action=paid')).total,2);
  assert.deepEqual(result.outstandingSupply, { ethereum: '1000' });
  f.reads.escrowDeposit = async () => ({ deposit: { status: 3, split: { burnAmount: '30' } } });
  result = await f.get('/results'); assert.equal(result.burn.ethereum, '0');
});

test('/list refuses rights sources before materializing them; dedicated pages and other nested lists remain', async t => {
  const f = await fixture(t);
  f.views.rights = () => { throw Error('rights must use the indexed route'); };
  for (const source of [`/mint-rights?owner=${encodeTracAddress(f.owner)}`, `/agents/${encodeTracAddress(f.owner)}/mintRights`, '/blocks/1/mintRights', `/agents/${encodeTracAddress(f.owner)}`, '/blocks/1']) {
    const response = await fetch(f.http.url + '/list?' + new URLSearchParams({ source, path: '/mintRights', limit: '1' }));
    assert.equal(response.status, 400, source); assert.equal((await response.json()).error, 'list_source_has_dedicated_route');
  }
  assert.ok((await f.get(`/agents/${encodeTracAddress(f.owner)}/mintRights?limit=1`)).total);
});


test('whoMayMint filters equal filtering the unfiltered public rows on every rights route', async t => {
  const f = await fixture(t);
  await f.store.put('types', 'c1', { id: 'c1', inputs: [['p0', '1']], recipe: 'fusion' });
  f.registry.assets.c1 = { id: 'compound' };
  delete f.registry.assets.p2;
  for (const owner of [f.owner, f.other]) for (const base of [`/mint-rights?owner=${encodeTracAddress(owner)}`, `/agents/${encodeTracAddress(owner)}/mintRights`, `/blocks/1/mintRights?owner=${encodeTracAddress(owner)}`]) {
    const all = (await f.get(base)).mintRights;
    for (const role of ['public', 'finder', 'holder', 'me', 'none']) {
      const expected = all.filter(r => role === 'me' ? r.allowed : role === 'none' ? !r.allowed : r.whoMayMint === role);
      const url = new URL(base, f.http.url); url.searchParams.set('whoMayMint', role); url.searchParams.set('limit', '2');
      const actual = []; let page;
      do { page = await f.get(url.pathname + url.search); assert.equal(page.total, expected.length); actual.push(...page.mintRights); if (page.next) url.searchParams.set('cursor', page.next); } while (page.next);
      assert.deepEqual(actual, expected, base + ' ' + role);
    }
  }
});

test('nested pointers address the returned filtered and cursor page positions', async t => {
  const f = await fixture(t);
  for (const n of [1, 2]) await f.store.put('types', 'c' + n, { id: 'c' + n, inputs: [['p0', String(n)], ['p1', '1']], recipe: 'fusion' });
  for (const sequence of [201, 204, 205]) await f.store.put('publicEvents', heightKey(sequence), { sequence, id: hash('event' + sequence), type: 'claim', at: sequence, data: { patterns: [sequence, sequence + 1, sequence + 2] } });
  const first = await f.get('/events?limit=1&order=desc');
  for (const source of ['/events?since=200&limit=1&order=asc', '/events?limit=1&order=desc&cursor=' + first.next, '/compounds?asset=c2&limit=1']) {
    const page = await f.get(source), key = page.events ? 'events' : 'compounds', row = page[key][0];
    const pointer = key === 'events' ? '/events/0/data/patterns' : '/compounds/0/inputs';
    const nested = key === 'events' ? row.data.pages.patterns : row.pages.inputs;
    assert.equal(new URL(nested.route, f.http.url).searchParams.get('path'), pointer);
    const manual = await f.get('/list?' + new URLSearchParams({ source, path: pointer }));
    const supplied = await f.get(nested.route);
    assert.deepEqual(manual.items, supplied.items);
    assert.equal(manual.total, key === 'events' ? 3 : 2);
    if (key === 'compounds') assert.deepEqual(manual.items[0], ['p0', '2']);
    else assert.equal(manual.items[0], row.sequence);
  }
  const bad = await fetch(f.http.url + '/list?' + new URLSearchParams({ source: '/compounds?asset=c2&limit=1', path: '/compounds/1/inputs' }));
  assert.equal((await bad.json()).error, 'list_path_missing');
});


test('nested array wrappers also use pointers into their returned items page', async t => {
  const f = await fixture(t);
  await f.store.put('publicEvents', heightKey(206), { id: hash('nested'), sequence: 206, at: 1, type: 'craft', data: { matrix: [[1, 2, 3], [4, 5, 6]] } });
  const source = '/events?type=craft&limit=1', page = await f.get(source);
  const first = page.events[0].data.matrix[0];
  assert.deepEqual(first.items, [1]);
  assert.equal(new URL(first.route, f.http.url).searchParams.get('path'), '/events/0/data/matrix/0/items');
  assert.deepEqual((await f.get(first.route)).items, [1, 2, 3]);
  const parent = page.events[0].data.pages.matrix;
  const secondURL = new URL(parent.route, f.http.url); secondURL.searchParams.set('cursor', parent.next); secondURL.searchParams.set('limit', '1');
  const second = await f.get(secondURL.pathname + secondURL.search);
  assert.deepEqual(second.items[0].items, [4]);
  assert.deepEqual((await f.get(second.items[0].route)).items, [4, 5, 6]);
});

test('queued discovery rejections publish a commitment and actor after the reveal observation', async t => {
  const f = await fixture(t), salt = 'c'.repeat(64), proposal = { name: 'dmwrejected', pat: '1', fld: 4, dt: 'n' };
  const reveal = { ...makeMove(f.history, 10), t: 'discovery-reveal', a: f.owner, p: { proposal, salt } };
  const commitment = rules.discoveryCommitment(proposal, salt, f.owner);
  for (const observation of [1, 2]) {
    const file = { observation, height: 10 + observation, tip: 10 + observation, receiptRoot: { network },
      moves: observation === 1 ? [{ move: reveal, reason: 'accepted' }] : [], receipts: [], settlements: [], discoveries: [], crafts: [], mintOperations: [], linkOperations: [],
      discovery: { rejected: observation === 2 ? [{ commitment, reason: 'pattern_duplicate' }] : [] } };
    const audit = await f.files.immutable(`blocks/discovery-${observation}.bin`, Buffer.from(rules.encodeBinary(file)));
    await f.store.put('publishedObservations', heightKey(observation), { audit });
  }
  await f.store.put('meta', 'publicSequence', 205);
  const index = new PublicIndex(f); await index.tick({ limit: 1 }); await index.tick({ limit: 1 });
  const events = await f.get('/events?type=discovery&order=asc');
  assert.deepEqual(events.events.map(e => e.data.state), ['revealed', 'rejected']);
  assert.equal(events.events[1].data.commitment, commitment); assert.equal(events.events[1].data.agent, encodeTracAddress(f.owner));
  assert.equal(events.events[1].data.reason, 'pattern_duplicate'); assert.equal(JSON.stringify(events).includes(salt), false);
});

test('public routes reject raw keys and expose canonical identity filters and cursor anchors', async t => {
  const f = await fixture(t), address = encodeTracAddress(f.owner);
  for (const path of ['/agents/' + f.owner, '/finds?owner=' + f.owner, '/events?actor=' + f.owner, '/agents?q=' + f.owner, '/mint-rights?owner=' + f.owner]) {
    const res = await fetch(f.http.url + path); assert.equal(res.status, 400); assert.match((await res.json()).error, /trac1/);
  }
  const found = await f.get('/agents?q=' + address.slice(0, 13)); assert.ok(found.agents.some(a => a.address === address));
  const page = await f.get('/agents?sort=address&order=asc&limit=1');
  if (page.next) {
    const anchor = JSON.parse(Buffer.from(page.next.split('.')[0], 'base64url'));
    assert.match(anchor.key, /^trac1/); assert.ok(!anchor.tie.includes(f.owner));
    assert.ok((await f.get(page.route + '?sort=address&order=asc&limit=1&cursor=' + page.next)).agents.length);
  }
  assert.equal((await f.get('/agents/' + address)).address, address);
});

test('regtest quotes and public burn totals use the configured eater encoding', async t => {
  const f = await fixture(t, 'regtest');
  const response = await fetch(f.http.url + '/mint/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ asset: 'p0', block: 1 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fees.find(f => f.role === 'burn').to, rules.tapBurnAddress('regtest'));
  assert.equal((await f.get('/results')).burn.tap, '20');
  const row = f.store.get('mints', hash('mint1'));
  row.payment.receipts[0].to = rules.TAP_BURN;
  await f.store.put('mints', row.id, row);
  assert.equal((await f.get('/results')).burn.tap, '0');
});

test('public status exposes the live fee multipliers and exact price unit', async t => {
  const f = await fixture(t);
  const { changeFeePolicy } = await import('../src/fees.mjs');
  f.registry.feePolicy = changeFeePolicy(f.registry, { link: 3, compoundMinimum: 12, tierMultipliers: [2, 4, 12, 40, 120] }, 1000).feePolicy;
  const status = await f.get('/status?limit=1');
  assert.deepEqual(status.feePolicy.feeSettings, { link: 3, compoundMinimum: 12, tierMultipliers: [2, 4, 12, 40, 120] });
  assert.equal(status.feePolicy.revision, f.registry.feePolicy.current);
  assert.equal(status.feePolicy.unit.decimals, 18);
});
