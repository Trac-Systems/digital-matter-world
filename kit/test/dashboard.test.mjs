import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { serveDashboard } from '../lib/dashboard.mjs';
import { DashboardState } from '../lib/dashboard-state.mjs';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { cleanup } from './helpers.mjs';

async function start(t, f, options) {
  const dashboard = await serveDashboard(f.context, options); cleanup(t, () => dashboard.close());
  const token = new URL(dashboard.loginLink).hash.slice(1);
  const login = await fetch(dashboard.origin + '/login', { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (path, body, headers = {}) => fetch(dashboard.origin + path, { headers: { cookie, origin: dashboard.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { dashboard, token, cookie, call, login };
}

test('dashboard requires a private cookie, one-time login, exact origin and loopback Host; credentials never enter assets or errors', async t => {
  const f = await dashboardFixture(t), { dashboard: d, token, cookie, call, login } = await start(t, f);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\//);
  for (const path of ['/', '/app.js', '/wallet.js', '/api/info', '/api/claims', '/api/requests']) assert.equal((await fetch(d.origin + path)).status, 401);
  assert.equal((await call('/login', { token })).status, 401);
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: '12' }, { origin: 'https://example.com' })).status, 403);
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: '12' }, { origin: '' })).status, 403);
  assert.equal(await new Promise((resolve, reject) => { const req = httpRequest(d.origin + '/api/info', { headers: { host: 'evil.example', cookie } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }), 403);
  assert.equal((await call('/api/info', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: '12', receiver: 'override' })).status, 400);
  for (const path of ['/login', '/', '/app.js', '/login.js', '/wallet.js', '/console.css', '/api/info', '/api/claims', '/api/requests', '/no-route?' + token]) {
    const response = await call(path), text = await response.text();
    assert.equal(text.includes(token), false); assert.equal(text.includes(cookie), false);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal(f.packets.length, 0);
});

test('own finder-week claims are paged first with exact units and balance; minted blocks are always excluded', async t => {
  const f = await dashboardFixture(t), { call } = await start(t, f);
  const first = await (await call('/api/claims?limit=1')).json();
  assert.equal(first.claims[0].block, '12'); assert.equal(first.claims[0].count, '3'); assert.equal(first.claims[0].name, 'dmwtest');
  assert.equal(first.claims[0].eligibility, 'own find'); assert.equal(first.claims[0].balance, '100'); assert.ok(first.next);
  const second = await (await call('/api/claims?limit=1&cursor=' + first.next)).json(); assert.equal(second.claims[0].block, '11');
  assert.equal((await (await call('/api/claims')).json()).claims.length, 2);
  assert.equal((await call('/api/claims?includeMinted=true')).status, 400);
  const info = await (await call('/api/info')).json(); assert.equal(info.payoutAddress, f.binding.request.address);
  assert.equal((await call('/api/claims?limit=51')).status, 400);
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: '10' })).status, 409);
  f.claims[0].finder = 'ff'.repeat(32);
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: '12' })).status, 403);
  assert.equal(f.packets.length, 0);
});

test('non-finder units holder sees a public-role block after the week and signs its mint and account reservation', async t => {
  const f = await dashboardFixture(t, { http: true }), { call } = await start(t, f);
  f.clock.counted = '1027'; f.claims[0].finder = 'ff'.repeat(32);
  const page = await (await call('/api/claims')).json(), row = page.claims.find(row => row.block === '12');
  assert.equal(row.eligibility, 'units'); assert.equal(row.role, 'public');
  assert.equal(row.balance, '100'); assert.equal(row.canMint, true); assert.equal(row.reason, null);
  assert.ok(f.calls.some(({ path, query }) => path === `/agents/${f.agent.address}/mintRights` && query.allowed === 'true'));
  assert.ok(f.calls.some(({ path, query }) => path === `/agents/${f.agent.address}/balances` && query.asset === 'p2:1'));
  assert.equal(f.packets.length, 0, 'listing cannot sign');
  const response = await call('/api/mint', { asset: row.asset, block: row.block });
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.status.state, 'awaiting_payment'); assert.equal(result.status.payable, true);
  assert.equal(f.packets.length, 2); assert.equal(f.packets[0].request.owner, f.agent.owner);
  assert.equal(f.packets[0].request.amount, '3'); assert.equal(f.packets[1].reserve.amount, '3');
  assert.equal(f.packets[0].receiver, f.binding.request.address);
});

