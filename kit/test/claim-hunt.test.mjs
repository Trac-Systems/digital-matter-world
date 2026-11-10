import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { HeaderHistory } from '../../rules/src/headers.js';
import { patternAmount } from '../../rules/src/pattern-amount.js';
import { MAX_CLAIMS_PER_WINDOW } from '../../rules/src/index.js';
import { chooseClaims, createClaimSelector } from '../strategies/default.mjs';
import { ClaimMatchCache, compileClaimAmount } from '../strategies/claim-hunt.mjs';
import { legacyChooseClaims } from './support/legacy-choose-claims.mjs';
import { HUNT_READ_LIMIT, HUNT_REPAIR_LIMIT, addRootLeaf, finishRoot } from '../lib/claim-settlement.mjs';
import { merkleRoot, stableJSON } from '../../rules/src/index.js';
import { MY_FINDS_READ_LIMIT } from '../lib/my-finds.mjs';

function random(seed = 811) {
  return n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
}
function history(length, seed = 811) {
  const rng = random(seed), bytes = new Uint8Array(length * 80), view = new DataView(bytes.buffer);
  for (let h = 0; h < length; h++) {
    view.setUint32(h * 80 + 72, h % 17 ? rng(0xffffffff) : 0, true);
    view.setUint32(h * 80 + 76, h % 19 ? rng(0xffffffff) : 0, true);
  }
  return new HeaderHistory(bytes);
}
const definitions = [
  ...['[0-9]', '0', '^0$', '12|21', '[2-4]{2,3}', '^1|2$', '1|12', '12|1', '0?', '1{0,2}', '1{0}', '[68]$', '9{2,4}', '^99999$'].flatMap(pat =>
    [4, 10, 11].map(fld => ({ pat, fld, dt: 'n' }))),
  ...['[a-f]{2,3}', '^1[7-9]', '0{2}$', 'ab|cd', 'a?', '^0$', 'f{2}', 'ab|a'].map(pat => ({ pat, fld: 11, dt: 'h' }))
];
function catalog(rng, count) {
  return Array.from({ length: count }, (_, number) => ({ ...definitions[rng(definitions.length)], number: rng(2) ? String(number) : number,
    ...(rng(3) ? { rarity: String(rng(100)) } : {}), ...(rng(3) ? { knownMatchCount: String(rng(100)) } : {}),
    ...[{ }, { amountMode: 'count' }, { amountMode: 'field-value' }][rng(3)] })).reverse();
}

test('compiled exact amounts equal patternAmount, including nullable regex and field-value zero', () => {
  const hist = history(80);
  for (const definition of definitions) for (const amountMode of [undefined, 'count', 'field-value']) {
    const pattern = { ...definition, amountMode }, amount = compileClaimAmount(pattern);
    for (let block = 0; block < hist.length; block++) assert.equal(amount(hist, block), patternAmount(pattern, hist.get(block)), JSON.stringify({ pattern, block }));
  }
  assert.throws(() => compileClaimAmount({ pat: '(1+)+', fld: 4, dt: 'n' }), /pattern/);
  assert.throws(() => compileClaimAmount({ pat: '1', fld: 10, dt: 'h' }), /field/);
});

test('old and new selections are identical on seeded random histories, modes, budgets and taken sets', async () => {
  const rng = random(18329), select = createClaimSelector();
  for (let trial = 0; trial < 160; trial++) {
    const hist = history(15 + rng(120), rng(10000)), patterns = catalog(rng, 1 + rng(22));
    const taken = Object.fromEntries(patterns.map(p => [p.number, new Set(Array.from({ length: hist.length }, (_, h) => h).filter(() => rng(3) === 0))]));
    const args = { history: hist, patterns, taken, claimableHeight: rng(hist.length + 15) - 3, window: rng(hist.length + 10),
      claimsPerWindow: [-1, 0, 1, 3, 19, 100, MAX_CLAIMS_PER_WINDOW + 20][rng(7)] };
    const old = legacyChooseClaims(args);
    assert.deepEqual(await select(args), old, `cold trial ${trial}`);
    assert.deepEqual(await select(args), old, `warm trial ${trial}`);
    for (const p of patterns) { const block = rng(hist.length); if (!taken[p.number].delete(block)) taken[p.number].add(block); }
    args.claimableHeight = rng(hist.length); args.window = rng(hist.length);
    assert.deepEqual(await select(args), legacyChooseClaims(args), `changed exclusions/window trial ${trial}`);
  }
});

