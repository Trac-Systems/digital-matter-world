import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serveDashboard } from '../lib/dashboard.mjs';
import { nativeTnk } from '../lib/tnk-runtime.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { fixtureBus } from './fixtures/tnk-adapter.mjs';
import { cleanup, testWallet } from './helpers.mjs';

const to = encodeTracAddress(testWallet(2).publicKey);

// The dashboard fixture with the native TNK runtime over the installed MSB
// builder (in-memory balances and validators), and every TNK send observed.
async function start(t, setup = () => {}) {
  const f = await dashboardFixture(t), { bus, state: msb } = fixtureBus(testWallet());
  Object.assign(f.agent.trac, nativeTnk(bus));
  const sends = [], send = f.agent.sendTnkTransfer.bind(f.agent);
  f.agent.sendTnkTransfer = async args => {
    sends.push({ ...args, saved: dashboard.state.savedTnk().some(s => s.actionId === args.actionId) });
    return send(args);
  };
  setup(f, msb);
  const dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const token = new URL(dashboard.loginLink).hash.slice(1);
  const login = await fetch(dashboard.origin + '/login', { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, body, headers = {}) => {
    const response = await fetch(dashboard.origin + path, { headers: { cookie, origin: dashboard.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const settle = () => dashboard.state.tnkTail;
  const fresh = () => { dashboard.state.tnkCache = null; dashboard.state.tnkStatus.clear(); };
  return { f, msb, dashboard, call, sends, settle, fresh };
}

test('the TNK card reads balance, fee per send and max = balance − fee; a missing account is "no TNK yet"', async t => {
  const { call, msb, f, fresh } = await start(t);
  const { body } = await call('/api/tnk');
  assert.deepEqual(body, { address: f.agent.address, ready: true, accountExists: true, balanceTnk: '10', feeTnk: '0.01', outTnk: '0', maxTnk: '9.99' });
  msb.balance = 5n * 10n ** 15n; fresh();
  assert.equal((await call('/api/tnk')).body.maxTnk, '0', 'less than the fee: nothing to send');
  msb.exists = false; fresh();
  assert.deepEqual((await call('/api/tnk')).body, { address: f.agent.address, ready: true, accountExists: false, balanceTnk: '0', feeTnk: '0.01', outTnk: '0', maxTnk: '0' });
});

test('TNK still on its way out lowers Max and the review until the send confirms', async t => {
  const { call, msb, settle, fresh } = await start(t);
  await call('/api/tnk-send', { to, amount: '6' }); await settle();
  assert.deepEqual([(await call('/api/tnk')).body.outTnk, (await call('/api/tnk')).body.maxTnk], ['6.01', '3.98']);
  assert.deepEqual(await call('/api/tnk-review', { to, amount: '3.99' }), { status: 400, body: { error: 'tnk_insufficient' } });
  assert.equal((await call('/api/tnk-review', { to, amount: '3.98' })).body.remainingTnk, '0');
  const packet = JSON.parse(msb.sent[0].bytes);
  msb.confirmed.set(packet.tro.tx, { decoded: packet }); msb.balance -= 601n * 10n ** 16n; fresh();
  assert.deepEqual([(await call('/api/tnk')).body.outTnk, (await call('/api/tnk')).body.maxTnk], ['0', '3.98']);
});

test('the TNK balance read is cached a few seconds', async t => {
  const { call, msb, fresh } = await start(t);
  assert.equal((await call('/api/tnk')).body.balanceTnk, '10');
  msb.balance = 2n * 10n ** 18n;
  assert.equal((await call('/api/tnk')).body.balanceTnk, '10', 'cached');
  fresh();
  assert.equal((await call('/api/tnk')).body.balanceTnk, '2');
});

test('review is unsigned and names amount, fee, total and what is left; bad input gets a TNK code', async t => {
  const { call, msb, sends, f } = await start(t);
  const ok = await call('/api/tnk-review', { to, amount: ' 1.25 ' });
  assert.deepEqual(ok, { status: 200, body: { to, amount: '1.25', feeTnk: '0.01', totalTnk: '1.26', totalAtoms: '1260000000000000000', balanceTnk: '10', remainingTnk: '8.74' } });
  assert.equal((await call('/api/tnk-review', { to, amount: '9.99' })).body.remainingTnk, '0', 'max = balance − fee fits exactly');
  for (const [body, error] of [[{ to, amount: '9.991' }, 'tnk_insufficient'], [{ to: to.slice(0, -1) + 'q', amount: '1' }, 'tnk_invalid_address'],
    [{ to: f.agent.address, amount: '1' }, 'tnk_self'], [{ to, amount: '1e3' }, 'tnk_invalid_amount'], [{ to, amount: 'max' }, 'tnk_invalid_amount'], [{ to, amount: '0' }, 'tnk_invalid_amount']]) {
    assert.deepEqual(await call('/api/tnk-review', body), { status: 400, body: { error } }, error);
  }
  assert.equal((await call('/api/tnk-review', { to, amount: '1', extra: 1 })).status, 400);
  assert.equal(msb.signed, 0); assert.equal(sends.length, 0);
});

test('confirm saves the action ID first, then calls the TNK send with it: pending, then confirmed from the network', async t => {
  const { call, msb, sends, settle, fresh, f } = await start(t);
  const started = await call('/api/tnk-send', { to, amount: '1.25' });
  assert.equal(started.status, 202);
  assert.equal(started.body.actionId, `dash-tnk-${started.body.id}`);
  await settle();
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], { actionId: `dash-tnk-${started.body.id}`, to, amount: '1.25', saved: true });
  assert.equal(msb.signed, 1); assert.equal(msb.sent.length, 3);
  const tx = JSON.parse(msb.sent[0].bytes).tro.tx;
  let [row] = (await call('/api/tnk-sends')).body.sends;
  assert.deepEqual([row.state, row.tx, row.amount, row.feeTnk, row.to, row.retry], ['sent', tx, '1.25', '0.01', to, false]);
  msb.pending.set(tx, { decoded: JSON.parse(msb.sent[0].bytes) }); fresh();
  [row] = (await call('/api/tnk-sends')).body.sends;
  assert.equal(row.state, 'pending');
  msb.confirmed.set(tx, { decoded: JSON.parse(msb.sent[0].bytes) }); fresh();
  [row] = (await call('/api/tnk-sends')).body.sends;
  assert.equal(row.state, 'confirmed');
  assert.equal(f.journal.get(`tnk/dash-tnk-${started.body.id}`).state, 'accepted');
  assert.equal((await call('/api/tnk-retry', { id: row.id })).status, 409, 'nothing to retry once confirmed');
  assert.equal(msb.signed, 1);
});

test('retry reuses the saved action ID: no new signature, the same signed bytes again', async t => {
  const { call, msb, sends, settle, fresh } = await start(t, (f, msb) => { msb.transportError = true; });
  const { body } = await call('/api/tnk-send', { to, amount: '2' });
  await settle();
  let [row] = (await call('/api/tnk-sends')).body.sends;
  assert.deepEqual([row.state, row.error, row.retry], ['uncertain', 'tnk_unknown_status', true]);
  msb.transportError = false; fresh();
  assert.equal((await call('/api/tnk-retry', { id: body.id })).status, 202);
  assert.equal((await call('/api/tnk-retry', { id: body.id })).status, 409, 'a queued retry cannot be queued twice');
  await settle();
  assert.deepEqual(sends.map(s => s.actionId), [`dash-tnk-${body.id}`, `dash-tnk-${body.id}`]);
  assert.equal(msb.signed, 1, 'signed once');
  assert.equal(new Set(msb.sent.map(s => s.bytes)).size, 1, 'the same signed transfer');
  [row] = (await call('/api/tnk-sends')).body.sends;
  assert.equal(row.state, 'sent');
});

test('missing validators: nothing signed, plain "waiting for the network", Retry signs once under the same ID', async t => {
  const { call, msb, sends, settle, fresh } = await start(t, (f, msb) => { msb.validators = ['validator-a']; });
  const { body } = await call('/api/tnk-send', { to, amount: '1' });
  await settle();
  let [row] = (await call('/api/tnk-sends')).body.sends;
  assert.deepEqual([row.state, row.error, row.retry, msb.signed], ['failed', 'tnk_validators', true, 0]);
  msb.validators = ['validator-a', 'validator-b', 'validator-c']; fresh();
  await call('/api/tnk-retry', { id: body.id }); await settle();
  [row] = (await call('/api/tnk-sends')).body.sends;
  assert.equal(row.state, 'sent'); assert.equal(msb.signed, 1);
  assert.deepEqual(new Set(sends.map(s => s.actionId)), new Set([`dash-tnk-${body.id}`]));
});

test('a send over the balance is refused before saving; an interrupted signing claim is never signed again', async t => {
  const { call, msb, sends, settle, dashboard, f } = await start(t);
  assert.deepEqual(await call('/api/tnk-send', { to, amount: '10' }), { status: 400, body: { error: 'tnk_insufficient' } });
  assert.equal(dashboard.state.savedTnk().length, 0); assert.equal(sends.length, 0);
  // A claim without a saved packet (the process died while signing).
  const { body } = await call('/api/tnk-send', { to, amount: '1' }); await settle();
  const id = `tnk/dash-tnk-${body.id}`, row = f.journal.get(id);
  f.journal.db.prepare('UPDATE actions SET body=? WHERE scope=? AND id=?').run(JSON.stringify({ ...row.body, packet: null }), f.journal.scope, id);
  const [view] = (await call('/api/tnk-sends')).body.sends;
  assert.deepEqual([view.state, view.error, view.retry], ['uncertain', 'tnk_interrupted', false]);
  assert.equal((await call('/api/tnk-retry', { id: body.id })).status, 409);
  assert.equal(msb.signed, 1);
});

test('TNK endpoints keep the dashboard login and origin protections', async t => {
  const { call, dashboard, sends, msb } = await start(t);
  const body = { to, amount: '1' };
  for (const path of ['/api/tnk-review', '/api/tnk-send', '/api/tnk-retry']) {
    assert.equal((await call(path, body, { origin: 'https://example.com' })).status, 403, path);
    assert.equal((await call(path, body, { 'sec-fetch-site': 'cross-site' })).status, 403, path);
    const response = await fetch(dashboard.origin + path, { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 401, path);
  }
  for (const path of ['/api/tnk', '/api/tnk-sends']) {
    assert.equal((await fetch(dashboard.origin + path)).status, 401, path);
    assert.equal((await call(path, undefined, { 'sec-fetch-site': 'cross-site' })).status, 403, path);
    assert.equal((await call(path + '?x=1')).status, 400, path);
  }
  assert.equal(sends.length, 0); assert.equal(msb.signed, 0);
});

test('without the native runtime the TNK card says so instead of failing the page', async t => {
  const f = await dashboardFixture(t), dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  assert.deepEqual(await dashboard.state.tnk(), { address: f.agent.address, ready: false, error: 'tnk_unavailable' });
});

test('My agent words every TNK outcome in plain language and keeps units and TNK apart', async () => {
  const source = await readFile(new URL('../dashboard/agent.js', import.meta.url), 'utf8');
  for (const code of ['tnk_insufficient', 'tnk_self', 'tnk_validators', 'tnk_balance_changed', 'tnk_unknown_status', 'tnk_invalid_address', 'tnk_invalid_amount', 'tnk_interrupted'])
    assert.match(source, new RegExp(`\\b${code}: '[A-Z]`), code);
  assert.match(source, /tnk_validators: 'Waiting for the Trac network — try again in a minute\.'/);
  assert.match(source, /'TNK \(Trac network gas\)'/); assert.match(source, /'Send TNK here to fund your agent'/);
  assert.match(source, /Game moves and unit sends are free; TNK is only needed for paid Trac transactions\./);
  assert.match(source, /These are game units, not TNK/);
});