test('insufficient units remain visible for own finder and foreign public blocks, but cannot sign or enter mint all', async t => {
  for (const publicRole of [false, true]) {
    const f = await dashboardFixture(t, { http: true }), { call, dashboard } = await start(t, f);
    if (publicRole) { f.clock.counted = '1027'; f.claims[0].finder = 'ff'.repeat(32); }
    f.balances.set('p2:1', { amount: '2', current: true });
    const page = await (await call('/api/claims')).json(), row = page.claims.find(row => row.block === '12');
    assert.equal(row.balance, '2'); assert.equal(row.canMint, false); assert.equal(row.reason, 'insufficient_balance');
    assert.equal(row.eligibility, publicRole ? 'units' : 'own find');
    const response = await call('/api/mint', { asset: row.asset, block: row.block });
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'insufficient_balance' });
    await call('/api/mint-all', {}); await dashboard.state.batchTask;
    assert.equal(dashboard.state.batch.completed, 0); assert.equal(dashboard.state.batch.failed, 0);
    assert.equal(f.packets.length, 0); assert.equal(f.journal.recent().length, 0);
  }
});

test('another finder-week block is excluded and a direct mint is refused even with enough units', async t => {
  const f = await dashboardFixture(t), { call } = await start(t, f);
  f.claims[0].finder = 'ff'.repeat(32);
  const page = await (await call('/api/claims')).json();
  assert.deepEqual(page.claims.map(row => row.block), ['11']);
  const response = await call('/api/mint', { asset: 'p2:1', block: '12' });
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'mint_finder' });
  assert.equal(f.packets.length, 0);
});

test('a pre-find Bitmap link grants its current holder the post-week mint; a late link leaves the units role', async t => {
  const f = await dashboardFixture(t, { http: true }), { call } = await start(t, f);
  f.clock.counted = '1027'; f.claims[0].finder = 'ff'.repeat(32);
  f.links.set('12', { block: '12', linkHeight: '18' }); f.holders.set('12', f.agent.owner);
  let row = (await (await call('/api/claims')).json()).claims.find(row => row.block === '12');
  assert.equal(row.eligibility, 'Bitmap holder'); assert.equal(row.canMint, true);
  assert.equal((await call('/api/mint', { asset: row.asset, block: row.block })).status, 200);
  assert.equal(f.packets.length, 2);
  // A finder's own expired find must also disappear when another Bitmap holder has the right.
  f.links.set('11', { block: '11', linkHeight: '18' }); f.holders.set('11', 'ee'.repeat(32));
  assert.equal((await (await call('/api/claims')).json()).claims.some(row => row.block === '11'), false);
  const denied = await call('/api/mint', { asset: 'p2:1', block: '11' });
  assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'mint_bitmap' });
  f.links.set('11', { block: '11', linkHeight: '19' });
  row = (await (await call('/api/claims')).json()).claims.find(row => row.block === '11');
  assert.equal(row.eligibility, 'units'); assert.equal(row.canMint, true);
});

test('claim pagination traverses all three sources without duplicating finder rows or listing compounds', async t => {
  const f = await dashboardFixture(t), { call } = await start(t, f);
  f.claims.push({ ...f.claims[0], block: '9', finder: 'ff'.repeat(32), findHeight: '1', finderUntil: '20' },
    { ...f.claims[0], asset: 'p2:2', block: '8', finder: 'ff'.repeat(32), findHeight: '1', finderUntil: '20' });
  f.balances.set('p2:2', { amount: '1', current: true });
  const original = f.service.mintRights.bind(f.service);
  f.service.mintRights = async (owner, options) => {
    if (options.allowed === true && !options.cursor) return { mintRights: [{ asset: 'c2:' + 'ab'.repeat(32), block: null, compound: true }], next: 'empty-work' };
    if (options.cursor === 'empty-work') return { mintRights: [], nextCursor: 'rights-start' };
    return original(owner, { ...options, ...(options.cursor === 'rights-start' ? { cursor: undefined } : {}) });
  };
  let cursor; const rows = [], cursors = new Set();
  do {
    const response = await call('/api/claims?' + new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) }));
    assert.equal(response.status, 200); const page = await response.json();
    assert.ok(page.claims.length <= 1); rows.push(...page.claims); cursor = page.next;
    assert.ok(!cursor || !cursors.has(cursor)); cursors.add(cursor);
  } while (cursor);
  assert.deepEqual(rows.map(row => row.block), ['12', '11', '9', '8']);
  assert.deepEqual(rows.map(row => row.eligibility), ['own find', 'own find', 'units', 'units']);
  assert.equal(rows.at(-1).reason, 'insufficient_balance');
  assert.equal((await call('/api/claims?cursor=invalid')).status, 400);
});