test('cache reads only appended fields, survives fresh archive objects and never parses headers', async () => {
  const full = history(140), patterns = [{ number: 0, pat: '1', fld: 4, dt: 'n' }, { number: 1, pat: '0', fld: 10, dt: 'n', amountMode: 'field-value' }];
  const select = createClaimSelector(); let reads = [];
  function prefix(length) {
    const h = new HeaderHistory(full.bytes.subarray(0, length * 80));
    const field = h.field.bind(h); h.field = (block, ...rest) => { reads.push(block); return field(block, ...rest); };
    h.get = () => { throw Error('Hunting must not parse/hash headers'); }; return h;
  }
  const taken = { 0: new Set(Array.from({ length: 140 }, (_, i) => i)), 1: new Set(Array.from({ length: 140 }, (_, i) => i)) };
  const args = { history: prefix(100), patterns, taken, claimableHeight: 98, window: 99 };
  assert.deepEqual(await select(args), []); assert.equal(reads.length, 200);
  reads = []; assert.deepEqual(await select(args), []); assert.equal(reads.length, 0);
  args.history = prefix(140); args.claimableHeight = 138; args.window = 139;
  assert.deepEqual(await select(args), []);
  assert.equal(reads.length, 80); assert.ok(reads.every(h => h >= 100));
  // Removing an old exclusion must reveal a cached match without rescanning.
  reads = []; taken[0].delete(11);
  assert.deepEqual(await select(args), [{ block: 11, patterns: [0] }]); assert.equal(reads.length, 0);
  // Same-size Set mutations must not be mistaken for an unchanged taken set.
  taken[0].add(11); taken[0].delete(12);
  assert.deepEqual(await select(args), [{ block: 12, patterns: [0] }]); assert.equal(reads.length, 0);
  taken[0].delete(139);
  assert.deepEqual(await select(args), [{ block: 12, patterns: [0] }, { block: 139, patterns: [0] }]);
  assert.equal(reads.length, 0, 'The appended tip match must already be cached');
});

test('a distant window is memoized without reading the ineligible gap', async () => {
  let reads = [];
  const h = { length: 100, field: block => { reads.push(block); return String(block); } };
  const select = createClaimSelector(), patterns = [{ number: 0, pat: '[0-9]', fld: 4, dt: 'n' }];
  const args = { history: h, patterns, claimableHeight: 2, window: 99 };
  const expected = [0, 1, 2, 99].map(block => ({ block, patterns: [0] }));
  assert.deepEqual(await select(args), expected); assert.deepEqual(reads, [0, 1, 2, 99]);
  reads = []; assert.deepEqual(await select(args), expected); assert.deepEqual(reads, []);
  args.claimableHeight = 5;
  assert.deepEqual(await select(args), [0, 1, 2, 3, 4, 5, 99].map(block => ({ block, patterns: [0] })));
  assert.deepEqual(reads, [3, 4, 5]);
});

test('cache invalidates a fork, shrink and in-place header changes', async () => {
  const select = createClaimSelector(), a = history(90), b = history(90, 813), small = new HeaderHistory(a.bytes.subarray(0, 30 * 80));
  const patterns = [{ number: 0, pat: '1', fld: 10, dt: 'n' }];
  for (const h of [a, b, small, a]) {
    const args = { history: h, patterns, claimsPerWindow: 1000 };
    assert.deepEqual(await select(args), legacyChooseClaims(args));
  }
  a.view.setUint32(21 * 80 + 76, 111, true);
  assert.deepEqual(await select({ history: a, patterns }), legacyChooseClaims({ history: a, patterns }));
});

