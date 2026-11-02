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