test('balance reads follow empty cursors, preserve large integers and recheck a changed balance before signing', async t => {
  const f = await dashboardFixture(t), { call } = await start(t, f);
  const huge = '900719925474099312345'; f.claims[0].count = huge;
  f.balances.set('p2:1', { amount: huge, current: true });
  const original = f.service.profile.bind(f.service);
  f.service.profile = (owner, options) => options.collection === 'balances' && !options.cursor
    ? Promise.resolve({ balances: [], nextCursor: 'balances-next' }) : original(owner, { ...options, cursor: undefined });
  let row = (await (await call('/api/claims')).json()).claims.find(row => row.block === '12');
  assert.equal(row.balance, huge); assert.equal(row.count, huge); assert.equal(row.canMint, true);
  f.balances.set('p2:1', { amount: (BigInt(huge) - 1n).toString(), current: true });
  const response = await call('/api/mint', { asset: 'p2:1', block: '12' });
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'insufficient_balance' });
  f.balances.set('p2:1', { amount: huge, current: false });
  row = (await (await call('/api/claims')).json()).claims.find(row => row.block === '12');
  assert.equal(row.balanceCurrent, false); assert.equal(row.canMint, false); assert.equal(row.reason, 'balance_projection_pending');
  assert.equal(f.packets.length, 0);
  f.service.profile = (owner, options) => options.collection === 'balances'
    ? Promise.resolve({ balances: [], nextCursor: 'repeated' }) : original(owner, options);
  const repeated = await call('/api/claims'); assert.equal(repeated.status, 502);
  assert.deepEqual(await repeated.json(), { error: 'repeated_cursor' });
});

test('local regtest HTTP stack: one click signs the mint and reservation, returns fees, survives duplicate clicks and hides a completed mint', async t => {
  const f = await dashboardFixture(t, { http: true }), { call, dashboard } = await start(t, f);
  f.journal.take(20); // Exhaust mining's allowance before the click.
  const response = await call('/api/mint', { asset: 'p2:1', block: '12' });
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.status.state, 'awaiting_payment'); assert.equal(result.status.payable, true);
  assert.equal(result.status.receiver, f.binding.request.address); assert.equal(result.status.missing[0].amount, '1000000000000000000');
  assert.equal(f.packets.length, 2); assert.ok(f.packets[1].reserve.sig);
  assert.equal((await (await call('/api/requests/' + result.requestId + '/plan')).json()).payer, f.binding.request.address);
  const repeat = await (await call('/api/mint', { asset: 'p2:1', block: '12' })).json();
  assert.equal(repeat.requestId, result.requestId); assert.equal(f.packets.length, 2);
  const open = await (await call('/api/requests')).json(); assert.equal(open.requests[0].requestId, result.requestId);
  assert.equal((await call('/api/payment', { id: result.requestId, inscription: 'aa'.repeat(32) + 'i0' })).status, 200);
  await dashboard.close();
  const restarted = await start(t, f);
  assert.equal((await (await restarted.call('/api/mint', { asset: 'p2:1', block: '12' })).json()).requestId, result.requestId);
  assert.equal(f.packets.length, 2);
  f.records.get(result.requestId).state = 'minted'; f.minted.add('12');
  assert.deepEqual((await (await restarted.call('/api/claims')).json()).claims.map(row => row.block), ['11']);
  assert.equal((await restarted.call('/api/mint', { asset: 'p2:1', block: '12' })).status, 409);
  assert.equal(f.calls.some(call => call.path.startsWith('/mint/deployment/')), false);
});

