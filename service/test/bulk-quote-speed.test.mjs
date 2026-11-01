import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, address, digest, r } from './bulk-helpers.mjs';
import { configFixture } from '../prod/test/helpers.mjs';
import { updateRegistryAsset } from '../src/registry.mjs';
import { TapReader } from '../prod/tap.mjs';
import { serve } from '../src/http.mjs';
import { plotKey } from '../../contract/financial-capacity.js';
import { buildFinancialExecution } from '../src/financial-execution.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';

// Exercise the production assetContext, provenance, deployment, TAP and bulk
// source adapters. Only remote transports and payout certificates are fixtures.
// Nothing in this test opens a live service or reads an operator configuration.
const configuration = await import('../prod/config.mjs');
mock.module('../prod/config.mjs', { exports: { ...configuration, validateConfig: async () => {} } });
let active;
mock.module('../prod/bitcoin.mjs', { exports: {
  createBitcoin: async () => active.bitcoin,
  BitcoinViews: class {
    ordinal(n) { return Number(n); }
    async view() { return { hashAt: () => active.at().tipHash }; }
    close() {}
  }
} });
mock.module('../prod/tap.mjs', { exports: { createTap: async () => active.indexer } });
mock.module('../prod/ethereum.mjs', { exports: { createEthereum: async () => ({ rpc: () => assert.fail('unexpected Ethereum read'), escrow: {} }) } });
mock.module('../prod/trac.mjs', { exports: { configuredTrac: async () => active.trac } });
const { productionReads } = await import('../prod/reads.mjs');

