import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/http.mjs';
import { httpReadBudget, HTTP_READ_BUDGET } from '../src/http-read-budget.mjs';
import { Limiter } from '../src/limiter.mjs';

const request = (ip, method = 'GET') => ({ method, socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip } });

test('read budget gives normal dashboard, website and room bursts ample headroom', () => {
  const admit = httpReadBudget();
  for (let i = 0; i < 1000; i++) admit(request('192.0.2.1', i % 2 ? 'GET' : 'HEAD'));
  assert.equal(HTTP_READ_BUDGET.enabled, true);
  for (const settings of [null, [], { enabled: 1 }, { burst: 0 }, { perSecond: -1 }, { ttlMs: 0 }, { typo: 1 }])
    assert.throws(() => httpReadBudget(settings), /http_read_budget_setting/);
});

test('read budget isolates proxy IPs, counts HEAD and ignores caller supplied first hops', () => {
  const admit = httpReadBudget({ burst: 1, perSecond: 1 });
  admit(request('198.51.100.1, 192.0.2.1'));
  assert.throws(() => admit(request('198.51.100.2, 192.0.2.1', 'HEAD')), e => e.status === 429 && e.retryAfterMs > 0);
  admit(request('192.0.2.2'));
  admit(request('192.0.2.1', 'POST'));
  const disabled = httpReadBudget({ enabled: false, burst: 1 });
  for (let i = 0; i < 100; i++) disabled(request('192.0.2.1'));
});

test('read limiter replenishes and gives a useful delay when IP slots are full', () => {
  const limiter = new Limiter({ capacity: 1, burst: 1, perSecond: 2, ttl: 10000 });
  assert.equal(limiter.take('a', 0), true);
  assert.equal(limiter.take('a', 100), false);
  assert.equal(limiter.retryAfterMs('a', 100), 400);
  assert.equal(limiter.take('a', 500), true);
  assert.equal(limiter.take('b', 500), false);
  assert.equal(limiter.retryAfterMs('b', 500), 10000);
  assert.equal(limiter.take('b', 10500), true);
});

test('HTTP returns 429 and Retry-After before any read handler, including static assets', async t => {
  let calls = 0;
  const server = await serve({ readBudget: { burst: 1, perSecond: 1 },
    web: { handle: async (_req, res) => { calls++; res.end('ok'); return true; } } });
  t.after(() => server.close());
  const get = (ip, method = 'GET') => fetch(server.url + '/anything', { method, headers: { 'x-forwarded-for': ip } });
  assert.equal((await get('192.0.2.1')).status, 200);
  const refused = await get('192.0.2.1');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '1');
  assert.deepEqual(await refused.json(), { error: 'read_request_rate', retryable: true });
  assert.equal((await get('192.0.2.1', 'HEAD')).status, 429);
  assert.equal((await get('192.0.2.2')).status, 200);
  assert.equal(calls, 2);
});
