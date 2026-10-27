import { assertPublicIdentities } from '../../rules/test/public-identities.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPublicAPI } from '../../service/src/public-api.mjs';
import { Files } from '../../service/src/files.mjs';
import { Agent, ServiceClient, Journal, init, presentRead } from '../lib/index.mjs';
import { createMcp } from '../lib/mcp.mjs';
import { runTool } from '../lib/tools.mjs';
import { cleanup, temp, fakeTrac, history, testWallet } from './helpers.mjs';

const owner = testWallet().publicKey.toString('hex');
const money = '79100000000000000000';
async function fixture(t) {
  const directory = await temp(t), { trac, state } = fakeTrac(history());
  const journal = await Journal.open(directory, 'reads/' + owner); cleanup(t, () => journal.close());
  const rows = [1, 2, 3].map(n => ({ id: String(n), asset: 'p' + n, block: n, amount: String(n), number: n, count: n, address: String(n).repeat(64), finds: n }));
  const events = rows.map((r, i) => ({ sequence: i + 1, id: r.id, type: 'find', at: 0, data: { ...r, finder: owner }, provenance: { transaction: 'a'.repeat(64) } }));
  const results = Object.fromEntries(['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links'].map(k => [k, rows]));
  const views = {
    status: () => ({ network: 'dmw-kit-test', counted: 15 }), world: () => ({ plots: rows.map(r => ({ height: r.block, found: true, finds: [] })) }),
    batches: () => rows.map(r => ({ ...r, n: r.number, from: r.number, to: r.number })),
    catalog: () => ({ patterns: rows, compounds: rows.map(r => ({ ...r, id: 'c' + r.id })) }), finds: () => rows, receipts: () => rows,
    agents: () => rows, events: () => events, rights: () => rows.map(r => ({ ...r, allowed: true, whoMayMint: 'public', finderUntil: 1008 })),
    patternBlocks: asset => ({ asset, rows }),
    block: height => ({ height, claimWindow: { window: 20, closesAt: 22, drawAt: 22, settlesWhenCounted: 22, settlesAt: 22, open: true },
      matches: rows, slotList: rows, claims: rows.map(r => ({ ...r, agent: owner, patterns: [1, 2, 3] })), draws: rows, finds: rows, mintRights: rows }),
    profile: address => ({ address, balances: rows, finds: rows, discoveries: [{ state: 'sealed', exists: true, opensAt: 22 }], history: events, mintRights: rows }),
    agentList: (_owner, collection) => collection === 'history' ? events : rows,
    resultList: kind => results[kind], results: () => ({ ...results, treasury: { amount: money }, burn: { tap: money, ethereum: '1' }, outstandingSupply: { ethereum: money } }),
  };
  const files = new Files(join(directory, 'static'));
  const api = createPublicAPI({ views, files }), requests = [];
  const http = createServer(async (req, res) => {
    try {
      requests.push({ method: req.method, path: req.url });
      if (req.method === 'POST' && req.url === '/mint/quote') {
        let bytes = ''; for await (const chunk of req) bytes += chunk;
        const args = JSON.parse(bytes); requests.at(-1).body = args;
        res.end(JSON.stringify({ ...args, price: money, baseFee: money, unitsUsed: args.amount ?? '2', networkFeeSats: '123',
          split: { finder: money, treasury: '0' }, feeDestinations: { finder: { amount: money, recipient: 'local-finder', route: 'direct' } } }));
      } else { assert.equal(req.method, 'GET'); res.end(JSON.stringify(await api.read(req.url))); }
    } catch (error) { res.statusCode = error.status ?? 400; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => { http.closeIdleConnections(); http.close(resolve); }));
  const service = new ServiceClient({ origin: `http://127.0.0.1:${http.address().port}`, network: trac.network });
  const wallet = testWallet(); wallet.sign = () => { throw Error('Read attempted signing'); };
  const agent = new Agent({ wallet, network: trac.network, service, trac, journal, dryRun: false });
  return { directory, trac, state, journal, service, agent, requests, files, views };
}

test('every public MCP read works through the service paging implementation without signing', async t => {
  const f = await fixture(t), server = await createMcp({ agent: f.agent }); cleanup(t, () => server.close());
  const client = new Client({ name: 'reads-test', version: '1' }); cleanup(t, () => client.close());
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  const cases = [
    ['public_status', {}, r => assert.equal(r.counted, 15)],
    ['world', { limit: 1 }, r => assert.equal(r.plots.length, 1)],
    ['patterns', { limit: 1 }, r => assert.equal(r.patterns.length, 1)],
    ['compounds', { limit: 1 }, r => assert.equal(r.compounds.length, 1)],
    ['finds', { limit: 1 }, r => assert.equal(r.finds.length, 1)],
    ['receipts', { limit: 1 }, r => assert.equal(r.receipts.length, 1)],
    ['pattern_matches', { asset: 'p1', limit: 1 }, r => assert.equal(r.rows.length, 1)],
    ['block', { height: 1, limit: 1 }, r => { assert.equal(r.claimWindow.drawAt, 22); assert.equal(r.claimWindow.settlesWhenCounted, 22); assert.equal(r.claimWindow.settlesAt, 22); assert.equal(r.matches.length, 1); assert.ok(r.pages.matches.next); }],
    ['mint_rights', { limit: 1 }, r => { assert.equal(r.mintRights[0].whoMayMint, 'public'); assert.ok(r.amounts['/mintRights/0/amount'].human.endsWith(' units')); }],
    ['mint_quote', { asset: 'c1', amount: '9007199254740993' }, r => { assert.equal(r.unitsUsed, '9007199254740993'); assert.equal(r.amounts['/price'].human, '79.1 TAP'); assert.equal(r.amounts['/networkFeeSats'].human, '123 sat'); }],
    ['events', { since: 1, limit: 1 }, r => { assert.equal(r.events[0].sequence, 2); assert.ok(r.next); }],
    ['event', { sequence: 2 }, r => assert.equal(r.sequence, 2)],
    ['results', { limit: 1 }, r => { assert.equal(r.mints.length, 1); assert.equal(r.amounts['/treasury/amount'].human, '79.1 TAP'); assert.equal(r.amounts['/burn/tap'].human, '79.1 TAP'); assert.equal(r.amounts['/outstandingSupply/ethereum'].human, '79.1 TAP'); }],
    ['agents', { limit: 1 }, r => assert.equal(r.agents[0].finds, 3)],
    ['agent_profile', { limit: 1 }, r => { assert.equal(r.address, encodeTracAddress(owner)); assert.deepEqual(r.discoveries[0], { state: 'sealed', exists: true, opensAt: 22 }); }],
    ['hunting', { limit: 1 }, r => { assert.deepEqual(r.items, []); assert.equal(r.source, 'local-journal'); }],
    ['read_page', { route: '/blocks/1/matches', limit: 1 }, r => assert.equal(r.matches.length, 1)],
  ];
  const listing = (await client.listTools()).tools;
  for (const [name, args, check] of cases) await t.test(name, async () => {
    assert.equal(listing.find(tool => tool.name === name).annotations.readOnlyHint, true);
    const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined, JSON.stringify(result)); const value = JSON.parse(result.content[0].text); assertPublicIdentities(value); check(value);
  });
  assert.equal(f.journal.recent().length, 0); assert.equal(f.state.sent.length, 0);
  assert.deepEqual(f.requests.filter(r => r.method !== 'GET').map(r => r.path), ['/mint/quote']);
  assert.deepEqual(Object.keys(f.requests.find(r => r.method === 'POST').body).sort(), ['amount', 'asset']);
  const concurrent = await Promise.all(['patterns', 'compounds', 'status'].map(name => client.callTool({ name, arguments: {} })));
  assert.ok(concurrent.every(result => !result.isError));
});