async function productionFixture(t, { latency = 0, linked = true, committee = false } = {}) {
  const f = await fixture(t), base = { ...f.reads }, { config } = await configFixture(t), input = f.input(64);
  const pattern = { number: '123', key: digest('speed-pattern'), pat: '123', fld: 4, dt: 'n', tier: 1 };
  const named = r.emptyNamedDiscovery();
  named.records = r.namedSet(r.namedSet(named.records, 'number/123', pattern.key), 'pattern/' + pattern.key, pattern);
  const saved = new r.NamedStorage({ get: () => undefined, cacheSize: 8 }).save(named);
  const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: f.stamp().counted } }, f.stamp().counted);
  const claims = new r.ClaimStorage({ get: () => undefined, cacheSize: 8 });
  const hot = claims.load({ ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot) });
  for (const block of input.blocks) {
    const context = await base.assetContext(input.asset, block, { bulkMint: true });
    hot.finds = r.recordSet(hot.finds, r.findIdV2(block, '123'), context.find);
  }
  const claim = claims.save(hot);
  await f.store.transact([...saved.writes, ...claim.writes,
    { space: 'assetCheckpoint', id: 'current', value: { named: saved.snapshot, claims: claim.state.claimSnapshot } }]);
  const entry = { ...f.deployment, asset: input.asset, pattern, options: {}, indexTick: 'dmt-example', tap: { treasury: address(3) } };
  await updateRegistryAsset(config.prod.registry, input.asset, () => entry);
  const calls = [], minted = new Set(), links = new Map(), holders = new Map(), authority = { ...await base.authority(), epoch: '0', paused: false };
  for (const block of input.blocks) if (linked) {
    links.set(block, { owner: f.owner, block, linkHeight: f.stamp().counted }); holders.set(block, address(5));
  }
  let sourceDelay = 0, batchHook, bitmapAgent = f.owner, bitcoinHash = f.stamp().tipHash, cancelled = false, rawRevision = 0, rootOverride;
  const at = () => ({ ...f.stamp(), revision: String(rawRevision), tipHash: bitcoinHash });
  const wait = async () => { if (sourceDelay) await delay(sourceDelay); };
  const bitcoin = {
    tip: async () => ({ height: at().tip, hash: at().tipHash }),
    blockHash: async () => { await wait(); return at().tipHash; },
    included: async () => { await wait(); return { height: at().counted, blockHash: at().tipHash, confirmations: 1 }; }
  };
  const source = { request: async path => {
    calls.push(path); await wait();
    if (path === '/r/tap/getCurrentBlock') return { result: at().tip };
    if (path.startsWith('/r/blockhash/')) return at().tipHash;
    if (path.startsWith('/content/')) {
      const value = await base.content(path.slice('/content/'.length));
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
    if (path.startsWith('/inscription/')) {
      const id = path.slice('/inscription/'.length), block = input.blocks.find(block => digest('bitmap/' + block) + 'i0' === id);
      return { id, address: holders.get(block) };
    }
    const key = path.slice('/r/tap/'.length);
    if (key.startsWith('getDeployment/')) return { result: { ...await base.tap(key), tick: 'dmt-example' } };
    if (key.startsWith('getPrivilegeAuthCancelled/')) return { result: cancelled };
    if (key.startsWith('getMintTokensLeft/')) return { result: await base.tap(key) };
    if (key === 'getPrivilegeAuthListLength') return { result: 1 };
    if (key.startsWith('getPrivilegeAuthList?')) return { result: [{ ins: entry.privilege }] };
    if (key === 'getDmtElementsListLength') return { result: 1 };
    if (key.startsWith('getDmtElementsList?')) return { result: [await base.element()] };
    if (key.startsWith('getBitmap/')) {
      const block = key.split('/').at(-1);
      return { result: { bm: block, ownr: holders.get(block), ins: digest('bitmap/' + block) + 'i0' } };
    }
    if (key.startsWith('getDmtMintHolderByBlock/')) {
      const hook = batchHook; batchHook = null; await hook?.();
      return { result: minted.has(key.split('/').at(-1)) ? { ins: digest('already-minted') + 'i0' } : null };
    }
    assert.fail('unexpected TAP path ' + path);
  } };
  const indexer = new TapReader({ sources: [source], agreement: 1, bitcoin });
  const context = { ready: true, catalogRoot: r.namedStateRoot(named), claimsRoot: claim.state.claimRoot, settings: f.document, settingsHash: r.hashObject(f.document) };
  const trac = async (method, args = []) => {
    if (method === 'rulesContext') return structuredClone(context);
    if (method === 'head') return { counted: at().counted, tip: await bitcoin.tip() };
    if (method === 'stamp') return at();
    if (method === 'financialPreviewStamp') {
      const { revision, ...batch } = at();
      return { ...batch, batchRoot: rootOverride ?? digest('accepted-batch/' + batch.last.n), authority: structuredClone(authority),
        admissionPolicy: { ready: context.ready, settingsHash: context.settingsHash,
          scheduledSettingsHash: r.hashObject(context.scheduledSettings ?? null) } };
    }
    if (method === 'root') return rootOverride ?? digest('accepted-batch/' + args[0]);
    if (method === 'authority') return structuredClone(authority);
    if (method === 'settingsByHash') return f.document;
    if (['read', 'record'].includes(method) && /^(k\/)?link\//.test(args[0])) {
      return links.get(String(parseInt(args[0].split('/').at(-1), 36))) ?? null;
    }
    if (method === 'read') return f.store.get('accountRecords', args[0]);
    if (method === 'readMany') return args[0].map(key => f.store.get('accountRecords', key));
    assert.fail('unexpected Trac method ' + method);
  };
  trac.close = async () => {};
  active = { bitcoin, indexer, trac, at };
  config.network = f.network; config.prod.warmReads = false;
  config.v2 = { document: f.document, resources: r.resourceRevision({ operator: 'test', values: { ...r.RESOURCE_PROFILE } }) };
  const reads = await productionReads(config, f.store, { committee }); t.after(() => reads.close());
  await reads.lookups.advance(reads.lookups.watch('privilege'));
  await reads.lookups.advance(reads.lookups.watch('element'));
  reads.bindings.resolve = async () => ({ id: digest('binding'), request: { address: address(4) } });
  reads.bindings.owners = async () => [bitmapAgent];
  for (const key of ['assetContext', 'bitmap', 'isMinted', 'withBulkCandidateReads', 'batchStamp', 'authority', 'withGatewayFinancialPreview']) f.reads[key] = reads[key];
  sourceDelay = latency; calls.length = 0;
  return { ...f, input, calls, minted, links, holders, reads: f.reads, indexer, production: reads,
    duringMintedRead: fn => { batchHook = fn; }, latency: ms => { sourceDelay = ms; },
    advanceRawRevision: () => { rawRevision++; }, rawRevision: () => rawRevision,
    changeAuthority: value => Object.assign(authority, value),
    replaceBatchRoot: () => { rootOverride = digest('replacement-batch'); },
    scheduleSettings: () => { context.scheduledSettings = { ...f.document, revision: '2', effectiveBatch: '2',
      values: { ...f.document.values, moveFreshnessTips: f.document.values.moveFreshnessTips + 1 } }; },
    setBitmapAgent: value => { bitmapAgent = value; }, reorg: (hash = digest('new-branch')) => { bitcoinHash = hash; },
    setCancelled: value => { cancelled = value; },
    async changeFind(block, fields) {
      const id = r.findIdV2(block, '123');
      hot.finds = r.recordSet(hot.finds, id, { ...r.recordGet(hot.finds, id), ...fields });
      const next = claims.save(hot);
      await f.store.transact([...next.writes, { space: 'assetCheckpoint', id: 'current', value: { named: saved.snapshot, claims: next.state.claimSnapshot } }]);
      context.claimsRoot = next.state.claimRoot;
    } };
}