test('mint all returns promptly, keeps reads responsive, and signs a bulk order without mining rounds', async t => {
  const f = await dashboardFixture(t), { call, dashboard } = await start(t, f);
  let release; f.pause(new Promise(resolve => { release = resolve; }));
  const response = await call('/api/mint-all', {}); assert.equal(response.status, 202);
  assert.equal((await call('/api/info')).status, 200);
  const repeated = await (await call('/api/mint-all', {})).json(); assert.equal(repeated.id, dashboard.state.batch.id);
  release(); await dashboard.state.batchTask;
  assert.equal(dashboard.state.batch.completed, 2); assert.equal(dashboard.state.batch.failed, 0);
  assert.equal(f.packets.length, 1); assert.deepEqual(f.packets[0].terms.members.map(m => m.block), ['11', '12']);
  assert.equal(f.packets[0].reserve.type, 'reserve-n');
});

test('unknown reservation retry preserves exact signatures and action identity', async t => {
  const f = await dashboardFixture(t), { call } = await start(t, f); f.lose();
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: '12' })).status, 503);
  const original = structuredClone(f.packets[1]);
  const result = await (await call('/api/mint', { asset: 'p2:1', block: '12' })).json();
  assert.equal(result.status.state, 'awaiting_payment'); assert.deepEqual(f.packets[2], original);
});

test('bound payout is cryptographically checked and changed binding cannot redirect a saved request', async t => {
  const f = await dashboardFixture(t), { call } = await start(t, f);
  f.binding.request.address = f.binding.request.address.replace(/.$/, 'x');
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: '12' })).status, 500);
  assert.equal(f.packets.length, 0);
});

test('browser recovery journal persists across ports and requires a server lock', async t => {
  const f = await dashboardFixture(t), { call, dashboard } = await start(t, f);
  const key = 'regtest/' + f.binding.request.address + '/' + 'cc'.repeat(32), owner = randomUUID();
  assert.equal((await call('/api/wallet', { key, owner, value: { payment: { state: 'sending' } } })).status, 409);
  await call('/api/wallet-lock', { key, owner });
  assert.equal((await call('/api/wallet-lock', { key, owner: randomUUID() })).status, 409);
  assert.equal((await call('/api/wallet', { key, owner, value: { payment: { state: 'sending' } } })).status, 200);
  await dashboard.close(); const reopened = await start(t, f);
  assert.deepEqual((await (await reopened.call('/api/wallet?key=' + encodeURIComponent(key))).json()).value, { payment: { state: 'sending' } });
});

test('untrusted remote failures expose only bounded codes, never signed packets or arbitrary error text', async t => {
  const f = await dashboardFixture(t), { call } = await start(t, f);
  f.context.candidates = async () => { throw Error('secret-placeholder/password?raw-signed-packet'); };
  const response = await call('/api/claims'); assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'dashboard_request_failed' });
});

test('dashboard bundle preserves the existing wallet API, adds bulk and reuses the stylesheet exactly', async () => {
  const legacy = await import('../../playground/console/js/inscribe/wallet.js'), current = await import('../dashboard/wallet.js');
  for (const key of Object.keys(legacy)) assert.equal(typeof current[key], typeof legacy[key], key);
  assert.equal(typeof current.TapWalletBulkMint, 'function');
  assert.deepEqual(await readFile(new URL('../dashboard/console.css', import.meta.url)), await readFile(new URL('../../playground/console/console.css', import.meta.url)));
});

test('only one dashboard can own a signer journal; an occupied port does not leave a runtime lock', async t => {
  const f = await dashboardFixture(t), { dashboard } = await start(t, f);
  await assert.rejects(serveDashboard(f.context), /dashboard_already_running/);
  const other = await dashboardFixture(t);
  await assert.rejects(serveDashboard(other.context, { port: Number(new URL(dashboard.origin).port) }), { code: 'EADDRINUSE' });
  const working = await serveDashboard(other.context); cleanup(t, () => working.close());
  assert.notEqual(working.origin, dashboard.origin);
});

test('empty continuation pages are traversed by mint all and repeated cursors stop safely', async t => {
  const f = await dashboardFixture(t), state = new DashboardState(f.context); cleanup(t, () => state.close());
  const original = state.claims.bind(state); let reads = 0;
  state.claims = async ({ cursor }) => {
    reads++;
    if (!cursor) return { claims: [], total: null, next: 'work-cursor' };
    return original({});
  };
  state.mintAll(); await state.batchTask;
  assert.equal(reads, 2); assert.equal(state.batch.completed, 2);
  state.claims = async () => ({ claims: [], total: null, next: 'repeated' });
  state.mintAll(); await state.batchTask;
  assert.equal(state.batch.state, 'failed'); assert.equal(state.batch.error, 'repeated_cursor');
});

