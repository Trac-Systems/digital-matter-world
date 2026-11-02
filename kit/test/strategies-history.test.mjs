import { encodeTracAddress } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { HeaderHistory, parseHeader, evaluateDiscovery, CLAIM_DEFAULTS } from '../../rules/src/index.js';
import { loadHistory, historyProof, assertHistoryTip, downloadHeaders, headerSource } from '../lib/headers.mjs';
import { findPatterns } from '../lib/search.mjs';
import { backtest } from '../lib/backtest.mjs';
import { chooseClaims, chooseCompound, chooseMint } from '../strategies/default.mjs';
import { temp, history, patterns, cleanup, fakeTrac, testWallet } from './helpers.mjs';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
const owner = '11'.repeat(32), other = '22'.repeat(32);
test('mint strategy tolerates absent or invalid timestamps and still prefers valid requested dates', () => {
  const make = (block, time) => ({ found: true, time, find: { asset: 'p0', block, count: 1, finder: owner, findHeight: 1 } });
  const candidates = [make(1, undefined), make(2, NaN), make(3, Infinity), make(4, 1e20), make(5, 0)];
  assert.equal(chooseMint({ candidates, owner, counted: 2, balance: '10' }).find.block, 1);
  assert.equal(chooseMint({ candidates, owner, counted: 2, balance: '10', specialDates: ['1970-01-01'] }).find.block, 5);
});
async function mainnet(t) {
  const dir = await temp(t), bytes = Buffer.from((await readFile(new URL('./fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex'), path = join(dir, 'headers.bin');
  await writeFile(path, bytes); return { dir, path, bytes, history: await loadHistory(path) };
}
test('full history verification rejects altered PoW and stale proposal snapshots', async t => {
  const f = await mainnet(t), proof = historyProof(f.history); assert.equal(proof.count, 64);
  const tip = f.history.get(63); assert.equal(assertHistoryTip(f.history, tip).tip, tip.hash);
  assert.throws(() => assertHistoryTip(f.history, { height: 64, hash: tip.hash }), /current tip/);
  assert.throws(() => historyProof(new HeaderHistory(f.bytes)), /verify/);
  f.bytes[80 + 76] ^= 1; await writeFile(f.path, f.bytes); await assert.rejects(loadHistory(f.path), /pow|link/);
});
test('claims before the contract checkpoint use a verified archive with a matching chain overlap', async t => {
  const f = await mainnet(t), { trac } = fakeTrac({ ...f.history, get: h => f.history.get(h), hashAt: h => h < 50 ? null : f.history.get(h).hash }, { tip: 63 });
  const journal = await Journal.open(join(f.dir, 'journal'), 'test'); cleanup(t, () => journal.close());
  const agent = new Agent({ wallet: testWallet(), network: trac.network, service: { network: trac.network }, trac, journal });
  const claim = { event: { window: 63, hash: f.history.get(63).hash }, plots: [{ block: 5, patterns: [0] }], history: f.history, patterns };
  assert.equal((await agent.claim(claim)).state, 'dry-run');
  await assert.rejects(agent.claim({ ...claim, history: new HeaderHistory(f.bytes) }), /verify/);
  trac.hashAt = async () => 'ff'.repeat(32); await assert.rejects(agent.claim(claim), /reorganized/);
});
test('download resumes once, checks both source tips and verifies the complete resulting chain', async t => {
  const f = await mainnet(t), output = join(f.dir, 'download.bin'); let requests = 0;
  const checked = [];
  t.mock.method(fsPromises, 'statfs', async path => { checked.push(path); return { bavail: 600n * 1024n * 1024n, bsize: 1n }; });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const source = { height: async () => 63, hash: async h => f.history.get(h).hash, blocks: async top => {
    requests++; return Array.from({ length: Math.min(top + 1, 10) }, (_, i) => {
      const h = top - i, row = f.history.get(h), raw = f.history.raw(h);
      return { ...row, id: row.hash, timestamp: row.time, previousblockhash: row.prev, merkle_root: Buffer.from(raw.subarray(36, 68)).reverse().toString('hex') };
    });
  } };
  await downloadHeaders({ output, source, independent: source, end: 19, delayMs: 0 });
  assert.equal(requests, 2);
  const report = await downloadHeaders({ output, source, independent: source, delayMs: 0 });
  assert.equal(report.count, 64); assert.equal(report.downloaded, 44); assert.equal(report.independentTipChecked, true);
  const before = requests; assert.equal((await downloadHeaders({ output, source, independent: source, delayMs: 0 })).downloaded, 0); assert.equal(requests, before);
  assert.deepEqual(checked, [f.dir, f.dir]);
  assert.deepEqual(await readFile(output), f.bytes);
  await assert.rejects(downloadHeaders({ output, source, independent: { hash: async () => '00'.repeat(32) }, delayMs: 0 }), /Independent/);
});
test('header HTTP source checks hashes, limits URLs and permits a local test transport', async t => {
  const f = await mainnet(t), raw = f.history.raw(1), h = parseHeader(raw, 1); const paths = [];
  const source = headerSource('http://127.0.0.1:5555', { fetchImpl: async url => { const p = new URL(url).pathname; paths.push(p); return new Response(p.endsWith('/header') ? Buffer.from(raw).toString('hex') : p.endsWith('/height') ? '1' : h.hash); } });
  assert.equal(await source.height(), 1); assert.equal(await source.hash(1), h.hash); assert.equal(await source.header(h.hash), Buffer.from(raw).toString('hex'));
  await assert.rejects(source.header('00'.repeat(32)), /mismatch/); assert.ok(paths.every(p => p.startsWith('/api/')));
  assert.throws(() => headerSource('http://example.com'), /HTTPS/); assert.throws(() => headerSource('https://user:pass@example.com'), /credential/);
});
test('search refuses grammar violations, too-rare, nullable and constant count vectors', async t => {
  const { history } = await mainnet(t), existing = [{ number: 0, name: 'dmwall', pat: '[0-9]{1,10}', fld: 4, dt: 'n' }];
  const result = await findPatterns({ history, tip: history.get(63), existing, owner: encodeTracAddress(owner), strategy: function* () {
    yield { name: 'dmwsame', pat: '[0-9]{1,10}', fld: 10, dt: 'n' };
    yield { name: 'dmwbad', pat: '(0+)+', fld: 4, dt: 'n' };
    yield { name: 'dmwrare', pat: '^63$', fld: 4, dt: 'n' };
    yield { name: 'dmwnullable', pat: '1?', fld: 4, dt: 'n' };
    yield { name: 'dmwvalid', pat: '[12]', fld: 4, dt: 'n' };
  } });
  assert.equal(result.accepted.length, 1); assert.equal(result.accepted[0].record.historyHeight, 63);
  assert.match(result.rejected[0].reason, /constant/); assert.match(result.rejected[1].reason, /pattern/); assert.match(result.rejected[2].reason, /rare/); assert.match(result.rejected[3].reason, /nullable/);
});
test('discovery still rejects nonconstant identical vectors across different fields', () => {
  const hist = history(63), sameFields = { ...hist, field: h => String(h) };
  const existing = [{ number: 0, name: 'dmwheightdigits', pat: '[12]', fld: 4, dt: 'n' }];
  assert.throws(() => evaluateDiscovery({ proposal: { name: 'dmwnoncedigits', pat: '[12]', fld: 10, dt: 'n' }, discoverer: owner,
    history: sameFields, existing, number: 1 }), /duplicate/);
});
test('claim default is sorted, count-aware and bounded; compound default uses exact reduced amounts', async () => {
  const hist = history(), claims = await chooseClaims({ history: hist, patterns, claimsPerWindow: 64 });
  assert.ok(claims.some(c => c.block === 0)); assert.ok(claims.some(c => c.block === 30)); assert.equal(claims.reduce((n, c) => n + c.patterns.length, 0), 64);
  assert.deepEqual(claims[1].patterns, [...claims[1].patterns].sort((a, b) => a - b));
  assert.ok(chooseCompound({ patterns, balances: { p0: '1', p1: '1' }, historyLength: 40 }).id.startsWith('c'));
  assert.equal(chooseCompound({ patterns, balances: { p0: '1' }, historyLength: 40 }), null);
});
test('mint strategy honors finder boundary, permanent live-holder rights, pending status and date/count fit', () => {
  const candidate = (block, count = 2) => ({ found: true, minted: false, pending: false, time: Date.UTC(2020, 0, block) / 1000,
    find: { block, asset: 'p0', count, finder: owner, findHeight: 10 } });
  const a = candidate(1), b = candidate(2, 4), c = candidate(3, 8);
  assert.equal(chooseMint({ candidates: [a, b, c], owner, counted: 20, balance: '5' }), b);
  assert.equal(chooseMint({ candidates: [a, b], owner, counted: 20, balance: '5', specialDates: ['2020-01-01'] }), a);
  assert.equal(chooseMint({ candidates: [a], owner: other, counted: 1017, balance: '5' }), null);
  assert.equal(chooseMint({ candidates: [a], owner: other, counted: 1018, balance: '5' }), a);
  a.link = { block: 1, linkHeight: 9 }; assert.equal(chooseMint({ candidates: [a], owner, counted: 1018, balance: '5' }), null);
  a.currentHolder = other; assert.equal(chooseMint({ candidates: [a], owner: other, counted: 100000, balance: '5' }), a);
  a.currentHolder = owner; assert.equal(chooseMint({ candidates: [a], owner: other, counted: 100000, balance: '5' }), null);
  a.pending = true; assert.equal(chooseMint({ candidates: [a], owner, counted: 20, balance: '5' }), null);
});
test('replay is deterministic, excludes future knowledge and scores only H+2 draws', async t => {
  const { history } = await mainnet(t), catalog = [{ number: 0, name: 'dmwdigits', pat: '[0-9]', fld: 4, dt: 'n' }, { ...patterns[1], historyHeight: 60 }];
  const args = { history, patterns: catalog, owner, start: 16, end: 63 };
  const a = await backtest({ ...args, owner: encodeTracAddress(args.owner) }), b = await backtest({ ...args, owner: encodeTracAddress(args.owner) }); assert.deepEqual(a, b);
  assert.equal(a.events, 48); assert.equal(a.settledEvents, 46); assert.equal(a.unsettledEvents, 2); assert.equal(a.catalogSize, 1); assert.deepEqual(a.catalogIds, ['p0']); assert.deepEqual(a.settings, CLAIM_DEFAULTS); assert.match(a.assumptions[0], /history/); assert.ok(a.wins > 40);
  const contested = await backtest({ ...args, owner: encodeTracAddress(args.owner), opponents: [{ owner: encodeTracAddress(other), strategy: chooseClaims }] }); assert.ok(contested.wins < a.wins);
  await assert.rejects(backtest({ ...args, owner: encodeTracAddress(args.owner), strategy: ({ history }) => { history.get(history.length); return []; } }), /future header/);
});


test('search checks caller candidates first and then strategy candidates within one budget', async t => {
  const { history } = await mainnet(t);
  const supplied = { name: 'dmwcaller', pat: '[12]', fld: 4, dt: 'n' };
  const result = await findPatterns({ history, tip: history.get(63), existing: [], owner: encodeTracAddress(owner), candidates: [supplied], maxCandidates: 2, strategy: function* () {
    yield { name: 'dmwstrategy', pat: '^63$', fld: 4, dt: 'n' };
    throw Error('budget must stop iteration');
  } });
  assert.equal(result.accepted[0].record.name, supplied.name); assert.equal(result.rejected[0].name, 'dmwstrategy');
});