test('64 linked production members quote and strictly reserve while raw Trac revision moves every 10 ms', { timeout: 20000 }, async t => {
  const f = await productionFixture(t, { latency: 50 });
  const timer = setInterval(f.advanceRawRevision, 10); t.after(() => clearInterval(timer));
  let scans = 0;
  const candidates = f.reads.bulkCandidates;
  f.reads.bulkCandidates = (...args) => { scans++; return candidates(...args); };
  const start = performance.now(), quote = await f.bulk.quote(f.input), quoteMs = performance.now() - start;
  const quoteRevision = f.rawRevision();
  assert.equal(quote.terms.members.length, 64); assert.equal(scans, 1);
  assert.ok(quoteRevision >= 100, 'raw view advanced throughout the quote');
  assert.deepEqual(await f.bulk.quote(f.input), quote, 'raw appends do not invalidate the completed quote');
  assert.equal(scans, 1);
  f.height('974138'); // Rebuild all mutable TAP reads during strict admission.
  const reserveStart = performance.now(), status = await f.bulk.request(f.sign(quote)), reserveMs = performance.now() - reserveStart;
  assert.equal(status.state, 'reserving'); assert.equal(f.store.count('financialAdmissionPlot'), 64);
  assert.ok(f.rawRevision() >= quoteRevision + 100, 'raw view advanced throughout strict admission');
  assert.equal(f.financial.acceptedRevision, 0);
  t.diagnostic(JSON.stringify({ quoteMs: Math.round(quoteMs), reserveMs: Math.round(reserveMs), rawRevisions: f.rawRevision(), scans }));
});

test('gateway preview reaches nested financial wrappers without relaxing concurrent evidence or batch construction', async t => {
  const f = await productionFixture(t), reads = f.production, record = reads.financialRecord;
  reads.financialRecord = (...args) => { f.advanceRawRevision(); return record(...args); };
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const preview = reads.withGatewayFinancialPreview(async () => {
    const at = await reads.batchStamp();
    assert.equal(Object.hasOwn(at, 'revision'), false);
    entered(); await blocked;
    const result = await reads.financialDeploymentState(f.input.asset, at, f.input.deployment);
    assert.equal(result.existing.deployment, f.input.deployment);
  });
  await started;
  try {
    const at = await reads.batchStamp(); assert.equal(Object.hasOwn(at, 'revision'), true);
    await assert.rejects(reads.financialDeploymentState(f.input.asset, at, f.input.deployment), /financial_snapshot_changed/);
    const args = { store: f.store, reads, document: f.document, network: f.network, height: at.counted, at };
    await assert.rejects(buildFinancialExecution({ ...args, transitions: [] }), /financial_snapshot_changed/);
    await assert.rejects(verifyFinancialExecution({ ...args, files: [] }), /financial_snapshot_changed/);
  } finally { release(); await preview; }
  assert.equal(Object.hasOwn(await reads.batchStamp(), 'revision'), true);
  await assert.rejects(reads.withGatewayFinancialPreview(async () => { throw Error('fixture_failure'); }), /fixture_failure/);
  assert.equal(Object.hasOwn(await reads.batchStamp(), 'revision'), true, 'a failed preview also restores strict stamps');
});

