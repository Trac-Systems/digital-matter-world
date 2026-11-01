import test from 'node:test';
import assert from 'node:assert/strict';
import { serveDashboard } from '../lib/dashboard.mjs';
import { DashboardState } from '../lib/dashboard-state.mjs';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { cleanup } from './helpers.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { hashObject } from '../../rules/src/core.js';

async function start(t, f) {
  const d = await serveDashboard(f.context); cleanup(t, () => d.close());
  const login = await fetch(d.origin + '/login', { method: 'POST', headers: { origin: d.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: new URL(d.loginLink).hash.slice(1) }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { d, call: (path, body, origin = d.origin) => fetch(d.origin + path, { headers: { cookie, origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }) };
}
test('dashboard lists verified fee credits and applies or transfers them through signed existing tools', async t => {
  const f = await dashboardFixture(t), id = 'ab'.repeat(32), fee = 'cd'.repeat(32), packets = [];
  const source = { owner: f.agent.owner, revision: '0', fees: [{ key: fee, amount: '10' }] };
  let target;
  f.service.results = async options => { assert.equal(options.owner, f.agent.address); return { credits: [{ id, amount: '999', origin: { requestId: id, orderId: null } }], next: null }; };
  f.agent.trac.financialRecord = async key => key === 'fc/' + id ? source : key === 'fp/' + target ? { owner: f.agent.owner, state: 'open', fees: [{ key: fee, amount: '10' }], paid: ['2'] } : null;
  f.service.financialAction = async action => { packets.push(action); return { id: hashObject(['dmw-financial-transition-v2', { type: 'lifecycle', id: action.id, action }]), state: 'queued' }; };
  const { d, call } = await start(t, f);
  assert.equal((await fetch(d.origin + '/api/credits')).status, 401);
  const minted = await (await call('/api/mint', { asset: 'p2:1', block: '12' })).json(); target = minted.requestId;
  assert.equal(minted.status.feeCredits.href, '/api/credits?request=' + target);
  const page = await (await call('/api/credits?request=' + target)).json();
  assert.equal(page.credits[0].amount, '10'); assert.equal(page.credits[0].matchingAmount, '8');
  assert.equal(page.credits[0].origin.requestId, id);
  assert.equal((await call('/api/credits?owner=someone')).status, 400);
  assert.equal((await call('/api/credits/use', { actionId: 'credit-use', credit: id, request: target }, 'https://evil.invalid')).status, 403);
  assert.equal((await call('/api/credits/use', { actionId: 'credit-use', credit: id, request: target, amount: '999' })).status, 400);
  assert.equal((await call('/api/credits/use', { actionId: 'credit-use', credit: id, request: target })).status, 200);
  assert.equal(packets[0].type, 'credit-use'); assert.deepEqual(packets[0].operation.items, [{ fee, amount: '8' }]);
  await call('/api/credits/use', { actionId: 'credit-use', credit: id, request: target }); assert.equal(packets.length, 1);
  const response = await call('/api/credits/transfer', { actionId: 'credit-transfer', credit: id, to: encodeTracAddress('ef'.repeat(32)) });
  assert.equal(response.status, 200); assert.equal(packets[1].type, 'credit-transfer');
});

test('confirmed terminal expiry frees a dashboard slot while uncertain or merely old requests stay saved', async t => {
  const f = await dashboardFixture(t), state = new DashboardState(f.context);
  await state.mint({ asset: 'p2:1', block: '12' });
  const row = state.savedMints()[0];
  assert.equal(state.retireDead(row, { state: 'awaiting_payment', funding: { state: 'open' } }, undefined, '999999'), false);
  assert.equal(state.retireDead(row, { state: 'expired', reason: 'credited', funding: { state: 'open' } }), false);
  assert.equal(state.retireDead(row, { state: 'expired', reason: 'credited', reservation: 'refunded', funding: { state: 'credited' } }), true);
  assert.deepEqual(f.journal.get(row.id).body, row.body, 'the signed packet remains in the journal');
  assert.equal(state.savedSlot({ asset: 'p2:1', block: '12' }), undefined);
});