test('SDK follows cursors, nested collection routes and event sequences; rejects foreign routes and malformed filters', async t => {
  const { service, agent } = await fixture(t);
  const first = await agent.events({ since: 1, limit: 1 });
  const second = await agent.events({ since: 1, cursor: first.next, limit: 2 });
  assert.deepEqual([...first.events, ...second.events].map(r => r.sequence), [2, 3]); assert.equal(second.next, null);
  await assert.rejects(agent.events({ since: 0, cursor: first.next }), /invalid_cursor/);
  const block = await agent.block(1, { limit: 1 });
  const next = await service.readPage(block.pages.matches.route, { cursor: block.pages.matches.next, limit: 2 });
  assert.deepEqual(next.matches.map(r => r.number), [2, 3]);
  const claimPage = await agent.block(1, { collection: 'claims', limit: 1 });
  const nested = claimPage.claims[0].pages.patterns;
  const allPatterns = await service.readPage(nested.route, { cursor: nested.next, limit: 2 });
  assert.deepEqual(allPatterns.items, [2, 3]);
  const payouts = await agent.results({ collection: 'payouts', limit: 1 });
  assert.equal(payouts.amounts['/payouts/0/amount'].unit.currency, 'TAP');
  assert.equal((await agent.profile(encodeTracAddress(owner), { collection: 'balances', limit: 1 })).balances.length, 1);
  assert.equal((await agent.profile(encodeTracAddress(owner), { collection: 'bitmaps', limit: 1 })).bitmaps.length, 1);
  for (const route of ['https://example.com/events', '//example.com/events', '/events/../moves', '/moves', '/events?limit=1&limit=2', '/events#x', '/list?source=https%3A%2F%2Fexample.com&path=%2Fx']) await assert.rejects(service.readPage(route));
  for (const options of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { found: 'false' }, { owner: 'invalid' }, { since: Number.MAX_SAFE_INTEGER + 1 }, { ignored: true }]) await assert.rejects(service.events(options));
});