test('committee production readers never expose the gateway preview scope', async t => {
  const f = await productionFixture(t, { committee: true }), reads = f.production, at = await reads.batchStamp();
  assert.equal(reads.withGatewayFinancialPreview, undefined); assert.equal(Object.hasOwn(at, 'revision'), true);
  await reads.authority(); f.changeAuthority({ epoch: '1' });
  assert.equal((await reads.authority.fresh()).epoch, '1', 'signer receipt fences can still bypass cached authority');
  f.advanceRawRevision();
  await assert.rejects(reads.financialDeploymentState(f.input.asset, at, f.input.deployment), /financial_snapshot_changed/);
});

test('real batches still retry a 64-block quote and refuse strict admission during raw revision churn', { timeout: 20000 }, async t => {
  const f = await productionFixture(t, { latency: 10 });
  const timer = setInterval(f.advanceRawRevision, 10); t.after(() => clearInterval(timer));
  let scans = 0; const candidates = f.reads.bulkCandidates;
  f.reads.bulkCandidates = (...args) => { scans++; return candidates(...args); };
  f.duringMintedRead(() => f.advanceBatch());
  const quote = await f.bulk.quote(f.input);
  assert.equal(quote.terms.members.length, 64); assert.equal(scans, 2); assert.equal(quote.anchor.lastBatch, '1');
  f.height('974138'); f.duringMintedRead(() => f.advanceBatch());
  const body = f.sign(quote);
  await assert.rejects(f.bulk.request(body), /financial_snapshot_changed/);
  for (const space of ['financialAdmissionPlot', 'financialAdmissionHeld', 'financialAdmissionNonce', 'financialQueue']) assert.equal(f.store.count(space), 0, space);
  assert.equal((await f.bulk.request(body)).state, 'reserving');
  assert.equal(f.store.count('financialAdmissionPlot'), 64);
});

for (const kind of ['batch', 'batch root', 'authority', 'scheduled settings']) test(`${kind} change after evidence reconstruction refuses strict bulk admission`, async t => {
  const f = await productionFixture(t), quote = await f.bulk.quote(f.input), record = f.reads.financialRecord;
  f.reads.financialRecord = async (...args) => {
    const result = await record(...args);
    // financialScope uses its own execution-local records. This is the final
    // imported-capacity read in admit(), after all independent source evidence.
    if (args[0] === 'fi/deployment/' + f.input.deployment) {
      if (kind === 'batch') f.advanceBatch(); else if (kind === 'batch root') f.replaceBatchRoot();
      else if (kind === 'authority') f.changeAuthority({ epoch: '1' }); else f.scheduleSettings();
    }
    return result;
  };
  await assert.rejects(f.bulk.request(f.sign(quote)), /financial_snapshot_changed/);
  assert.equal(f.store.count('financialAdmissionPlot'), 0); assert.equal(f.store.count('financialQueue'), 0);
});

test('off-batch authority changes invalidate cached quotes and are fenced during a scan', async t => {
  const f = await productionFixture(t), candidates = f.reads.bulkCandidates; let scans = 0;
  f.reads.bulkCandidates = (...args) => { scans++; return candidates(...args); };
  await f.bulk.quote(f.input); assert.equal(scans, 1);
  f.changeAuthority({ epoch: '1' });
  await f.bulk.quote(f.input); assert.equal(scans, 2, 'authority is part of the quote fingerprint');
  f.bulk.quoteResults.clear(); f.bulk.resources.bulkQuoteAttempts = 1;
  const funding = f.senderView.bulkFunding;
  f.senderView.bulkFunding = async args => { f.changeAuthority({ paused: true }); return funding(args); };
  await assert.rejects(f.bulk.quote(f.input), /financial_snapshot_changed/);
  assert.equal(f.bulk.quoteResults.size, 0);
});