test('cache fingerprint includes mode, field, radix and expression, independent of pattern number', async () => {
  const select = createClaimSelector(), h = history(60);
  const options = { history: h, claimsPerWindow: 1000 };
  const variants = [
    { pat: '0', fld: 4, dt: 'n' }, { pat: '0', fld: 4, dt: 'n', amountMode: 'field-value' },
    { pat: '1', fld: 4, dt: 'n' }, { pat: '1', fld: 10, dt: 'n' },
    { pat: '1', fld: 11, dt: 'n' }, { pat: '1', fld: 11, dt: 'h' }
  ];
  for (const pattern of variants) for (const number of [0, '8']) {
    const args = { ...options, patterns: [{ ...pattern, number }] };
    assert.deepEqual(await select(args), legacyChooseClaims(args));
  }
});

test('cache fallback is bounded and preserves results when disabled or filled halfway through a pattern', async () => {
  const h = history(700), patterns = [{ number: 0, pat: '[0-9]', fld: 4, dt: 'n' }, { number: 1, pat: '^699$', fld: 4, dt: 'n' }];
  const taken = { 0: new Set(Array.from({ length: 650 }, (_, i) => i)) };
  const args = { history: h, patterns, taken, claimsPerWindow: 1000 }, old = legacyChooseClaims(args);
  for (const maxBytes of [0, 100, 2000, 5000]) {
    const cache = new ClaimMatchCache({ maxBytes }), select = createClaimSelector({ cache });
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await select(args), old); assert.ok(cache.bytes <= maxBytes);
    }
  }
});

test('partial cache and changing boundaries preserve the budget and current-window exception', async () => {
  const h = history(1400), select = createClaimSelector();
  const patterns = [{ number: '2', pat: '[0-9]', fld: 4, dt: 'n', knownMatchCount: '9007199254740993' },
    { number: '1', pat: '[0-9]', fld: 4, dt: 'n', knownMatchCount: '9007199254740992' }];
  for (const claimsPerWindow of [1, 20, 2000, 0, -1, 5]) for (const claimableHeight of [30, 1000, -1, 5]) {
    const args = { history: h, patterns, claimsPerWindow, claimableHeight, window: 1200 };
    const actual = await select(args);
    assert.deepEqual(actual, legacyChooseClaims(args));
    assert.ok(actual.reduce((sum, p) => sum + p.patterns.length, 0) <= Math.min(1000, Math.max(0, claimsPerWindow)));
  }
});

test('overlapping hunts on one cache return their own deterministic selection', async () => {
  const select = createClaimSelector({ sliceMs: 1 }), h = history(12000), other = history(12000, 77);
  const patterns = [{ number: 0, pat: '^99999$', fld: 10, dt: 'n' }, { number: 1, pat: '1', fld: 4, dt: 'n' }];
  const args = [h, other, h].map(history => ({ history, patterns, claimsPerWindow: 10 }));
  assert.deepEqual(await Promise.all(args.map(select)), args.map(legacyChooseClaims));
});

