import { encodeTracAddress } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadAPI } from '../api.mjs';
import { serveControl } from '../http.mjs';
import { Engine } from '../engine.mjs';
import { paymentPlan } from '../wallets.mjs';
import { installLocalFetch } from '../../service/src/http-client.mjs';

const ownerKey = 'a'.repeat(64), owner = encodeTracAddress(ownerKey), url = path => new URL(path, 'http://127.0.0.1');
test('the dashboard forwards requester access only for a specific mint status or payment plan', async () => {
  const calls = [], context = { requesterSecret: 'd'.repeat(64) };
  const engine = { state: { player: { address: ownerKey } }, get: async (path, options) => { calls.push({ path, options }); return {}; } };
  const api = createReadAPI({ engine, views: {} });
  for (const path of ['/mint/', '/web-api/mint/']) {
    await api(url('/api/gateway' + path + ownerKey), context);
    assert.equal(calls.at(-1).options, context);
  }
  await api(url('/api/results/mints'), context); assert.equal(calls.at(-1).options, undefined);
});
test('public playground routes forward the gateway shape and cursors without local joins', async () => {
  const calls = [], value = { finds: [{ id: 1 }], total: 9, next: 'gateway-cursor', limit: 1, sort: 'block', order: 'desc', route: '/finds' };
  const engine = { state: { player: { address: ownerKey } }, get: async path => { calls.push(path); return value; }, trac() { throw Error('private join'); } };
  const views = new Proxy({}, { get: () => () => { throw Error('private join'); } });
  const api = createReadAPI({ engine, views });
  for (const path of ['status', 'world', 'blocks', 'patterns', 'table', 'compounds', 'finds', 'receipts', 'agents', 'feed', 'feed/1',
    'results', ...['mints', 'ethereum', 'payments', 'payouts', 'owed', 'paid', 'links'].map(k => 'results/' + k),
    'agents/' + owner, 'agents/' + owner + '/history']) {
    const query = '?limit=1&cursor=opaque'; assert.deepEqual(await api(url('/api/' + path + query)), value);
    assert.equal(calls.at(-1), '/' + path + query);
  }
  for (const key of ['balances', 'mintRights', 'bitmaps', 'finds']) {
    assert.deepEqual(await api(url('/api/player/' + key + '?limit=2')), value); assert.equal(calls.at(-1), '/agents/' + owner + '/' + key + '?limit=2');
  }
  for (const suffix of ['', '/finds', '/claims', '/draws', '/matches', '/slotList', '/mintRights']) {
    assert.deepEqual(await api(url('/api/blocks/1' + suffix + '?limit=1')), value);
    assert.equal(calls.at(-1), '/blocks/1' + suffix + '?limit=1&owner=' + owner);
  }
  await api(url('/api/gateway/results/mints?limit=1&kind=tap')); assert.equal(calls.at(-1), '/results/mints?limit=1&kind=tap');
  const nested = '/list?' + new URLSearchParams({ source: '/blocks/1?owner=' + owner, path: '/claims/0/patterns', cursor: 'opaque' });
  await api(url('/api' + nested)); assert.equal(calls.at(-1), nested);
  await assert.rejects(api(url('/api/lab/world')), /not_found/);
});

test('player combines public profile pages with explicitly labeled own local data only', async () => {
  const profile = { address: owner, balances: [{ asset: 'p0', amount: '1' }], mintRights: [], pages: { balances: { total: 1, route: '/agents/' + owner + '/balances' } }, counts: { balances: 1 } };
  const engine = { state: { player: { address: ownerKey } }, get: async () => profile };
  const views = { localPlayer: async () => ({ address: owner, discoveries: [{ name: 'own-sealed-proposal' }], wallets: { bitcoin: { btc: 1 } },
    localData: { label: "your agent's local data", fields: { discoveries: true, wallets: true } } }) };
  const api = createReadAPI({ engine, views }), result = await api(url('/api/player?limit=1'));
  assert.deepEqual(result.balances, profile.balances); assert.deepEqual(result.pages.balances, profile.pages.balances);
  assert.equal(result.discoveries[0].name, 'own-sealed-proposal'); assert.equal(result.localData.label, "your agent's local data");
});

test('local payment signing plans are restricted to the current player', async () => {
  await assert.rejects(paymentPlan({ store: { get: () => ({ request: { owner: 'b'.repeat(64) } }) }, state: { player: { address: ownerKey } } }, '1'.repeat(64)), /payment_plan_owner/);
});

test('Lab diagnostic arrays continue through local pages without entering the public feed', async () => {
  const events = [{ sequence: 1, type: 'job', data: { rows: [1, 2, 3] } }];
  const engine = { state: { player: { address: ownerKey } }, get: () => { throw Error('public feed used for a private diagnostic'); } };
  const api = createReadAPI({ engine, events });
  const page = await api(url('/api/lab/feed?limit=1')), meta = page.events[0].data.pages.rows;
  assert.match(meta.route, /source=%2Fapi%2Flab%2Ffeed/);
  const next = url(meta.route); next.searchParams.set('cursor', meta.next); next.searchParams.set('limit', '1');
  assert.deepEqual((await api(next)).items, [2]);
  await assert.rejects(api(url('/api/list?' + new URLSearchParams({ source: '/api/lab/world', path: '/plots' }))), /not_found/);
});

test('gateway query proxy remains loopback-only and works under the service fetch guard', async t => {
  const server = createServer((req, res) => { assert.equal(req.url, '/finds?limit=1'); res.end(JSON.stringify({ finds: [], total: 0 })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  installLocalFetch();
  const engine = new Engine({}); engine.url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await engine.get('/finds?limit=1'), { finds: [], total: 0 });
  await assert.rejects(engine.get('//remote.invalid'), /gateway_read_path/);
  engine.url = 'http://example.invalid'; await assert.rejects(engine.get('/finds?limit=1'), /endpoint_must_be_loopback/);
});

test('production SSE emits only public gateway events, preserving their provenance and bounded pages', async t => {
  const events = [{ sequence: 1, type: 'job', data: { private: 'local-only' } }], seen = [];
  const publicEvent = { sequence: 2, type: 'find', data: { asset: 'p0' }, provenance: { audit: '/blocks/1.bin' } };
  const control = await serveControl({ token: 'public-test', events, route: () => ({}), port: 0, publicEvents: async query => { seen.push(query); return { events: query.since < 2 ? [publicEvent] : [], total: 1 }; } });
  t.after(() => control.close());
  const controller = new AbortController(), response = await fetch(`http://127.0.0.1:${control.server.address().port}/api/events`, {
    headers: { authorization: 'Bearer public-test', 'last-event-id': '0' }, signal: controller.signal });
  const reader = response.body.getReader(); let text = '';
  while (!text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /id: 2/); assert.doesNotMatch(text, /local-only/);
  assert.deepEqual(JSON.parse(text.match(/^data: (.*)$/m)[1]), publicEvent); assert.equal(seen[0].limit, 200);
  controller.abort(); await reader.cancel().catch(() => {});
});