test('catalog traverses every cursor with the shared 50-row default', async t => {
  const { views, agent, requests } = await fixture(t);
  const rows = Array.from({ length: 101 }, (_, number) => ({ number, name: 'pattern' + number }));
  views.catalog = () => ({ patterns: rows, compounds: [] });
  assert.deepEqual((await agent.catalog()).map(r => r.number), rows.map(r => r.number));
  assert.equal(requests.length, 3);
  for (const request of requests) {
    const url = new URL(request.path, 'http://127.0.0.1');
    assert.equal(url.pathname, '/patterns'); assert.equal(url.searchParams.has('limit'), false);
    assert.equal(url.searchParams.get('sort'), 'number'); assert.equal(url.searchParams.get('order'), 'asc');
  }
  views.catalog = () => ({ patterns: [], compounds: [] });
  assert.deepEqual(await agent.catalog(), []);
});

test('every READS.md list drains multiple pages through typed kit dispatch and HTTP', async t => {
  const { agent, requests } = await fixture(t);
  const cases = [
    ['world', {}, 'plots'], ['patterns', {}, 'patterns'], ['compounds', {}, 'compounds'],
    ['finds', {}, 'finds'], ['receipts', {}, 'receipts'], ['agents', {}, 'agents'],
    ['events', { since: 0 }, 'events'], ['mint_rights', { filters: { allowed: true } }, 'mintRights'],
    ['pattern_matches', { asset: 'p1' }, 'rows'],
    ...['matches', 'slotList', 'claims', 'draws', 'finds', 'mintRights'].map(collection => ['block', { height: 1, collection }, collection]),
    ...['balances', 'bitmaps', 'finds', 'mintRights', 'discoveries', 'history'].map(collection => ['agent_profile', { owner: encodeTracAddress(owner), collection }, collection]),
    ...['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links'].map(collection => ['results', { collection }, collection]),
    ['read_page', { route: '/records/batches' }, 'batches'],
    ['read_page', { route: '/list?source=%2Fblocks%2F1&path=%2Fclaims%2F0%2Fpatterns', sort: 'index' }, 'items'],
    ['read_page', { route: '/world', filters: { found: true } }, 'plots'],
    ['read_page', { route: '/table' }, 'patterns'], ['read_page', { route: '/feed', filters: { since: 0 } }, 'events'],
  ];
  for (const [name, args, key] of cases) {
    const options = { ...args, limit: 2, order: 'asc' };
    const first = await runTool({ agent }, name, options);
    assert.equal(first[key].length, 2, `${name} ${args.collection ?? ''}`);
    assert.equal(first.total, 3); assert.ok(first.next); assert.equal(first.order, 'asc'); assert.ok(first.route);
    const second = await runTool({ agent }, name, { ...options, cursor: first.next });
    assert.equal(second[key].length, 1); assert.equal(second.next, null);
    assert.equal(new Set([...first[key], ...second[key]].map(r => JSON.stringify(r))).size, 3);
  }
  await runTool({ agent }, 'block', { height: 1 });
  assert.equal(requests.at(-1).path, '/blocks/1', 'bare block reads must not add owner, height or undefined query parameters');
});