test('a large hunt yields to timers and loopback HTTP throughout the scan', { timeout: 30000 }, async t => {
  const h = history(150000), patterns = Array.from({ length: 60 }, (_, number) => ({ number, pat: String(88000 + number), fld: 10, dt: 'n' }));
  const server = createServer((_req, res) => res.end('ready'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  let last = performance.now(), maxGap = 0, ticks = 0, pending = false, maxHTTP = 0, requests = 0;
  const requestsInFlight = [];
  const timer = setInterval(() => {
    const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++;
    if (pending) return; pending = true;
    requestsInFlight.push(new Promise((resolve, reject) => {
      const start = performance.now();
      get(`http://127.0.0.1:${server.address().port}/`, res => {
        res.resume(); res.on('end', () => { maxHTTP = Math.max(maxHTTP, performance.now() - start); requests++; pending = false; resolve(); });
      }).on('error', reject);
    }));
  }, 5);
  const start = performance.now();
  let plots;
  try { plots = await chooseClaims({ history: h, patterns, claimsPerWindow: 1000 }); }
  finally { clearInterval(timer); }
  const ms = performance.now() - start;
  await Promise.all(requestsInFlight);
  assert.ok(plots.length > 0); assert.ok(ticks >= 3); assert.ok(requests >= 2);
  assert.ok(maxGap < 100, `Timer gap ${maxGap.toFixed(1)} ms`);
  assert.ok(maxHTTP < 100, `Loopback HTTP ${maxHTTP.toFixed(1)} ms`);
  t.diagnostic(JSON.stringify({ huntMs: +ms.toFixed(2), maxTimerGapMs: +maxGap.toFixed(2), maxHTTPMs: +maxHTTP.toFixed(2), ticks, requests }));
});

async function settlementFixture(t, counted = 103) {
  // Keep the selector responsiveness benchmark's startup independent of the
  // SDK and gateway fixtures used by the settlement tests below it.
  const [{ Agent }, { Journal }, { ServiceClient }, { FakeHuntingService }, { temp, testWallet, cleanup }] = await Promise.all([
    import('../lib/agent.mjs'), import('../lib/journal.mjs'), import('../lib/service-client.mjs'), import('./fake-service.mjs'), import('./helpers.mjs')
  ]);
  const directory = await temp(t), journal = await Journal.open(directory, 'booking'); cleanup(t, () => journal.close());
  const fake = new FakeHuntingService(), network = 'dmw-kit-test', clock = { counted };
  const service = new ServiceClient({ network, origin: 'http://127.0.0.1:1', fetchImpl: fake.fetch });
  const trac = { network, head: async () => ({ counted: String(clock.counted), tip: { height: clock.counted } }) };
  const agent = new Agent({ wallet: testWallet(), network, service, trac, journal });
  const claim = (window = 100, plots = [{ block: '10', patterns: ['0'] }], header) => {
    journal.reserve('claim/' + window, {}, { v: 2, t: 'claim-v2', p: { window: String(window), plots, ...(header ? { header: { height: String(window) } } : {}) } });
    journal.mark('claim/' + window, 'received', { tip: String(window) });
  };
  const winner = (overrides = {}) => ({ block: '10', pattern: '0', asset: 'p2:0', count: '3', winner: agent.address, ...overrides });
  return { directory, journal, fake, service, agent, clock, claim, winner, Journal, cleanup };
}

for (const lag of [4, 11, 99]) test(`hunting records a win booked ${lag} blocks after closure and never freezes an early loss`, async t => {
  const f = await settlementFixture(t); f.claim(); f.fake.close(100, [f.winner()]);
  let row = (await f.agent.hunting()).items[0];
  assert.equal(row.phase, 'awaiting_booking'); assert.equal(row.settlement.bookingComplete, false);
  f.clock.counted = 100 + lag - 1;
  assert.equal((await f.agent.hunting()).items[0].phase, 'awaiting_booking');
  f.clock.counted++;
  f.fake.book(100, f.clock.counted);
  row = (await f.agent.hunting()).items[0];
  assert.equal(row.phase, 'won'); assert.equal(row.settlement.wins.length, 1); assert.equal(row.settlement.bookingComplete, true);
  const page = await f.agent.myFinds();
  assert.equal(page.finds[0].findHeight, String(100 + lag)); assert.equal(page.finds[0].finderUntil, String(1108 + lag));
  assert.equal(page.finds[0].blocksLeft, '1008');
});

test('a matching own find wins with missing draws, missing closure, or a partial winner index', async t => {
  for (const missingClosure of [false, true]) {
    const f = await settlementFixture(t, 199); f.claim(); f.fake.close(100, [f.winner()]);
    f.fake.book(100, 199, { draws: false, winners: false });
    if (missingClosure) f.fake.closures.clear();
    const row = (await f.agent.hunting()).items[0];
    assert.equal(row.phase, 'won'); assert.equal(row.settlement.bookingComplete, false);
    assert.equal(row.settlement.wins[0].finderUntil, '1207');
  }
});

test('a booked draw wins even when the find and closure projections are unavailable', async t => {
  const f = await settlementFixture(t, 199); f.claim(); f.fake.close(100, [f.winner()]);
  f.fake.book(100, 199, { finds: false, winners: false }); f.fake.closures.clear();
  assert.equal((await f.agent.hunting()).items[0].phase, 'won');
});

test('loss requires the complete ordered explicit winner root; void has its own phase', async t => {
  const f = await settlementFixture(t, 9999); f.claim();
  f.fake.close(100, [f.winner({ winner: 'another-agent' }), f.winner({ block: '11', winner: 'another-agent' })]);
  f.fake.book(100, 111, { indices: [0] });
  assert.equal((await f.agent.hunting()).items[0].phase, 'awaiting_booking', 'A booked rival slot alone does not complete the window');
  f.fake.book(100, 199, { indices: [1] });
  assert.equal((await f.agent.hunting()).items[0].phase, 'lost');
  const reads = f.fake.calls.length; assert.equal((await f.agent.hunting()).items[0].phase, 'lost'); assert.equal(f.fake.calls.length, reads);
  f.claim(101); f.fake.closures.set('101', { window: '101', void: true, reason: 'chain_mismatch' });
  const row = (await f.agent.hunting()).items[0]; assert.equal(row.phase, 'void'); assert.equal(row.settlement.reason, 'chain_mismatch');
});

test('winner row counts, wrong roots and reversed IDs cannot prove complete booking', async t => {
  for (const corrupt of ['root', 'order', 'id']) {
    const f = await settlementFixture(t, 9999); f.claim();
    f.fake.close(100, [f.winner({ winner: 'other' }), f.winner({ block: '11', winner: 'other' })]); f.fake.book(100, 111);
    const rows = f.fake.windows.get('100');
    if (corrupt === 'root') rows[0].root = 'ff'.repeat(32);
    if (corrupt === 'order') rows.reverse();
    if (corrupt === 'id') rows[0].row.id = 'f2:999:0';
    assert.equal((await f.agent.hunting()).items[0].phase, 'awaiting_booking');
  }
});

test('deferred header awards remain open, and partial wins accumulate across bookings', async t => {
  const f = await settlementFixture(t, 199); f.claim(100, [{ block: '10', patterns: ['0', '1'] }], true);
  f.fake.close(100, [f.winner(), f.winner({ pattern: '1', asset: 'p2:1' })], { senderCount: '1' });
  f.fake.book(100, 111, { indices: [0] });
  let row = (await f.agent.hunting()).items[0]; assert.equal(row.phase, 'won'); assert.equal(row.settlement.wins.length, 1);
  f.fake.book(100, 199, { indices: [1] });
  f.fake.finds.push({ block: '100', pattern: '2', asset: 'p2:2', count: '1', finder: f.agent.address, window: '100', source: 'header', minted: false, findHeight: '102', finderUntil: '1110' });
  row = (await f.agent.hunting()).items[0]; assert.equal(row.settlement.wins.length, 3); assert.equal(row.settlement.bookingComplete, false);
});

test('old wrong losses are repaired a few per call outside the displayed page, preserving packets and receipts', async t => {
  const f = await settlementFixture(t, 300);
  for (let window = 100; window < 100 + HUNT_REPAIR_LIMIT + 2; window++) {
    f.claim(window, [{ block: String(window), patterns: ['0'] }]);
    f.fake.close(window, [f.winner({ block: String(window) })]); f.fake.book(window, 199);
    f.journal.settle('claim/' + window, { phase: 'lost', source: 'public_draws_v3', wins: [] });
  }
  const before = f.journal.get('claim/100');
  let result = await f.agent.hunting({ limit: 1 }); assert.equal(result.rechecked.length, HUNT_REPAIR_LIMIT);
  assert.equal(f.journal.evidence('claim/100').settlement.phase, 'won');
  assert.equal(result.items[0].phase, 'awaiting_booking');
  result = await f.agent.hunting({ limit: 1 }); assert.equal(result.rechecked.length, 2); assert.equal(result.items[0].phase, 'won');
  assert.deepEqual(f.journal.get('claim/100'), before); assert.equal(result.items[0].settlement.correctedLoss, true);
});

test('saved admission refusals and observed rejections are shown with their precise reason', async t => {
  const f = await settlementFixture(t, 199); f.claim();
  f.journal.mark('claim/100', 'refused', { code: 'already_found', status: 400 });
  f.journal.settle('claim/100', { phase: 'lost', source: 'public_draws_v3' });
  let row = (await f.agent.hunting()).items[0]; assert.equal(row.phase, 'rejected'); assert.equal(row.reason, 'already_found');
  f.journal.observe('claim/100', 'rejected', { reason: 'claim_budget' });
  row = (await f.agent.hunting()).items[0]; assert.equal(row.reason, 'claim_budget'); assert.equal(f.fake.calls.length, 0);
});

test('hunting limits all GETs, caches shared windows/blocks and never drains endless sparse pages', async t => {
  const f = await settlementFixture(t, 300);
  for (let w = 100; w < 200; w++) { f.claim(w); f.fake.close(w, [f.winner()]); }
  f.fake.override = (path, query) => path.endsWith('/winners') || path.endsWith('/draws')
    ? Response.json({ v: 3, [path.endsWith('/winners') ? 'rows' : 'draws']: [], nextCursor: String(Number(query.cursor ?? 0) + 1) }) : null;
  const result = await f.agent.hunting({ limit: 200 });
  assert.ok(result.reads <= HUNT_READ_LIMIT); assert.equal(f.fake.calls.length, result.reads);
  assert.ok(result.items.every(row => row.phase === 'awaiting_booking'));
  assert.ok(f.fake.calls.filter(c => c.path === '/blocks/10/finds').length <= 1);
  assert.ok(f.fake.calls.filter(c => c.path.endsWith('/winners')).every(c => c.query.limit === '50'));
});

test('my_finds uses stable local block paging despite new finds, filters minted and foreign rows, and reports exact deadlines', async t => {
  const f = await settlementFixture(t, 1100);
  f.claim(100, [{ block: '10', patterns: ['0'] }, { block: '11', patterns: ['0'] }, { block: '12', patterns: ['0'] }]);
  f.fake.finds.push(...['10', '11', '12'].map(block => ({ block, pattern: '0', asset: 'p2:0', count: '900719925474099312345', finder: f.agent.address,
    findHeight: '100', finderUntil: block === '11' ? '1100' : '1108', source: 'claim', window: '100', minted: block === '10' })));
  const { runTool } = await import('../lib/tools.mjs');
  let page = await runTool({ agent: f.agent }, 'my_finds', { limit: 1 });
  assert.equal(page.finds[0].block, '12'); assert.equal(page.finds[0].blocksLeft, '8'); assert.equal(page.finds[0].endsSoon, true);
  assert.equal(page.finds[0].count, '900719925474099312345'); assert.ok(page.next);
  f.claim(101, [{ block: '13', patterns: ['0'] }]);
  f.fake.finds.push({ ...f.fake.finds[1], block: '13' }, { ...f.fake.finds[1], block: '12', asset: 'p2:1', finder: 'someone-else' });
  page = await f.agent.myFinds({ limit: 1, cursor: page.next });
  assert.equal(page.finds[0].block, '11'); assert.equal(page.finds[0].blocksLeft, '0'); assert.equal(page.finds[0].finderExpired, true);
  page = await f.agent.myFinds({ limit: 1, cursor: page.next }); assert.deepEqual(page.finds, []); assert.equal(page.next, null);
  assert.ok(f.fake.calls.every(c => /^\/blocks\/\d+\/finds$/.test(c.path)));
  assert.match(page.coverage.recovery, /original player journal/);
});

test('my_finds pages within a block, keeps empty continuations and restarts only a stale block', async t => {
  const f = await settlementFixture(t, 199); f.claim(); f.fake.pageSize = 1;
  f.fake.finds.push(...[0, 1, 2].map(pattern => ({ block: '10', pattern: String(pattern), asset: 'p2:' + pattern, count: '1', finder: f.agent.address,
    findHeight: '199', finderUntil: '1207', minted: pattern === 0 })));
  let page = await f.agent.myFinds(); assert.deepEqual(page.finds, []); assert.ok(page.next);
  f.fake.override = (_path, query) => query.cursor ? Response.json({ error: 'page_cursor_stale' }, { status: 409 }) : null;
  page = await f.agent.myFinds({ cursor: page.next }); assert.equal(page.warnings[0].code, 'block_cursor_restarted'); assert.ok(page.next);
  f.fake.override = null;
  page = await f.agent.myFinds({ cursor: page.next });
  page = await f.agent.myFinds({ cursor: page.next }); assert.equal(page.finds[0].asset, 'p2:1');
  page = await f.agent.myFinds({ cursor: page.next }); assert.equal(page.finds[0].asset, 'p2:2'); assert.equal(page.next, null);
});

test('my_finds backfills old journals in bounded passes and sees delivered discovery witnesses without exposing their payload', async t => {
  const f = await settlementFixture(t, 199);
  for (let w = 100; w < 201; w++) f.claim(w, [{ block: String(w), patterns: ['0'] }]);
  f.journal.reserve('discovery/one/reveal', {}, { v: 2, t: 'discovery-reveal-v2', p: { salt: 'private-test-salt', proposal: { name: 'private-test-proposal' }, matches: [{ height: '20', count: '1' }] } });
  f.journal.mark('discovery/one/reveal', 'received', { tip: '199' });
  // Reproduce an old journal that predates the derived block index.
  f.journal.db.prepare('DELETE FROM find_blocks WHERE scope=?').run(f.journal.scope);
  f.fake.finds.push({ block: '20', pattern: '4', asset: 'p2:4', count: '1', finder: f.agent.address, minted: false });
  let page = await f.agent.myFinds(); assert.equal(page.indexing, true); assert.equal(page.reads, 0); assert.ok(page.next);
  page = await f.agent.myFinds({ cursor: page.next }); assert.equal(page.indexing, false); assert.equal(page.finds[0].block, '20');
  assert.equal(page.finds[0].deadlineState, 'unknown'); assert.ok(page.reads <= MY_FINDS_READ_LIMIT); assert.ok(page.next);
  assert.equal(JSON.stringify(page).includes('private-test'), false);
  await assert.rejects(f.agent.myFinds({ cursor: page.next, asset: 'p2:4' }), /Foreign/);
});

test('background reconciliation revisits unresolved old claims after they leave the displayed page', async t => {
  const f = await settlementFixture(t, 199); f.claim(); f.fake.close(100, [f.winner()]);
  f.journal.settle('claim/100', { phase: 'lost', source: 'public_draws_v3' });
  f.claim(101); f.fake.close(101);
  await f.agent.hunting({ limit: 1 }); assert.equal(f.journal.evidence('claim/100').settlement.phase, 'awaiting_booking');
  f.fake.book(100, 199);
  const result = await f.agent.hunting({ limit: 1 });
  assert.equal(result.rechecked.find(row => row.id === 'claim/100').phase, 'won');
});

test('bounded hunting continues a large block collection on later calls', async t => {
  const f = await settlementFixture(t, 199); f.claim(100, [{ block: '10', patterns: ['249'] }]);
  f.fake.closures.set('100', { window: '100', senderCount: '0' });
  f.fake.finds = Array.from({ length: 250 }, (_, pattern) => ({ block: '10', pattern: String(pattern), asset: 'p2:' + pattern, count: '1',
    finder: f.agent.address, window: '100', source: 'claim', minted: false, findHeight: '199', finderUntil: '1207' }));
  let result = await f.agent.hunting(); assert.equal(result.items[0].phase, 'awaiting_booking');
  result = await f.agent.hunting(); assert.equal(result.items[0].phase, 'won'); assert.equal(result.items[0].settlement.wins[0].pattern, '249');
});

test('my_finds deadlines use counted height, retain unknown deadlines and never scan a sealed discovery', async t => {
  const f = await settlementFixture(t, 199); f.claim();
  f.journal.reserve('discovery/sealed', {}, { version: 2, salt: 'private-test-salt', matches: [{ height: '999', count: '1' }] });
  f.agent.trac.head = async () => ({ counted: '9007199254740993000', tip: { height: '9007199254740994000' } });
  f.fake.finds.push({ block: '10', pattern: '0', asset: 'p2:0', count: '1', finder: f.agent.address, minted: false,
    findHeight: '9007199254740992000', finderUntil: '9007199254740993001' });
  const page = await f.agent.myFinds({ asset: 'p2:0', soonBlocks: 1 });
  assert.equal(page.finds[0].blocksLeft, '1'); assert.equal(page.finds[0].endsSoon, true);
  assert.equal(f.fake.calls.some(call => call.path === '/blocks/999/finds'), false);
  assert.ok(f.fake.calls.every(call => call.query.asset === 'p2:0' && call.query.owner === undefined));
});

test('my_finds resumes after reopening the same journal and refuses rounded counted heights', async t => {
  const f = await settlementFixture(t, 199); f.claim(100, [{ block: '10', patterns: ['0'] }, { block: '11', patterns: ['0'] }]);
  f.fake.finds.push(...['10', '11'].map(block => ({ block, pattern: '0', asset: 'p2:0', count: '1', finder: f.agent.address, minted: false,
    findHeight: '199', finderUntil: '1207' })));
  let page = await f.agent.myFinds({ limit: 1 }); assert.equal(page.finds[0].block, '11');
  const reopened = await f.Journal.open(f.directory, 'booking'); f.cleanup(t, () => reopened.close()); f.agent.journal = reopened;
  page = await f.agent.myFinds({ limit: 1, cursor: page.next }); assert.equal(page.finds[0].block, '10'); assert.equal(page.next, null);
  f.agent.trac.head = async () => ({ counted: Number.MAX_SAFE_INTEGER + 1, tip: { height: 199 } });
  await assert.rejects(f.agent.myFinds(), /Invalid counted height/);
});

test('the folded winner root equals rules merkleRoot for every size', () => {
  for (let n = 0; n <= 300; n++) {
    const ids = Array.from({ length: n }, (_, i) => stableJSON('f2:' + i + ':' + n)), proof = { frontier: [], count: 0 };
    for (const id of ids) addRootLeaf(proof, id);
    assert.equal(finishRoot(proof), merkleRoot(ids), 'size ' + n);
  }
});

test('a loss in a window with thousands of winners is proven across calls and survives a stale cursor', async t => {
  const f = await settlementFixture(t, 9999); f.claim();
  const rivals = Array.from({ length: 1700 }, (_, i) => f.winner({ block: String(1000 + i), winner: 'another-agent' }));
  f.fake.close(100, rivals); f.fake.book(100, 150);
  let row = (await f.agent.hunting()).items[0];
  assert.equal(row.phase, 'awaiting_booking', '34 pages do not fit one call');
  assert.ok(row.settlement.booking.count > 0 && row.settlement.booking.cursor, 'progress is kept in the journal');
  // One stale cursor (more rows booked meanwhile) restarts the fold instead of trusting it.
  let stale = true;
  f.fake.override = (path, query) => stale && path.endsWith('/winners') && query.cursor ? (stale = false, Response.json({ error: 'page_cursor_stale' }, { status: 409 })) : null;
  row = (await f.agent.hunting()).items[0];
  assert.equal(row.phase, 'awaiting_booking'); assert.equal(row.settlement.booking.cursor, null);
  f.fake.override = null;
  for (let call = 0; call < 3 && row.phase !== 'lost'; call++) row = (await f.agent.hunting()).items[0];
  assert.equal(row.phase, 'lost'); assert.equal(row.settlement.bookingComplete, true); assert.equal(row.settlement.booking, undefined);
});
