import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { KeyedWork } from '../src/keyed-work.mjs';
import { FinancialMints } from '../src/financial-mints.mjs';
import { Mints } from '../src/mints.mjs';
import { serve } from '../src/http.mjs';
import { HttpSource } from '../prod/http.mjs';

test('a 2 s provisioning lookup does not hold quotes or state reads, including the same asset', async t => {
  const f = await provisioningFixture(t), lookup = f.reads.elementByDefinition;
  let started; const entered = new Promise(resolve => { started = resolve; });
  f.reads.elementByDefinition = async (...args) => { started(); await delay(2000); return lookup(...args); };
  await f.store.put('meta', 'patterns', [f.pattern, { ...f.pattern, number: 3, name: 'second' }]);
  const tick = f.operator.tick(); await entered;
  const mints = new Mints({ store: f.store, reads: f.reads, network: f.network }); mints.provisioner = f.operator;
  const at = performance.now();
  const [quote, state] = await Promise.all([mints.quote({ asset: 'p2', block: 1 }), f.operator.state('p2')]);
  const elapsed = performance.now() - at;
  assert.ok(elapsed < 250, `quote/state took ${elapsed} ms`);
  assert.equal(quote.deployment.state, 'queued'); assert.equal(state.state, 'queued');
  await tick;
  assert.equal((await f.operator.state('p2')).phase, 'element');
  assert.equal((await f.operator.state('p3')).phase, 'element');
  t.diagnostic(`2 s source: quote plus state ${elapsed.toFixed(1)} ms`);
});

test('independent mint jobs run concurrently; a duplicate mutation fails immediately', async () => {
  const work = new KeyedWork(); let release;
  const blocked = work.run('one', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  assert.equal(await work.run('two', async () => 'ready'), 'ready');
  await assert.rejects(work.run('one', () => assert.fail('duplicate ran')), { message: 'resource_busy', status: 503 });
  release(); await blocked; assert.equal(work.pending.size, 0);
});

test('financial verification is queued by a quote and performed only by its background lane', async t => {
  const f = await provisioningFixture(t); let calls = 0; const submitted = [];
  const mints = new FinancialMints({ store: f.store, network: f.network, document: { values: {} },
    reads: { batchStamp: async () => ({}), financialDeploymentState: async () => ({ id: 'id' }),
      financialDeployment: async () => { calls++; return { id: 'id', action: { type: 'deployment-open' } }; } },
    financial: { submit: async value => submitted.push(value) } });
  const quote = await mints.quote({ asset: 'c2:' + 'aa'.repeat(32), amount: '1' });
  assert.equal(quote.state, 'deployment_pending'); assert.equal(calls, 0);
  await mints.deploymentTick(); assert.equal(calls, 1); assert.equal(submitted.length, 1);
  await mints.deploymentTick(); assert.equal(calls, 1, 'pacing prevents repeated pristine checks');
});

test('HTTP returns retryable errors on time and retains capacity until pending work drains', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const http = await serve({ intake: {}, files: { serve: async () => false }, responseTimeoutMs: 50, maxInFlight: 1,
    mints: { quote: async () => { await pending; return { state: 'ready' }; } } });
  t.after(async () => { release(); await http.close(); });
  const at = performance.now(), response = await fetch(http.url + '/mint/quote', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '1');
  assert.equal((await response.json()).error, 'request_pending');
  assert.ok(performance.now() - at < 500);
  const busy = await fetch(http.url + '/health');
  assert.equal(busy.status, 503, 'timed-out work still consumes capacity');
  assert.deepEqual(await busy.json(), { error: 'service_busy', retryable: true });
  release(); await delay(20);
  assert.equal((await fetch(http.url + '/missing')).status, 404, 'late reply cannot corrupt the next response');
});

test('source saturation and dependency timeouts are clear retryable HTTP failures', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const source = new HttpSource({ url: 'http://127.0.0.1', maxQueue: 1, retries: 0, timeoutMs: 100,
    fetchImpl: async (_, { signal }) => { entered(); await delay(5000, undefined, { signal }); } });
  const pending = assert.rejects(source.request(), /http_timeout/); await started;
  const http = await serve({ intake: {}, files: { serve: async () => false }, mints: { quote: () => source.request() } });
  t.after(() => http.close());
  const quote = () => fetch(http.url + '/mint/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const busy = await quote();
  assert.equal(busy.status, 503); assert.equal(busy.headers.get('retry-after'), '1');
  assert.deepEqual(await busy.json(), { error: 'http_capacity', retryable: true });
  await pending;
  const timeout = await quote();
  assert.equal(timeout.status, 503); assert.equal(timeout.headers.get('retry-after'), '1');
  assert.deepEqual(await timeout.json(), { error: 'http_timeout', retryable: true });
});
