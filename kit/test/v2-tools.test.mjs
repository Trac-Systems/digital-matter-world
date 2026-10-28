import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ServiceClient } from '../lib/service-client.mjs';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { gameTools, runTool } from '../lib/tools.mjs';
import { presentRead, publicRoute } from '../lib/reads.mjs';
import { chooseClaims, chooseCompound, chooseMint } from '../strategies/default.mjs';
import { temp, testWallet, fakeTrac, history, cleanup } from './helpers.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';

const recording = JSON.parse(await readFile(new URL('./fixtures/v2-live-reads.json', import.meta.url)));
const recorded = path => structuredClone(recording.records.find(r => r.path === path).body);
const owner = testWallet().publicKey.toString('hex'), address = encodeTracAddress(owner);
const pattern = recorded('/patterns?limit=1').patterns[0];

test('recorded v2 catalog is p2, keeps legacy provenance separate and formats named amounts', async () => {
  const page = recorded('/patterns?limit=1'); page.next = page.nextCursor = null;
  const rows = await Agent.prototype.catalog.call({ service: { patterns: async () => page } });
  assert.equal(rows[0].number, 0); assert.equal(rows[0].asset, 'p2:0'); assert.equal(rows[0].legacy.asset, 'p0');
  const value = presentRead({ patterns: [{ ...pattern, supply: '9007199254740993' }], balances: [['p2:0', '2'], ['c2:' + 'ab'.repeat(32), '3']], total: null, nextCursor: null });
  assert.equal(value.amounts['/patterns/0/supply'].unit.currency, 'p2:0');
  assert.equal(value.amounts['/balances/0/1'].human, '2 p2:0 units');
  assert.equal(value.amounts['/balances/1/1'].unit.currency, 'c2:' + 'ab'.repeat(32));
  assert.equal(value.next, null); assert.equal(value.total, null); assert.equal(value.patterns[0].number, '0');
});

test('read dispatch accepts v2 identifiers, string sequences, new collection routes and bounded claimed pages', async () => {
  const calls = [], service = new ServiceClient({ mode: 'mainnet', origin: recording.origin, fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET'); const u = new URL(url); calls.push(u.pathname + u.search);
    return Response.json({ v: 3, rows: [], nextCursor: null });
  } });
  const agent = { service, owner, address, dryRun: true, block: Agent.prototype.block, profile: Agent.prototype.profile, results: Agent.prototype.results };
  await runTool({ agent }, 'claimed_blocks', { asset: 'p2:0', limit: 50 });
  await runTool({ agent }, 'pattern_matches', { asset: 'p2:1', limit: 2 });
  await runTool({ agent }, 'event', { sequence: '9007199254740993' });
  await runTool({ agent }, 'block', { height: '973603', collection: 'mintRights' });
  await runTool({ agent }, 'agent_profile', { collection: 'assets' });
  for (const collection of ['credits', 'custody', 'linkRequests', 'supply']) await runTool({ agent }, 'results', { collection });
  await runTool({ agent }, 'window_eligibility', { window: '973602', collection: 'winners' });
  await service.deployment('p2:0');
  assert.ok(calls.includes('/patterns/p2:0/claimed-blocks?limit=50'));
  assert.ok(calls.includes('/events/9007199254740993'));
  assert.ok(calls.includes('/blocks/973603/mintRights?owner=' + address));
  assert.ok(calls.includes('/agents/' + address + '/assets'));
  assert.ok(calls.includes('/windows/973602/winners'));
  await assert.rejects(runTool({ agent }, 'claimed_blocks', { asset: 'p2:0', limit: 51 }));
  await assert.rejects(runTool({ agent }, 'pattern_matches', { asset: 'p0' }), /Legacy pattern assets are archived/);
});

test('bitmap submission is an action and dry-run never POSTs', async () => {
  const agent = { dryRun: true, service: { submitBitmap: () => assert.fail('Dry-run must not submit') } };
  assert.equal(gameTools({ agent }).submit_bitmap.readOnly, false);
  await assert.rejects(runTool({ agent }, 'submit_bitmap', { block: '973603' }, { readOnly: true }), /Use action/);
  assert.equal((await runTool({ agent }, 'submit_bitmap', { block: '973603' })).sent, false);
  agent.service.reportCustodyPayment = () => assert.fail('Dry-run must not report payments');
  assert.equal((await runTool({ agent }, 'report_custody_payment', { id: '00'.repeat(32), reference: '00'.repeat(32), index: 0 })).sent, false);
});

test('public account links accept encoded v2 colons but refuse encoded traversal and external URLs', () => {
  const path = '/accounts/' + address + '/balances/p2%3A0';
  assert.equal(publicRoute(path).path, path.replace('%3A', ':'));
  const link = recording.records.find(r => r.path.endsWith('/assets?limit=2')).body.assets[0].balance;
  assert.equal(publicRoute(link).path, link.replace('%3A', ':'), 'Follow the exact server link, including its internal account key');
  for (const path of ['/blocks/%2e%2e/status', '/blocks/1%2fclaims', '/blocks/1%253A0', '//example.com/status', 'https://example.com/status']) assert.throws(() => publicRoute(path));
});