test('dashboard resumes an existing numeric-block CLI action without changing its fingerprint or signatures', async t => {
  const { runTool } = await import('../lib/tools.mjs');
  const f = await dashboardFixture(t), { call } = await start(t, f); f.lose();
  await assert.rejects(runTool(f.context, 'mint_on_chain', { actionId: 'from-cli', asset: 'p2:1', block: 12, amount: '3',
    receiver: f.binding.request.address, payer: f.binding.request.address, kind: 'tap' }));
  const original = structuredClone(f.packets[1]);
  const result = await (await call('/api/mint', { asset: 'p2:1', block: '12' })).json();
  assert.equal(result.status.state, 'awaiting_payment'); assert.deepEqual(f.packets[2], original);
  assert.equal(f.journal.recent().filter(row => row.id.startsWith('mint/') && !row.id.endsWith('/reservation-v2')).length, 1);
});

test('mint all reports deployment requirements without pretending a request was signed', async t => {
  const f = await dashboardFixture(t), { call, dashboard } = await start(t, f);
  f.service.deploymentState = async asset => ({ state: 'awaiting_player_deploy', asset, catalogAsset: asset });
  await call('/api/mint-all', {}); await dashboard.state.batchTask;
  assert.equal(dashboard.state.batch.completed, 0); assert.equal(dashboard.state.batch.deploymentNeeded.length, 2);
  assert.ok(dashboard.state.batch.deploymentNeeded[0].deploymentLink.startsWith(f.service.origin + '/mint/'));
  // The page names each row; the raw asset key is never its label.
  for (const row of dashboard.state.batch.deploymentNeeded) assert.ok(row.name && row.name !== row.asset, row.name);
  assert.equal(f.packets.length, 0); assert.equal(f.journal.recent().length, 0);
  assert.equal(f.calls.some(call => call.path.startsWith('/mint/deployment/')), false);
});

test('an unregistered eligible asset retains the existing deployment link without signing or deployment reads', async t => {
  const f = await dashboardFixture(t), { call, dashboard } = await start(t, f);
  f.clock.counted = '1027'; f.claims[0].finder = 'ff'.repeat(32); f.unregistered.add('p2:1');
  const page = await (await call('/api/claims')).json();
  assert.equal(page.claims.length, 2);
  for (const row of page.claims) {
    assert.equal(row.canMint, false); assert.equal(row.reason, 'asset_unregistered');
    assert.equal(row.deploymentLink, f.service.deploymentLink('p2:1', f.agent.address));
  }
  await call('/api/mint-all', {}); await dashboard.state.batchTask;
  assert.equal(dashboard.state.batch.completed, 0); assert.equal(dashboard.state.batch.deploymentNeeded.length, 2);
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: '12' })).status, 409);
  assert.equal(f.packets.length, 0); assert.equal(f.journal.recent().length, 0);
  assert.equal(f.calls.some(call => call.path.startsWith('/mint/deployment/')), false);
});

test('unsafe numeric block input and signing overrides are refused; expired intents are retained', async t => {
  const f = await dashboardFixture(t), { call } = await start(t, f);
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: Number.MAX_SAFE_INTEGER + 1 })).status, 400);
  assert.equal((await call('/api/mint', { asset: 'p2:1', block: '12', amount: '1' })).status, 400);
  const { requestId } = await (await call('/api/mint', { asset: 'p2:1', block: '12' })).json();
  f.records.get(requestId).state = 'expired'; f.records.get(requestId).payable = false;
  const row = (await (await call('/api/claims')).json()).claims.find(row => row.block === '12');
  assert.equal(row.state, 'expired'); assert.equal(row.canMint, false); assert.equal(row.pending, false);
  assert.equal((await (await call('/api/mint', { asset: 'p2:1', block: '12' })).json()).requestId, requestId);
  assert.equal(f.packets.length, 2);
});

