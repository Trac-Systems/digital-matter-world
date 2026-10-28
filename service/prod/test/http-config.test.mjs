import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as turn } from 'node:timers/promises';
import { HttpSource, jsonRpc } from '../http.mjs';
import { productionURL, readSecret, validateConfig, loadConfig } from '../config.mjs';
import { mockServer, configFixture, json, body } from './helpers.mjs';

test('HTTP retries 5xx and preserves query credentials on nested paths', async t => {
  let calls = 0;
  const url = await mockServer(t, (req, res) => { assert.equal(req.url, '/api/wallet/test?credential=fixture'); if (++calls < 3) { res.writeHead(503); res.end('private provider message'); } else json(res, { ok: true }); });
  const source = new HttpSource({ url: url + '/api?credential=fixture', requestsPerSecond: 50, backoffMs: 1 });
  assert.deepEqual(await source.request('/wallet/test'), { ok: true }); assert.equal(calls, 3);
});
test('HTTP retry dispatches respect pacing independently of connection latency', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  const dispatches = [], source = new HttpSource({ url: 'https://provider.invalid', requestsPerSecond: 50, backoffMs: 1,
    fetchImpl: async () => { dispatches.push(Date.now()); return new Response(JSON.stringify({ ok: true }), { status: dispatches.length < 3 ? 503 : 200 }); } });
  const response = source.request(); await turn();
  assert.deepEqual(dispatches, [1000]);
  for (const count of [1, 2]) {
    t.mock.timers.tick(19); await turn(); assert.equal(dispatches.length, count);
    t.mock.timers.tick(1); await turn(); assert.equal(dispatches.length, count + 1);
  }
  assert.deepEqual(await response, { ok: true }); assert.deepEqual(dispatches, [1000, 1020, 1040]);
});
test('HTTP body cap handles chunked streams and errors never expose a provider body', async t => {
  const url = await mockServer(t, (_, res) => { res.write('0123456789'); res.end('0123456789'); });
  await assert.rejects(new HttpSource({ url, maxBytes: 12 }).request(), /http_response_limit/);
});
test('HTTP deadlines include a stalled response body', async t => {
  const url = await mockServer(t, (_, res) => { res.writeHead(200); res.write('{'); });
  await assert.rejects(new HttpSource({ url, timeoutMs: 30, retries: 0 }).request(), /http_timeout/);
});
test('HTTP denies redirects, malformed JSON and unbounded queueing', async t => {
  const url = await mockServer(t, (req, res) => { if (req.url === '/bad') res.end('secret=fixture'); else { res.writeHead(302, { location: '/bad' }); res.end(); } });
  const source = new HttpSource({ url, retries: 0, maxQueue: 1 });
  const first = source.request(); assert.throws(() => source.request('/different'), /http_capacity/); await assert.rejects(first, /http_unavailable/);
  await assert.rejects(new HttpSource({ url, retries: 0 }).request('/bad'), e => e.message === 'http_unavailable' && !JSON.stringify(e).includes('fixture'));
});
test('JSON-RPC checks response identity and strips remote error text', async t => {
  let mismatch = false;
  const url = await mockServer(t, async (req, res) => { const r = await body(req); json(res, mismatch ? { id: 999, result: 1 } : { id: r.id, error: { code: -5, message: 'sensitive-fixture' } }); });
  const rpc = jsonRpc(new HttpSource({ url }));
  await assert.rejects(rpc('getblock'), e => e.rpcCode === -5 && e.message === 'rpc_error'); mismatch = true; await assert.rejects(rpc('getblock'), /rpc_identity/);
});
test('write RPC calls are not automatically retried after ambiguous HTTP errors', async t => {
  let count = 0; const url = await mockServer(t, (_, res) => { count++; res.writeHead(503); res.end(); });
  await assert.rejects(jsonRpc(new HttpSource({ url }))('sendrawtransaction', ['fixture']), /http_status/); assert.equal(count, 1);
});
test('production endpoints allow explicit same-host origins and reject remote cleartext or ambiguous loopback', () => {
  for (const value of ['http://provider.invalid', 'https://localhost', 'https://127.0.0.1', 'https://127.1', 'https://2130706433', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://provider.invalid/regtest', 'https://user:pass@provider.invalid']) assert.throws(() => productionURL(value));
  assert.equal(productionURL('https://provider.invalid/api'), 'https://provider.invalid/api');
  assert.equal(productionURL('http://127.0.0.1:58804'), 'http://127.0.0.1:58804');
  for (const value of ['http://localhost:58804', 'http://127.1:58804', 'http://2130706433:58804', 'http://127.0.0.1:80', 'http://127.0.0.1:58804/x', 'http://127.0.0.1:58804?key=x', 'http://192.168.1.1:58804', 'http://user:pass@127.0.0.1:58804']) assert.throws(() => productionURL(value));
});
test('private secrets require existing owned 0600 nonsymlink files outside checkout', async t => {
  const { file, root } = await configFixture(t), secret = await file('secret', 'fixture');
  assert.equal(await readSecret(secret), 'fixture'); await chmod(secret, 0o644); await assert.rejects(readSecret(secret), /private_permissions/); await chmod(secret, 0o600);
  const alias = join(root, 'alias'); await symlink(secret, alias); await assert.rejects(readSecret(alias), /private_permissions/);
  await assert.rejects(readSecret(join(root, 'missing')), /private_file_unavailable/);
  await assert.rejects(readSecret(new URL('../config.mjs', import.meta.url).pathname), /private_path/);
});
test('config accepts explicit production files and rejects missing/duplicate/insufficient sources', async t => {
  const { config, file } = await configFixture(t); await validateConfig(config);
  await assert.rejects(validateConfig(config, { committee: true }), /evidence_required_for_operator/);
  const operator=structuredClone(config);operator.epoch=1;
  operator.prod.evidence={network:config.network,epoch:1,member:config.committee[0].id,directory:config.data,endpoint:{urlFile:await file('evidence-url','https://gateway.invalid')}};
  await validateConfig(operator,{committee:true});
  const path = await file('config', config); assert.equal((await loadConfig(path)).mode, 'prod');
  let copy = structuredClone(config); copy.mode = 'regtest'; await assert.rejects(validateConfig(copy), /config_network/);
  copy = structuredClone(config); copy.prod.tap.agreement = 2; await assert.rejects(validateConfig(copy, { committee: true }), /tap_agreement/);
  copy = structuredClone(config); copy.prod.tap.endpoints[1] = copy.prod.tap.endpoints[0]; await assert.rejects(validateConfig(copy), /tap_sources/);
  const single = structuredClone(operator); single.prod.tap.endpoints.length = 1; single.prod.tap.agreement = 1;
  await validateConfig(single, { committee: true });
  single.prod.tap.agreement = 0; await assert.rejects(validateConfig(single, { committee: true }), /tap_agreement/);
  single.prod.tap.agreement = 1; single.committee[1].peer.identity = single.committee[0].peer.identity;
  await assert.rejects(validateConfig(single, { committee: true }), /committee_config/);
  copy = structuredClone(config); copy.prod.ethereum.chainId = '31337'; await assert.rejects(validateConfig(copy), /ethereum_chain/);
  copy = structuredClone(config); copy.prod.bitcoin.urlFile += '-missing'; await assert.rejects(validateConfig(copy), /tap_source_file_required/);
});

test('production startup requires the global feePolicy before contacting providers', async t => {
  const { config, file } = await configFixture(t);
  config.prod.registry = await file('missing-fee-policy', { assets: {} });
  await assert.rejects(validateConfig(config), /feePolicy is required in the operator registry/);
});

test('production public source and bitmap cache limits are configurable and validated', async t => {
  const { config } = await configFixture(t);
  config.prod.http = { requestsPerSecond: 2, publicRequestsPerSecond: 0.5, publicMaxQueue: 4 };
  config.prod.bitmapCache = { maxEntries: 8, maxRows: 500, maxInscriptions: 1000, maxConcurrentLoads: 1, ttlMs: 30000, tipMaxAgeMs: 1000 };
  await validateConfig(config);
  for (const [key, value] of [['publicRequestsPerSecond', 0], ['publicMaxQueue', 0], ['publicMaxQueue', 1.5]]) {
    const copy = structuredClone(config); copy.prod.http[key] = value;
    await assert.rejects(validateConfig(copy), /http_public_policy/);
  }
  for (const [key, value] of [['maxEntries', 0], ['maxRows', 1000001], ['maxInscriptions', -1], ['maxConcurrentLoads', 17], ['ttlMs', 0], ['tipMaxAgeMs', 60001], ['unknown', 1]]) {
    const copy = structuredClone(config); copy.prod.bitmapCache[key] = value;
    await assert.rejects(validateConfig(copy), /bitmap_cache_policy/);
  }
});