test('claim publication provenance accepts recorded v2 decimal ordinals', async () => {
  const publication = { height: '973603', observation: '43', audit: { path: '/audit/test', hash: '00'.repeat(32), bytes: 20 } };
  const result = await runTool({ agent: { claimInclusion: async args => args } }, 'verify_claim', { window: 973603, publication });
  assert.deepEqual(result.publication, publication);
});

test('v2 mint tools retain string assets and compare candidate heights canonically', async () => {
  const candidate = { find: { asset: 'p2:0', block: '973603', count: '1' } };
  const agent = { owner, paymentAddresses: () => ({}), makeReal: async args => args,
    trac: { balance: async (_, asset) => { assert.equal(asset, 'p2:0'); return '0'; } } };
  const context = { agent, candidates: async () => [candidate] };
  const result = await runTool(context, 'mint_on_chain', { actionId: 'one', asset: 'p2:0', block: 973603, amount: '1' });
  assert.deepEqual(result.candidate, candidate);
  assert.equal((await runTool(context, 'mint_idea', { asset: 'p2:0' })).reason, 'no_balance');
});

test('v2 compound suggestions use named ingredients and preserve warnings when totals are unknown', async () => {
  const patterns = [pattern, { ...pattern, number: '1', asset: 'p2:1', key: 'ab'.repeat(32) }];
  const balances = { 'p2:0': '2', 'p2:1': '2' };
  const suggestion = chooseCompound({ patterns, balances, historyLength: 973605 });
  assert.deepEqual(suggestion.inputs, [['p2:0', '1'], ['p2:1', '1']]); assert.equal(suggestion.previewRequired, true); assert.equal(suggestion.id, undefined);
  const agent = { owner, catalog: async () => patterns, trac: { balance: async (_, a) => balances[a], settings: async () => ({ ruleset: 'dmw-v2' }), head: async () => ({ counted: 973604 }) },
    mintRights: async () => ({ mintRights: [{ block: '0', amount: '2' }], total: null, next: 'more' }) };
  const result = await runTool({ agent }, 'compound_idea');
  const warning = result.warnings.find(w => w.code === 'consumes_mintable_finder_units');
  assert.equal(warning.total, null); assert.equal(warning.slots.length, 2); assert.equal(warning.pages['p2:0'].next, 'more');
});

test('v2 strategies compare string counts exactly and local selections contain numeric ordinals', () => {
  const candidates = ['9007199254740992', '9007199254740993'].map((count, i) => ({ time: String(i), find: {
    settingsHash: 'ab'.repeat(32), asset: 'p2:0', finder: owner, finderUntil: '1009', findHeight: '1', block: String(i), count
  } }));
  assert.equal(chooseMint({ candidates, owner, counted: 2, balance: '9999999999999999' }), candidates[1]);
  assert.equal(chooseMint({ candidates, owner, counted: 2, balance: '9999999999999999', specialDates: ['1970-01-01'] }), candidates[1]);
  const plots = chooseClaims({ history: history(10), patterns: [{ ...pattern, fld: 4, pat: '1' }], claimsPerWindow: 1 });
  assert.deepEqual(plots, [{ block: 1, patterns: [0] }]);
});

test('v2 journal hunting recognizes header-v2 and claim-v2 without treating them as discoveries', async t => {
  const journal = await Journal.open(await temp(t), 'v2-hunting'); cleanup(t, () => journal.close());
  journal.reserve('header/20', {}, { v: 2, t: 'header-v2', p: { height: '20', raw: '00' } });
  journal.reserve('claim/21', {}, { v: 2, t: 'claim-v2', p: { window: '21', plots: [{ block: '10', patterns: ['0'] }] } });
  const page = journal.hunting();
  assert.deepEqual(page.items.map(r => r.type), ['claim', 'header']);
  assert.equal(page.items[0].closesAt, 23); assert.equal(page.items[1].headerBlock, 20);
  assert.equal(page.items[0].settlesAt, null, 'V2 credit delivery can lag the deciding block');
  const { trac } = fakeTrac(history(), { tip: 30 });
  const service = { network: trac.network, block: async block => ({ v: 3, draws: block === 10 ? [{ window: '21', block: '10', pattern: '0', winner: address, asset: 'p2:0', count: '1' }] : [], next: null }) };
  const agent = new Agent({ wallet: testWallet(), network: trac.network, trac, service, journal });
  const hunt = await agent.hunting();
  assert.equal(hunt.items[0].phase, 'won_pending_settlement');
  assert.equal(hunt.items[1].phase, 'check_settlement');
  assert.equal(hunt.items[1].settlesAt, null);
  assert.equal(journal.evidence('claim/21').settlement, null, 'A partial projection must not freeze the final settlement');
});