test('your patterns: a new pattern without claims offers Deploy, a deployed one does not, and the claims filter shows one pattern', async t => {
  const f = await dashboardFixture(t), { call, dashboard } = await start(t, f);
  const owner = f.agent.owner, settingsHash = f.claims[0].settingsHash;
  f.patterns.push({ number: '2', asset: 'p2:2', name: 'dmwfresh', tier: 5 }, { number: '3', asset: 'p2:3', name: 'dmwother', tier: 2 });
  f.discoveries.push({ number: '2', asset: 'p2:2', name: 'dmwfresh', tier: 5, discoverer: owner, state: 'accepted' });
  f.unregistered.add('p2:2');
  f.claims.push({ asset: 'p2:3', block: '9', count: '3', finder: owner, findHeight: '19', finderUntil: '1027', settingsHash });
  f.balances.set('p2:3', { amount: '100', current: true });
  const { patterns } = await (await call('/api/patterns')).json();
  assert.deepEqual(patterns.map(p => [p.asset, p.name, p.token, p.claims, p.discovered]),
    [['p2:1', 'dmwtest', 'deployed', 2, false], ['p2:2', 'dmwfresh', 'not_deployed', 0, true], ['p2:3', 'dmwother', 'deployed', 1, false]]);
  const fresh = patterns.find(p => p.asset === 'p2:2');
  assert.equal(fresh.tier, 5); assert.equal(fresh.deploymentLink, f.service.deploymentLink('p2:2', f.agent.address));
  for (const p of patterns.filter(p => p.token === 'deployed')) assert.equal(p.deploymentLink, null);
  // The pattern inscription is in a block: the next step continues the same deployment page.
  f.deployments.set('p2:2', { asset: 'p2:2', state: 'awaiting_player_deploy', phase: 'deployment', elementId: 'ab'.repeat(32) + 'i0' });
  dashboard.state.patternCache = null;
  const inscribed = (await (await call('/api/patterns')).json()).patterns.find(p => p.asset === 'p2:2');
  assert.equal(inscribed.token, 'inscribed'); assert.equal(inscribed.deploymentLink, fresh.deploymentLink);
  const only = async asset => (await (await call('/api/claims?asset=' + asset)).json()).claims.map(r => r.asset + '/' + r.block);
  assert.deepEqual(await only('p2:3'), ['p2:3/9']);
  assert.deepEqual(await only('p2:1'), ['p2:1/12', 'p2:1/11']);
  assert.deepEqual(await only('p2:2'), []);
  assert.equal((await (await call('/api/claims')).json()).claims.length, 3);
  assert.equal((await call('/api/claims?asset=bad')).status, 400);
  assert.equal((await call('/api/patterns?asset=p2:1')).status, 400);
  // Reads only: no deployment is started and nothing is signed.
  assert.equal(f.calls.some(c => c.path.startsWith('/mint/deployment/') || c.method !== 'GET'), false);
  assert.equal(f.packets.length, 0);
});


test('your patterns: held units keep a pattern listed when its official blocks are all minted and another ticker exists', async t => {
  const f = await dashboardFixture(t), { call, dashboard } = await start(t, f);
  f.minted.add('11'); f.minted.add('12');
  const official = { tick: 'dmwtest', ordinal: '1', deploymentId: 'a'.repeat(64) + 'i0' }, extra = { tick: 'tests', ordinal: '2', deploymentId: 'b'.repeat(64) + 'i0' };
  let tickers = [official]; const asked = [];
  f.service.assetTickers = async (asset, options) => { asked.push([asset, options]); return { rows: tickers, next: null }; };
  const listed = async () => { dashboard.state.patternCache = null; return (await (await call('/api/patterns')).json()).patterns.map(p => [p.asset, p.token, p.claims, p.otherTickers ?? false]); };
  // One ticker: nothing left to mint, so the pattern stays hidden as before.
  assert.deepEqual(await listed(), []);
  assert.deepEqual(asked, [['p2:1', { limit: 2 }]]);
  // Another ticker can still mint every block: the row (and its Tickers choice) stays.
  tickers = [official, extra];
  assert.deepEqual(await listed(), [['p2:1', 'deployed', 0, true]]);
  // Without units nothing can be minted into any ticker, and nothing more is read.
  f.balances.set('p2:1', { amount: '0', current: true }); asked.length = 0;
  assert.deepEqual(await listed(), []);
  assert.deepEqual(asked, []);
  // An open official claim lists the pattern as before, without a ticker read.
  f.balances.set('p2:1', { amount: '100', current: true }); f.minted.delete('12');
  assert.deepEqual(await listed(), [['p2:1', 'deployed', 1, false]]);
  assert.deepEqual(asked, []);
  assert.equal(f.packets.length, 0);
});