test('catalog refuses changing totals, repeated cursors and unavailable collection routes', async t => {
  const { agent, service } = await fixture(t);
  service.patterns = async () => ({ patterns: [{ number: 1 }], total: 3, limit: 50, next: 'same' });
  await assert.rejects(agent.catalog(), /Catalog changed during read/);
  let call = 0;
  service.patterns = async () => ({ patterns: [{ number: ++call }], total: 3 + call, limit: 50, next: String(call) });
  await assert.rejects(agent.catalog(), /Invalid catalog page/);
  service.patterns = async () => { throw Object.assign(Error('not_found'), { status: 404 }); };
  await assert.rejects(agent.catalog(), /not_found/);
});

test('local hunting survives restart, pages without secret disclosure and labels timing uncertainty', async t => {
  const f = await fixture(t), salt = 'secret-unrevealed-salt', proposal = { name: 'dmwsecretproposal', pat: 'secretpattern' };
  f.journal.reserve('claim/20', {}, { t: 'claim', p: { window: 20, plots: [{ block: 7, patterns: [1, 2] }], header: {} }, sig: 'private-packet' });
  f.journal.reserve('discovery/test', {}, { salt, proposal });
  f.journal.reserve('discovery/test/commit', {}, { t: 'discovery-commit', p: { commitment: 'b'.repeat(64) } });
  f.journal.mark('discovery/test/commit', 'received', { tip: 20 });
  const before = f.journal.recent();
  const first = await f.agent.hunting({ limit: 1 }); assert.equal(first.items[0].actionId, 'test'); assert.equal(first.items[0].revealFrom, 22); assert.equal(first.items[0].revealUntil, 164);
  const second = await f.agent.hunting({ cursor: first.next, limit: 1 }); assert.equal(second.items[0].drawAt, 22); assert.equal(second.items[0].settlesWhenCounted, 22); assert.equal(second.items[0].settlesAt, 22); assert.equal(second.next, null);
  const serialized = JSON.stringify([first, second]);
  for (const secret of [salt, proposal.name, proposal.pat, 'private-packet']) assert.equal(serialized.includes(secret), false);
  const reopened = await Journal.open(f.directory, 'reads/' + owner); cleanup(t, () => reopened.close());
  assert.equal(reopened.hunting({ cursor: first.next }).items[0].drawAt, 22);
  const foreign = await Journal.open(f.directory, 'different-scope'); cleanup(t, () => foreign.close());
  assert.throws(() => foreign.hunting({ cursor: first.next }), /Foreign/);
  f.state.tip = 28;
  assert.equal((await f.agent.hunting()).items.find(r => r.type === 'claim').phase, 'check_settlement');
  assert.equal((await f.agent.hunting()).items.find(r => r.type === 'discovery').phase, 'reveal_window');
  assert.deepEqual(f.journal.recent(), before);
  f.journal.reserve('discovery/test/reveal', {}, { t: 'discovery-reveal', p: { salt, proposal } }); f.journal.mark('discovery/test/reveal', 'received', { tip: 22 });
  assert.deepEqual((await f.agent.hunting()).items.map(r => r.type), ['claim']);
});