test('off-batch scheduled settings invalidate quotes and preview admission bypasses stale rules context', async t => {
  const f = await productionFixture(t), candidates = f.reads.bulkCandidates; let scans = 0;
  f.reads.bulkCandidates = (...args) => { scans++; return candidates(...args); };
  await f.production.rulesContext(); // Warm the ordinary reader's context first.
  await f.bulk.quote(f.input); assert.equal(scans, 1);
  f.scheduleSettings();
  await f.bulk.quote(f.input); assert.equal(scans, 2, 'scheduled settings are part of the quote fingerprint');
  await f.production.withGatewayFinancialPreview(async () => {
    assert.equal((await f.production.rulesContext()).scheduledSettings.revision, '2');
  });
});

test('64 linked production candidates finish through a mid-quote batch with 200 ms TAP reads and HTTP retries', { timeout: 45000 }, async t => {
  const f = await productionFixture(t, { latency: 200 });
  const listener = await serve({ bulkMints: f.bulk, intake: { store: f.store }, files: { serve: () => false }, responseTimeoutMs: 2000 });
  t.after(() => listener.close());
  const post = (method, body) => fetch(listener.url + '/mint/bulk/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let scans = 0;
  const candidates = f.reads.bulkCandidates;
  f.reads.bulkCandidates = (...args) => { scans++; return candidates(...args); };
  f.duringMintedRead(async () => { f.advanceBatch(); });
  const start = performance.now(); let quote, retries = 0;
  for (;;) {
    const response = await post('quote', f.input), body = await response.json();
    if (response.status === 200) { quote = body; break; }
    assert.equal(response.status, 503); assert.equal(body.error, 'request_pending');
    assert.ok(++retries < 10, 'quote must finish within a few identical retries');
  }
  const quoteMs = performance.now() - start;
  assert.ok(quoteMs < 20000, `quote took ${quoteMs.toFixed(0)} ms`);
  assert.equal(quote.terms.members.length, 64); assert.equal(scans, 2);
  assert.equal(quote.anchor.lastBatch, '1');
  assert.equal(f.calls.filter(path => path.includes('getDmtMintHolderByBlock/')).length, 64, 'Trac-only retry reuses fenced TAP answers');
  f.height('974138'); // Reservation must also finish when its TAP cache is cold.
  const requestStart = performance.now(), signed = f.sign(quote);
  let status;
  for (let i = 0; i < 10; i++) {
    const response = await post('request', signed), body = await response.json();
    if (response.status === 202 || response.status === 200) { status = body; break; }
    assert.equal(body.error, 'request_pending');
  }
  const requestMs = performance.now() - requestStart;
  assert.equal(status?.state, 'reserving'); assert.ok(requestMs < 20000, `request took ${requestMs.toFixed(0)} ms`);
  assert.equal(f.store.count('financialAdmissionPlot'), 64);
  assert.equal(f.calls.filter(path => path.includes('getDmtMintHolderByBlock/')).length, 128);
  t.diagnostic(JSON.stringify({ quoteMs: Math.round(quoteMs), requestMs: Math.round(requestMs), retries, scans, tapRequests: f.calls.length }));
});

test('64 linked production members quote and reserve while 12 queued transitions repeat every 100 ms', { timeout: 20000 }, async t => {
  const f = await productionFixture(t, { latency: 50 });
  const transitions = Array.from({ length: 12 }, (_, i) => ({ type: 'consume', id: digest('queued-' + i), permitHash: digest('queued-permit-' + i) }));
  for (const transition of transitions) await f.financial.submit(transition);
  let stopped = false, rounds = 0, scans = 0;
  const candidates = f.reads.bulkCandidates;
  f.reads.bulkCandidates = (...args) => { scans++; return candidates(...args); };
  const background = (async () => {
    while (!stopped) {
      await delay(100);
      if (stopped) break;
      for (const transition of transitions) {
        await f.financial.submit(transition);
        const id = r.hashObject(['dmw-financial-transition-v2', transition]);
        await f.financial.gate(() => f.financial.existing(id), { pending: true });
      }
      rounds++;
    }
  })();
  try {
    const start = performance.now(), quote = await f.bulk.quote(f.input), quoteMs = performance.now() - start, quoteRounds = rounds;
    assert.equal(quote.terms.members.length, 64); assert.equal(scans, 1);
    assert.ok(quoteRounds >= 10, 'pending gates ran throughout the production scan');
    f.height('974138'); // Strict admission must rebuild with cold TAP reads too.
    const reserveStart = performance.now(), status = await f.bulk.request(f.sign(quote)), requestMs = performance.now() - reserveStart;
    assert.equal(status.state, 'reserving'); assert.equal(f.store.count('financialAdmissionPlot'), 64);
    assert.ok(rounds >= quoteRounds + 10, 'pending gates also ran throughout strict admission');
    assert.equal(f.financial.acceptedRevision, 0);
    t.diagnostic(JSON.stringify({ quoteMs: Math.round(quoteMs), requestMs: Math.round(requestMs),
      backgroundRounds: rounds, pendingRevision: f.financial.revision, scans }));
  } finally { stopped = true; await background; }
});

test('bulk scoped production reads preserve every signed byte and reduce TAP calls', async t => {
  const f = await productionFixture(t), now = Date.now(); f.reads.feeQuotes.now = () => now;
  const optimized = await f.bulk.quote(f.input), fastCalls = f.calls.length;
  f.bulk.quoteResults.clear(); delete f.reads.withBulkCandidateReads; f.calls.length = 0;
  const ordinary = await f.bulk.quote(f.input), ordinaryCalls = f.calls.length;
  assert.equal(r.stableJSON(f.sign(optimized)), r.stableJSON(f.sign(ordinary)));
  assert.equal(optimized.quoteId, ordinary.quoteId);
  assert.ok(fastCalls < ordinaryCalls / 3, `${fastCalls} scoped calls versus ${ordinaryCalls} ordinary calls`);
  t.diagnostic(JSON.stringify({ members: 64, fastCalls, ordinaryCalls }));
});

test('a batch during production candidate reads rechecks member rights and locks across point-page boundaries', async t => {
  const f = await productionFixture(t);
  // A warmed rules-context object must not authorize a mismatched new checkpoint.
  await f.production.rulesContext();
  f.duringMintedRead(async () => {
    await f.changeFind('900010', { finder: digest('different-finder') });
    const keys = [plotKey(f.input.asset, '900021'), 'fi/plot/' + r.mintPlotKey(f.input.asset, '900042'),
      'dc/plot/' + r.mintPlotKey(f.input.asset, '900063')];
    await f.store.transact(keys.map(id => ({ space: 'accountRecords', id, value: { pending: true } })));
    f.advanceBatch();
  });
  const q = await f.bulk.quote(f.input);
  assert.equal(q.terms.members.length, 60);
  assert.deepEqual(q.skipped, [{ block: '900010', reason: 'mint_right_unavailable' },
    ...['900021', '900042', '900063'].map(block => ({ block, reason: 'block_pending' }))]);
  assert.equal(q.anchor.lastBatch, '1');
});

test('strict reserve refreshes TAP absence after a new tip and never admits a newly minted member', async t => {
  const f = await productionFixture(t), q = await f.bulk.quote(f.input);
  f.minted.add('900063'); f.height('974138');
  await assert.rejects(f.bulk.request(f.sign(q)), error => error.message === 'bulk_member_conflict' &&
    error.status === 409 && r.stableJSON(error.details.indices) === '[63]');
  assert.equal(f.store.count('financialQueue'), 0); assert.equal(f.store.count('financialAdmissionPlot'), 0);
  const refreshed = await f.bulk.quote(f.input);
  assert.equal(refreshed.terms.members.length, 63);
  assert.deepEqual(refreshed.skipped, [{ block: '900063', reason: 'already_minted' }]);
});

test('strict reserve rereads links, bindings and accepted locks after a Trac-only change', async t => {
  const f = await productionFixture(t), q = await f.bulk.quote(f.input);
  f.setBitmapAgent(digest('new-bound-agent')); f.advanceBatch();
  await assert.rejects(f.bulk.request(f.sign(q)), /bulk_fees_changed/);
  assert.equal(f.store.count('financialAdmissionPlot'), 0);
  f.setBitmapAgent(f.owner);
  const link = f.links.get('900000'); f.links.set('900000', { ...link, linkHeight: '974136' }); f.advanceBatch();
  await assert.rejects(f.bulk.request(f.sign(q)), /bulk_fees_changed/);
  assert.equal(f.store.count('financialAdmissionPlot'), 0);
  f.links.set('900000', link);
  await f.store.put('accountRecords', plotKey(f.input.asset, '900021'), { pending: true }); f.advanceBatch();
  await assert.rejects(f.bulk.request(f.sign(q)), error => error.message === 'bulk_member_conflict' &&
    r.stableJSON(error.details.indices) === '[21]');
  assert.equal(f.store.count('financialQueue'), 0);
});

test('a local admission during funding calculation forces a fresh quote before returning signable terms', async t => {
  const f = await fixture(t), funding = f.senderView.bulkFunding; let changed = false;
  f.senderView.bulkFunding = async args => {
    if (!changed) {
      changed = true;
      await f.financial.gate(() => f.store.put('financialAdmissionPlot', plotKey(f.input().asset, '900000'), 'pending'), { pending: true });
    }
    return funding(args);
  };
  const q = await f.bulk.quote(f.input(4));
  assert.equal(q.terms.members.length, 3);
  assert.deepEqual(q.skipped, [{ block: '900000', reason: 'block_pending' }]);
});

test('continuous snapshot changes exhaust the configured attempt limit without caching or admitting a quote', async t => {
  const f = await fixture(t), candidates = f.reads.bulkCandidates; let attempts = 0;
  f.reads.bulkCandidates = async (...args) => { attempts++; const result = await candidates(...args); f.advanceBatch(); return result; };
  f.bulk.resources.bulkQuoteAttempts = 2;
  await assert.rejects(f.bulk.quote(f.input(4)), /financial_snapshot_changed/);
  assert.equal(attempts, 2); assert.equal(f.bulk.quoteResults.size, 0); assert.equal(f.store.count('financialQueue'), 0);
});

test('provenance failures retry only when the enclosing financial snapshot actually changed', async t => {
  const f = await fixture(t), context = f.reads.assetContext; let calls = 0;
  f.reads.assetContext = async (...args) => {
    if (++calls === 1) { f.advanceBatch(); throw Error('asset_provenance_root'); }
    return context(...args);
  };
  assert.equal((await f.bulk.quote(f.input(4))).terms.members.length, 4);
  f.bulk.quoteResults.clear(); calls = 0;
  f.reads.assetContext = async () => { calls++; throw Error('asset_provenance_root'); };
  await assert.rejects(f.bulk.quote(f.input()), /asset_provenance_root/);
  assert.equal(calls, 1, 'a stable invalid proof is never bypassed or retried');
});

test('a failed outer TAP fence cannot leave a successful deployment verification for a later scan', async t => {
  const f = await productionFixture(t), input = { ...f.input, blocks: ['900000'] };
  f.bulk.resources.bulkQuoteAttempts = 1;
  f.duringMintedRead(async () => { f.reorg(); });
  await assert.rejects(f.bulk.quote(input), /snapshot_changed/);
  f.reorg(f.stamp().tipHash); f.setCancelled(true);
  await assert.rejects(f.bulk.quote(input), /privilege_cancelled/);
  assert.equal(f.bulk.quoteResults.size, 0);
});
