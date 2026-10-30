import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { serveDashboard } from '../lib/dashboard.mjs';
import { parseSendList, groupSends } from '../lib/dashboard-state.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { cleanup } from './helpers.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const address = n => encodeTracAddress(String(n).padStart(2, '0').repeat(32));
const COMPOUND = 'c2:' + 'ab'.repeat(32);

async function start(t, setup = () => {}) {
  const f = await dashboardFixture(t);
  // Units of every kind: a pattern, an imported legacy pattern and a compound.
  f.patterns.push({ number: '0', asset: 'p2:0', name: 'dmwflorite', tier: 4 }, { number: '2', asset: 'p2:2', name: 'dmwmuffinite', tier: 2 });
  f.balances.set('p2:2', { amount: '7', current: true }); f.balances.set('p0', { amount: '100', current: true });
  f.balances.set(COMPOUND, { amount: '3', current: true });
  const service = f.agent.service, profile = service.profile.bind(service), events = [];
  service.compounds = async ({ asset }) => ({ compounds: asset === COMPOUND ? [{ id: COMPOUND, recipe: 'resonance', inputs: [['p2:2', '2'], ['p2:1', '1']] }] : [] });
  service.profile = async (owner, options) => options.collection === 'history' ? { history: events, nextCursor: null } : profile(owner, options);
  // The kit's transfer action, observed: every call, with journal rows like
  // the real action writes (signed intent, then the gateway receipt).
  const transfers = [], outcomes = [];
  f.agent.transaction = async ({ actionId, op, value }) => {
    transfers.push({ actionId, op, value, saved: dashboard.state.savedSends(50).some(s => s.groups.some(g => g.actionId === actionId)) });
    const outcome = outcomes.shift();
    if (outcome) throw outcome;
    const nonce = sha('nonce/' + actionId), move = sha('move/' + actionId);
    if (!f.journal.get(`tx/${actionId}/v2-intent`)) f.journal.reserve(`tx/${actionId}/v2-intent`, { op, value }, { version: 2, actions: [{ nonce }] });
    if (!f.journal.get(`tx/${actionId}/v2-move`)) f.journal.reserve(`tx/${actionId}/v2-move`, { type: 'transfer-v2' }, { v: 2 });
    f.journal.mark(`tx/${actionId}/v2-move`, 'received', { move, batch: '41' });
    return { state: 'received', actionId };
  };
  setup(f);
  const dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const token = new URL(dashboard.loginLink).hash.slice(1);
  const login = await fetch(dashboard.origin + '/login', { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, body, headers = {}) => {
    const response = await fetch(dashboard.origin + path, { headers: { cookie, origin: dashboard.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const settle = () => dashboard.state.sendTail;
  return { f, dashboard, call, transfers, outcomes, events, settle };
}

test('paste lists parse address, unit name (several words allowed) and amount with comma, tab, semicolon or space', () => {
  const rows = parseSendList(`# recipients\n${address(1)}, dmwmuffinite, 2\n\n${address(2)}\tCompound #abababab\t1\n${address(3)} p2:1 5;\n${address(4)};dmwflorite;3`);
  assert.deepEqual(rows.map(r => [r.line, r.unit, r.amount]), [[2, 'dmwmuffinite', '2'], [4, 'Compound #abababab', '1'], [5, 'p2:1', '5'], [6, 'dmwflorite', '3']]);
  assert.equal(rows[0].to, address(1));
  assert.deepEqual(parseSendList(address(1)), [{ line: 1, to: address(1), unit: '', amount: '' }]);
  assert.throws(() => parseSendList(Array(201).fill(`${address(1)} x 1`).join('\n')), /send_too_many_rows/);
});

test('rows group into one transfer per recipient, summing a repeated unit, and split above 16 units', () => {
  const rows = [{ to: address(1), asset: 'p2:1', amount: '2' }, { to: address(2), asset: 'p2:1', amount: '1' }, { to: address(1), asset: 'p2:1', amount: '3' }, { to: address(1), asset: 'p2:2', amount: '1' }];
  assert.deepEqual(groupSends(rows), [{ to: address(1), assets: [['p2:1', '5'], ['p2:2', '1']] }, { to: address(2), assets: [['p2:1', '1']] }]);
  const many = Array.from({ length: 20 }, (_, i) => ({ to: address(3), asset: 'p2:' + (i + 10), amount: '1' }));
  const split = groupSends(many);
  assert.deepEqual(split.map(g => [g.to, g.assets.length]), [[address(3), 16], [address(3), 4]]);
  assert.deepEqual(split.flatMap(g => g.assets.map(a => a[0])), many.map(r => r.asset));
});

test('units are labelled for people: pattern name and tier, imported pattern name, compound recipe; keys stay a detail', async t => {
  const { call } = await start(t);
  const { body } = await call('/api/units');
  const unit = asset => body.units.find(u => u.asset === asset);
  assert.equal(body.address, (await call('/api/info')).body.address);
  assert.deepEqual([unit('p2:1').name, unit('p2:1').kind, unit('p2:1').tier, unit('p2:1').available], ['dmwtest', 'pattern', 3, '100']);
  assert.deepEqual([unit('p2:2').name, unit('p2:2').tier], ['dmwmuffinite', 2]);
  assert.deepEqual([unit('p0').name, unit('p0').kind], ['dmwflorite', 'legacy']);
  assert.deepEqual([unit(COMPOUND).name, unit(COMPOUND).kind], ['Compound · resonance of dmwmuffinite + dmwtest', 'compound']);
  assert.ok(body.units.every(u => !/^(p2:|c2:|p0)/.test(u.name)));
});

test('an unknown compound or pattern still gets a human label, never the bare key', async t => {
  const { call } = await start(t, f => { f.balances.set('c2:' + 'cd'.repeat(32), { amount: '1', current: true }); f.balances.set('p2:9', { amount: '1', current: true }); });
  const { body } = await call('/api/units');
  assert.equal(body.units.find(u => u.asset === 'c2:' + 'cd'.repeat(32)).name, 'Compound #cdcdcdcd');
  assert.equal(body.units.find(u => u.asset === 'p2:9').name, 'Pattern #9');
});

test('review checks every row before signing: checksum, own address, unit, amount and totals per unit', async t => {
  const { call, transfers, f } = await start(t);
  const bad = address(1).slice(0, -1) + (address(1).endsWith('q') ? 'p' : 'q');
  const { body } = await call('/api/send-review', { text: [`${bad}, dmwmuffinite, 1`, `${f.agent.address}, dmwmuffinite, 1`, `${address(1)}, dmwnothing, 1`,
    `${address(1)}, dmwmuffinite, 0`, `${address(1)}, dmwmuffinite, 4`, `${address(2)}, DMWMuffinite, 4`, `${address(3)}, dmwtest, 100`].join('\n') });
  assert.equal(body.ok, false);
  assert.deepEqual(body.rows.map(r => r.error), ['send_address', 'send_self', 'send_unit_unknown', 'send_amount', 'send_over_available', 'send_over_available', null]);
  assert.equal(body.rows[6].asset, 'p2:1'); assert.equal(body.rows[6].name, 'dmwtest');
  assert.equal(transfers.length, 0);
  const ok = (await call('/api/send-review', { rows: [{ to: address(1), unit: 'p2:2', amount: '2' }, { to: address(1), unit: 'dmwflorite', amount: '5' }, { to: address(2), unit: 'abababab', amount: '1' }] })).body;
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.groups.map(g => [g.to, g.assets, g.labels]), [[address(1), [['p2:2', '2'], ['p0', '5']], ['dmwmuffinite', 'dmwflorite']], [address(2), [[COMPOUND, '1']], ['Compound · resonance of dmwmuffinite + dmwtest']]]);
  assert.equal((await call('/api/send', { rows: [{ to: bad, unit: 'p2:2', amount: '1' }] })).status, 400);
  assert.equal(transfers.length, 0);
});

test('send saves every action ID first, then calls the kit transfer action once per recipient with the exact unit keys', async t => {
  const { call, transfers, settle, events, dashboard } = await start(t);
  const { status, body } = await call('/api/send', { rows: [{ to: address(1), unit: 'p2:2', amount: '2' }, { to: address(2), unit: 'dmwflorite', amount: '5' }, { to: address(1), unit: 'p2:2', amount: '1' }] });
  assert.equal(status, 202);
  await settle();
  assert.deepEqual(transfers.map(c => [c.op, c.value]), [['tf', { to: address(1), assets: [['p2:2', '3']] }], ['tf', { to: address(2), assets: [['p0', '5']] }]]);
  assert.ok(transfers.every(c => c.saved), 'action IDs are saved before the transfer action runs');
  assert.deepEqual(transfers.map(c => c.actionId), body.groups.map(g => g.actionId));
  let sends = (await call('/api/sends')).body.sends;
  assert.deepEqual(sends[0].groups.map(g => [g.state, g.batch]), [['received', '41'], ['received', '41']]);
  assert.deepEqual(sends[0].groups[0].assets, [{ asset: 'p2:2', amount: '3', name: 'dmwmuffinite' }]);
  // Units in an unconfirmed send are no longer offered as available.
  assert.equal((await call('/api/units')).body.units.find(u => u.asset === 'p2:2').available, '4');
  // The accepted transfer's public event confirms it with its batch.
  const id = transfers[0].actionId;
  dashboard.state.confirmCache = null; // the public history read is cached for 10 s
  events.push({ id: sha('v2-event/transfer/' + sha('move/' + id) + '/' + sha('nonce/' + id)), type: 'transfer', sequence: '9', provenance: { batch: '42' } });
  sends = (await call('/api/sends')).body.sends;
  assert.deepEqual(sends[0].groups.map(g => [g.state, g.batch]), [['confirmed', '42'], ['received', '41']]);
});

test('a partial failure retries only the unsent transfers with the same action IDs; uncertain sends are never replaced', async t => {
  const { call, transfers, outcomes, settle } = await start(t);
  outcomes.push(undefined, Object.assign(Error('transfer_insufficient_units'), {}), Object.assign(Error('gateway timeout'), { code: 'transport_error' }));
  const { body } = await call('/api/send', { rows: [{ to: address(1), unit: 'p2:2', amount: '1' }, { to: address(2), unit: 'p2:2', amount: '1' }, { to: address(3), unit: 'p2:2', amount: '1' }] });
  await settle();
  let send = (await call('/api/sends')).body.sends[0];
  assert.deepEqual(send.groups.map(g => [g.state, g.error ?? null]), [['received', null], ['failed', 'transfer_insufficient_units'], ['failed', 'transport_error']]);
  const ids = body.groups.map(g => g.actionId);
  assert.equal((await call('/api/send-retry', { id: body.id })).status, 202);
  await settle();
  assert.deepEqual(transfers.map(c => c.actionId), [...ids, ids[1], ids[2]]);
  send = (await call('/api/sends')).body.sends[0];
  assert.deepEqual(send.groups.map(g => g.state), ['received', 'received', 'received']);
  assert.equal((await call('/api/send-retry', { id: body.id })).status, 409);
  assert.equal(transfers.length, 5);
});

test('a full next batch queues the rest for the next block and continues by itself with the same IDs', async t => {
  const { call, transfers, outcomes, settle } = await start(t);
  outcomes.push(undefined, Object.assign(Error('full'), { code: 'next_batch_account_capacity', status: 429, retryAfterMs: 1 }));
  const { body } = await call('/api/send', { rows: [{ to: address(1), unit: 'p2:2', amount: '1' }, { to: address(2), unit: 'p2:2', amount: '1' }, { to: address(3), unit: 'p2:2', amount: '1' }] });
  await settle();
  const ids = body.groups.map(g => g.actionId);
  assert.deepEqual(transfers.map(c => c.actionId), [ids[0], ids[1], ids[1], ids[2]]);
  assert.deepEqual((await call('/api/sends')).body.sends[0].groups.map(g => g.state), ['received', 'received', 'received']);
});

test('a stale signature is signed again only on request, under a new action ID; the old one is marked replaced', async t => {
  const { call, transfers, outcomes, settle } = await start(t);
  outcomes.push(Object.assign(Error('transfer_intent_stale')));
  const { body } = await call('/api/send', { rows: [{ to: address(1), unit: 'p2:2', amount: '1' }] });
  await settle();
  const old = body.groups[0].actionId;
  assert.equal((await call('/api/sends')).body.sends[0].groups[0].state, 'stale');
  assert.equal((await call('/api/send-retry', { id: body.id })).status, 409, 'Retry never replaces an action ID');
  assert.equal(transfers.length, 1);
  const resigned = (await call('/api/send-resign', { id: body.id, actionId: old })).body;
  await settle();
  assert.equal(transfers.length, 2); assert.notEqual(transfers[1].actionId, old);
  assert.deepEqual(transfers[1].value, transfers[0].value);
  assert.deepEqual(resigned.groups.map(g => g.replacedBy), [transfers[1].actionId, null]);
  assert.deepEqual((await call('/api/sends')).body.sends[0].groups.map(g => g.state), ['replaced', 'received']);
  assert.equal((await call('/api/send-resign', { id: body.id, actionId: old })).status, 409);
});

test('send endpoints keep the dashboard login and origin protections', async t => {
  const { call, dashboard, transfers } = await start(t);
  const rows = [{ to: address(1), unit: 'p2:2', amount: '1' }];
  assert.equal((await call('/api/send', { rows }, { origin: 'https://example.com' })).status, 403);
  assert.equal((await call('/api/send', { rows }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  for (const path of ['/api/send', '/api/send-review', '/api/send-retry', '/api/send-resign']) {
    const response = await fetch(dashboard.origin + path, { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' }, body: JSON.stringify({ rows }) });
    assert.equal(response.status, 401);
  }
  assert.equal((await fetch(dashboard.origin + '/api/units')).status, 401);
  assert.equal((await call('/api/send', { rows, extra: true })).status, 400);
  assert.equal(transfers.length, 0);
});

test('My agent words every transfer outcome in plain language', async () => {
  const source = await readFile(new URL('../dashboard/agent.js', import.meta.url), 'utf8');
  for (const code of ['transfer_insufficient_units', 'transfer_unknown_asset', 'send_address', 'transfer_intent_stale', 'transfer_intent_expired', 'transfer_v2_unavailable',
    'next_batch_account_capacity', 'send_over_available', 'send_unit_unknown']) assert.match(source, new RegExp(`\\b${code}: '[A-Z]`), code);
  assert.match(source, /not a Bitcoin or TAP token transfer and not an inscription/);
});

test('the real kit transfer action runs behind Send: its saved authorization is kept and Retry reuses the same action ID', async t => {
  const f = await dashboardFixture(t);
  f.balances.set('p2:1', { amount: '100', current: true });
  const context = await f.agent.namedContext(), signed = [];
  f.agent.namedContext = async () => ({ ...context, ready: true });
  Object.assign(f.agent.trac, { accountRoot: async () => ({ root: 'ac'.repeat(32), revision: '4' }), balance: async (_, asset) => asset === 'p2:1' ? '100' : '0' });
  const dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const state = dashboard.state;
  const sent = await state.send({ rows: [{ to: address(1), unit: 'dmwtest', amount: '3' }] });
  await state.sendTail;
  const id = sent.groups[0].actionId, intent = f.journal.get(`tx/${id}/v2-intent`);
  // Before public-mint activation the kit saves the signed authorization and sends nothing.
  assert.deepEqual(intent.body.actions.map(a => [a.asset, a.amount, a.revision]), [['p2:1', '3', '4']]);
  assert.deepEqual((await state.sends()).sends[0].groups.map(g => [g.state, g.error]), [['failed', 'transfer_v2_unavailable']]);
  signed.push(...intent.body.actions.map(a => a.sig));
  await state.retrySend({ id: sent.id }); await state.sendTail;
  const again = f.journal.get(`tx/${id}/v2-intent`);
  assert.deepEqual(again.body.actions.map(a => a.sig), signed, 'the same saved authorization, not a new one');
  assert.equal(state.savedSends(5)[0].groups.length, 1);
  assert.equal(f.journal.get(`tx/${id}/v2-move`), null);
});