test('amount displays preserve exact atomic strings, units, fee splits and large matter quantities', () => {
  const input = { asset: 'p0', amount: '900719925474099312345', price: money, networkFeeSats: '17', feeQuote: { baseFee: money, sig: 'signed-data' },
    split: { finder: money, treasury: '1' }, feeDestinations: { discoverer: { amount: '1', payment: 'treasury-liability' } }, assets: [['p0', '100']] };
  const result = presentRead(input);
  assert.equal(result.amounts['/amount'].human, '900719925474099312345 p0 units');
  assert.equal(result.amounts['/split/treasury'].human, '0.000000000000000001 TAP');
  assert.equal(result.amounts['/feeDestinations/discoverer/amount'].unit.decimals, 18);
  assert.equal(result.amounts['/assets/0/1'].human, '100 p0 units');
  assert.equal(result.amounts['/networkFeeSats'].human, '17 sat');
  assert.deepEqual(result.amounts['/networkFeeSats'].unit, { currency: 'BTC', denomination: 'satoshi', decimals: 0 });
  assert.deepEqual(result.feeQuote, input.feeQuote); assert.equal(result.price, money); assert.equal(input.amounts, undefined);
});

test('CLI read uses the same typed tools, preserves paging and cannot send with --live', async t => {
  const f = await fixture(t), dir = await temp(t), password = 'disposable read test password';
  await init({ directory: dir, password });
  const config = join(dir, 'config.json'), input = join(dir, 'read.json');
  await writeFile(config, JSON.stringify({ localOnly: true, network: 'dmw-kit-test', gateway: f.service.origin, headers: join(dir, 'absent-history.bin'), strategy: join(dir, 'absent-strategy.mjs'),
    adapter: fileURLToPath(new URL('./fixtures/mcp-adapter.mjs', import.meta.url)) }));
  await writeFile(input, JSON.stringify({ since: 1 }));
  const run = promisify(execFile), cli = fileURLToPath(new URL('../bin/dmw.mjs', import.meta.url));
  const args = [cli, 'read', 'events', input, '--config', config, '--directory', dir, '--limit', '1', '--live'];
  const options = { env: { PATH: process.env.PATH, DMW_SIGNER_PASSWORD: password }, timeout: 10000 };
  const first = JSON.parse((await run(process.execPath, args, options)).stdout);
  const next = JSON.parse((await run(process.execPath, [...args, '--cursor', first.next], options)).stdout);
  assert.equal(first.events[0].sequence, 2); assert.equal(next.events[0].sequence, 3);
  for (const name of ['address', 'rules', 'status']) {
    const result = JSON.parse((await run(process.execPath, [cli, 'read', name, '--config', config, '--directory', dir], options)).stdout);
    if (name === 'rules') assert.match(result, /playbook/); else assert.match(result.address, /^trac1[0-9a-z]{58}$/);
  }
  await assert.rejects(run(process.execPath, [...args, '--limit', '201'], options));
  assert.ok(f.requests.every(r => r.method === 'GET'));
});