test('dashboard gives each ticker its own saved mint action and resumes its selected request', async t => {
  const f = await dashboardFixture(t), { dashboard } = await start(t, f);
  const { PER_TICKER_SUPPLY_HEIGHT } = await import('../../rules/src/index.js'); f.clock.counted = PER_TICKER_SUPPLY_HEIGHT;
  const deployment = 'd'.repeat(64) + 'i0', candidates = f.context.candidates, quote = f.service.mintQuote.bind(f.service);
  f.context.candidates = async (asset, options) => (await candidates(asset, options)).map(c => ({ ...c, ...(options.deployment ? { deployment: options.deployment } : {}) }));
  f.service.mintQuote = async input => { const value = await quote(input); return { ...value,
    feeQuote: { ...value.feeQuote, ...(input.deployment ? { deploymentId: input.deployment } : {}) } }; };
  const slot = { asset: 'p2:1', block: '12' }, official = await dashboard.state.mint(slot), extra = await dashboard.state.mint({ ...slot, deployment });
  assert.notEqual(official.requestId, extra.requestId); assert.equal(f.packets.length, 4);
  assert.equal((await dashboard.state.mint(slot)).requestId, official.requestId);
  assert.equal((await dashboard.state.mint({ ...slot, deployment })).requestId, extra.requestId); assert.equal(f.packets.length, 4);
  const open = await dashboard.state.requests(); assert.equal(open.requests.find(r => r.requestId === extra.requestId).deployment, deployment);
  assert.equal(f.journal.recent().filter(r => r.id.startsWith('mint/') && !r.id.endsWith('/reservation-v2')).length, 2);
});

test('three quick Mint clicks submit concurrently and duplicate clicks share one request', { timeout: 10000 }, async t => {
  const f = await dashboardFixture(t, { http: true }), { call } = await start(t, f);
  f.minted.delete('10');
  const request = f.service.requestMint.bind(f.service), entered = [], pending = [];
  let allEntered;
  const all = new Promise(resolve => { allEntered = resolve; });
  f.service.requestMint = async body => {
    if (body.reserve) {
      entered.push(body);
      const blocked = new Promise(resolve => pending.push(resolve));
      if (entered.length === 3) allEntered();
      await blocked;
    }
    return request(body);
  };
  t.after(() => pending.forEach(resolve => resolve()));
  const clicks = ['12', '11', '10', '12'].map(block => call('/api/mint', { asset: 'p2:1', block }));
  await all; // No response has completed: every distinct request reached reserve.
  assert.equal(new Set(entered.map(b => b.request.nonce)).size, 3);
  assert.ok(entered.every(b => b.reserve.type === 'reserve-n' && !Object.hasOwn(b.reserve, 'revision')));
  pending.forEach(resolve => resolve());
  const responses = await Promise.all(clicks);
  assert.ok(responses.every(r => r.status === 200));
  const bodies = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(bodies.map(b => b.requestId)).size, 3);
  assert.equal(bodies[0].requestId, bodies[3].requestId);
  assert.equal(f.packets.length, 6);
});

test('a saved mint the gateway never took and that expired is retired and signed afresh on the next click', async t => {
  const f = await dashboardFixture(t), { dashboard } = await start(t, f);
  const { serviceError } = await import('../lib/errors.mjs');
  const refuse = code => serviceError({ service: 'Gateway service', origin: 'http://gateway', route: '/mint/quote', method: 'POST', status: code === 'mint_capacity' ? 503 : 400, code });
  const original = f.service.requestMint.bind(f.service), refusals = ['mint_capacity', 'financial_request_expired'], sent = [];
  f.service.requestMint = async body => { if (!body.reserve) sent.push(body.request.nonce); if (!body.reserve && refusals.length) throw refuse(refusals.shift()); return original(body); };
  const slot = { asset: 'p2:1', block: '12' };
  await assert.rejects(dashboard.state.mint(slot), /mint_capacity/);
  const result = await dashboard.state.mint(slot);
  assert.match(result.requestId, /^[0-9a-f]{64}$/);
  assert.equal(sent.length, 3); assert.equal(sent[0], sent[1]); assert.notEqual(sent[2], sent[1]);
  const open = (await dashboard.state.requests()).requests.filter(r => r.block === '12');
  assert.deepEqual(open.map(r => r.requestId), [result.requestId]);
  assert.equal((await dashboard.state.mint(slot)).requestId, result.requestId);
});
