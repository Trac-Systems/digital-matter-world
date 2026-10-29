import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { serveDashboard } from '../lib/dashboard.mjs';

test('the authenticated dashboard forwards requester access on mint reads and reports without forwarding its login', async t => {
  const secret = 'd'.repeat(64), id = 'a'.repeat(64);
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) {}
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ requester: req.headers['x-mint-requester-secret'] === secret, cookie: !!req.headers.cookie, authorization: !!req.headers.authorization }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const state = { agent: { paymentOrigin: 'http://127.0.0.1:' + upstream.address().port }, activate() {}, async close() {} };
  const dashboard = await serveDashboard({}, { state }); t.after(() => dashboard.close());
  const login = await fetch(dashboard.origin + '/login', { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: new URL(dashboard.loginLink).hash.slice(1) }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const read = async (path, post = false, credential = secret) => {
    const result = await fetch(dashboard.origin + path, { headers: { cookie, origin: dashboard.origin, 'content-type': 'application/json', 'x-mint-requester-secret': credential },
      ...(post ? { method: 'POST', body: JSON.stringify({ id }) } : {}) });
    assert.equal(result.status, 200); return result.json();
  };
  for (const path of ['/mint/' + id, '/web-api/mint/' + id]) assert.deepEqual(await read(path), { requester: true, cookie: false, authorization: false });
  assert.deepEqual(await read('/mint/payment', true), { requester: true, cookie: false, authorization: false });
  assert.deepEqual(await read('/status'), { requester: false, cookie: false, authorization: false });
  assert.equal((await read('/mint/' + id, false, 'invalid')).requester, false);
});