test('amount metadata never labels page totals, limits, sequences, heights or counts as TAP', () => {
  for (const collection of ['payments', 'ethereum', 'payouts', 'owed', 'paid']) {
    const result = presentRead({ total: 3, limit: 2, next: 'cursor', counts: { rows: 3 }, pages: { rows: { total: 3 } },
      [collection]: [{ id: '1', at: 4, block: 5, sequence: 6, count: 7, amount: '8', consumed: { total: money, blck: 9, amt: money } }] }, { route: '/results/' + collection });
    assert.equal(result.amounts['/total'], undefined);
    assert.deepEqual(Object.keys(result.amounts), [`/${collection}/0/amount`, `/${collection}/0/consumed/total`, `/${collection}/0/consumed/amt`]);
  }
  const nested = presentRead({ items: [{ total: money }], total: 2, limit: 1, next: 'cursor' }, { contextPath: '/payments/0/consumed/al' });
  assert.equal(nested.amounts['/total'], undefined); assert.equal(nested.amounts['/items/0/total'].human, '79.1 TAP');
  const quote = presentRead({ networkFeeSats: '100000', networkFeeUnit: { currency: 'BTC', denomination: 'satoshi', decimals: 0 } });
  assert.deepEqual(quote.amounts['/networkFeeSats'].unit, quote.networkFeeUnit); assert.equal(quote.amounts['/networkFeeSats'].human, '100000 sat');
});


test('CLI dispatch exposes suggestion tools and canonical action names without a custom MCP client', async t => {
  const f = await fixture(t), dir = await temp(t), password = 'disposable unified tools password';
  await init({ directory: dir, password });
  f.views.catalog = () => ({ patterns: [], compounds: [] });
  const config = join(dir, 'config.json'), input = join(dir, 'tool.json');
  await writeFile(config, JSON.stringify({ localOnly: true, network: 'dmw-kit-test', gateway: f.service.origin,
    adapter: fileURLToPath(new URL('./fixtures/mcp-adapter.mjs', import.meta.url)) }));
  const cli = fileURLToPath(new URL('../bin/dmw.mjs', import.meta.url)), run = promisify(execFile);
  const options = { env: { PATH: process.env.PATH, DMW_SIGNER_PASSWORD: password }, timeout: 10000 };
  const call = async (command, name, args) => {
    await writeFile(input, JSON.stringify(args));
    return JSON.parse((await run(process.execPath, [cli, command, name, input, '--config', config, '--directory', dir], options)).stdout);
  };
  assert.deepEqual(await call('read', 'compound_idea', {}), { suggestion: null, reason: 'no_balance' });
  assert.deepEqual(await call('read', 'mint_idea', { asset: 'p0' }), { suggestion: null, reason: 'no_eligible_slot' });
  const transfer = await call('action', 'transfer', { actionId: 'cli', to: encodeTracAddress('a'.repeat(64)), assets: [['p0', '1']] });
  assert.equal(transfer.state, 'dry-run');
  for (const name of ['search_patterns', 'backtest']) await assert.rejects(call('read', name, name === 'backtest' ? { start: 1, end: 2 } : {}), error => JSON.parse(error.stdout).error.includes('verified header history'));
  await assert.rejects(call('read', 'unknown', {}), error => JSON.parse(error.stdout).error.includes('Valid names:') && JSON.parse(error.stdout).error.includes('mint_idea'));
});

test('Trac identity tools reject raw hex and accept only checksum-valid trac1 inputs', async t => {
  const f = await fixture(t);
  for (const [name, args] of [['agent_profile', { owner }], ['agents', { filters: { address: owner } }], ['transfer', { actionId: 'bad', to: owner, assets: [['p0', '1']] }]])
    await assert.rejects(runTool({ agent: f.agent }, name, args), /trac1/);
  assert.throws(() => f.service.profile(owner), /trac1/);
  await assert.rejects(f.service.readPage('/agents/' + owner), /trac1/);
  const result = await runTool({ agent: f.agent }, 'address');
  assert.equal(result.address, encodeTracAddress(owner)); assert.ok(!Object.hasOwn(result, 'msbAddress')); assertPublicIdentities(result);
});
