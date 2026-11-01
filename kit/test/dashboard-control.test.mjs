import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { writeFile, readFile, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { createMcp } from '../lib/mcp.mjs';
import { runTool } from '../lib/tools.mjs';
import { publicKey } from '../lib/keyring.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { reserveDashboardControl, findDashboardControl, dashboardProfile, dashboardControlHandler, controlRequest, forwardDashboardTool } from '../lib/dashboard-control.mjs';
import { cleanup, temp, testWallet, fakeTrac, history } from './helpers.mjs';

async function fixture(t) {
  const directory = await temp(t), wallet = testWallet(), { trac, state } = fakeTrac(history());
  const scope = `${trac.network}/${publicKey(wallet)}`, profile = dashboardProfile({ network: trac.network });
  const journal = await Journal.open(directory, scope, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const service = new ServiceClient({ network: trac.network });
  const dry = { agent: new Agent({ wallet, network: trac.network, service, trac, journal, dryRun: true }) };
  const live = { agent: new Agent({ wallet, network: trac.network, service, trac, journal, dryRun: false }) };
  const lease = await reserveDashboardControl({ directory, scope, owner: publicKey(wallet), profile }); cleanup(t, () => lease.release());
  const handler = dashboardControlHandler(lease, (call, extra) => runTool(call.live ? live : dry, call.name, call.input, { readOnly: call.readOnly, ...extra }));
  const server = createServer((req, res) => handler.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, async () => { await handler.close(); await new Promise(resolve => server.close(resolve)); });
  await lease.publish(server.address().port);
  const record = await findDashboardControl({ directory, scope, profile });
  const call = (name, input = {}, options = {}) => forwardDashboardTool(record, wallet, { name, input, readOnly: false, live: false, ...options });
  return { directory, scope, profile, wallet, state, dry, live, record, call, journal, lease, server, handler };
}
const transfer = { actionId: 'forward-transfer', to: encodeTracAddress('ab'.repeat(32)), assets: [['p0', '1']] };

test('forwarded read and dry-run action match direct tools without sending', async t => {
  const f = await fixture(t);
  assert.equal((await stat(join(f.directory, 'dashboard-control.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await f.call('address', {}, { readOnly: true }), await runTool(f.dry, 'address'));
  assert.deepEqual(await f.call('balance', { asset: 'p0' }, { readOnly: true }), await runTool(f.dry, 'balance', { asset: 'p0' }));
  assert.deepEqual(await f.call('transfer', transfer), await runTool(f.dry, 'transfer', transfer));
  assert.equal(f.state.sent.length, 0); assert.equal(f.journal.recent().length, 0);
  await assert.rejects(f.call('transfer', transfer, { readOnly: true, live: true }), /Use action transfer/);
  assert.equal(f.state.sent.length, 0);
});

test('forwarded live action sends once and exact retries keep the saved journal action', async t => {
  const f = await fixture(t), result = await f.call('transfer', transfer, { live: true });
  assert.equal(result.state, 'submitted'); assert.equal(f.state.sent.length, 1);
  assert.equal(f.journal.get('tx/forward-transfer').body.tx, result.tx);
  const again = await f.call('transfer', transfer, { live: true });
  assert.equal(again.replayed, true); assert.equal(again.tx, result.tx); assert.equal(f.state.sent.length, 1);
  const preview = await f.call('transfer', transfer); assert.equal(preview.state, 'dry-run'); assert.equal(f.state.sent.length, 1);
  assert.equal(f.live.agent.dryRun, false); assert.equal(f.dry.agent.dryRun, true);
});

test('control refuses the wrong token, missing unlock proof, browser requests and replayed proofs', async t => {
  const f = await fixture(t), url = `http://127.0.0.1:${f.record.port}/control/tool`;
  const signed = controlRequest(f.record, f.wallet, { name: 'transfer', input: transfer, readOnly: false, live: true });
  const post = (headers, body = signed.body) => new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
  assert.equal((await post({ ...signed.headers, 'x-dmw-control-token': '00'.repeat(32) })).status, 401);
  assert.equal((await post({ 'content-type': 'application/json', 'x-dmw-control-token': f.record.token })).status, 401);
  assert.equal((await post(signed.headers, signed.body.replace('forward-transfer', 'changed-transfer'))).status, 401);
  // A browser's fetch metadata is refused even without its Origin or cookie.
  assert.equal((await fetch(url, { method: 'POST', ...signed })).status, 403);
  for (const extra of [{ origin: url }, { origin: 'https://example.invalid' }, { cookie: 'dmw_dashboard=fake' }]) {
    const response = await post({ ...signed.headers, ...extra }); assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(f.state.sent.length, 0);
  await assert.rejects(forwardDashboardTool(f.record, testWallet(2), { name: 'transfer', input: transfer, readOnly: false, live: true }), /Unlock your signer/);
  assert.equal((await post(signed.headers)).status, 200); assert.equal((await post(signed.headers)).status, 409); assert.equal(f.state.sent.length, 1);
});

test('dead dashboard records are ignored and replaced, live records refuse duplicates and scope changes', async t => {
  const directory = await temp(t), scope = 'local/' + publicKey(testWallet()), profile = dashboardProfile({ network: 'local' });
  const path = join(directory, 'dashboard-control.json');
  // An impossible PID is only a fixture; never signal a real owner process.
  await writeFile(path, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
  assert.equal(await findDashboardControl({ directory, scope, profile }), null);
  const lease = await reserveDashboardControl({ directory, scope, owner: publicKey(testWallet()), profile }); cleanup(t, () => lease.release());
  await assert.rejects(findDashboardControl({ directory, scope, profile }), /starting/);
  await lease.publish(12345);
  await assert.rejects(reserveDashboardControl({ directory, scope, owner: publicKey(testWallet()), profile }), /already running/);
  await assert.rejects(findDashboardControl({ directory, scope: 'other', profile }), /different signer journal/);
  await assert.rejects(findDashboardControl({ directory, scope, profile: '00'.repeat(32) }), /different settings/);
  const old = JSON.parse(await readFile(path));
  await lease.release(); await assert.rejects(readFile(path), { code: 'ENOENT' });
  const next = await reserveDashboardControl({ directory, scope, owner: publicKey(testWallet()), profile }); cleanup(t, () => next.release());
  assert.notEqual(next.record.token, old.token);
});

test('control discovery refuses a public token file and does not remove a replacement record', async t => {
  const f = await fixture(t), path = join(f.directory, 'dashboard-control.json');
  await chmod(path, 0o644);
  await assert.rejects(findDashboardControl(f), /private regular file/);
  await chmod(path, 0o600);
  const replacement = { ...f.record, token: 'ab'.repeat(32) };
  await writeFile(path, JSON.stringify(replacement));
  await assert.rejects(f.lease.publish(f.record.port), /reservation changed/);
  await f.lease.release(); assert.deepEqual(JSON.parse(await readFile(path)), replacement);
});

test('shutdown refuses a call whose body finishes after the control queue closes', async t => {
  const f = await fixture(t), signed = controlRequest(f.record, f.wallet, { name: 'transfer', input: transfer, readOnly: false, live: true });
  const receiving = once(f.server, 'request'); let req;
  const response = new Promise((resolve, reject) => {
    req = request(`http://127.0.0.1:${f.record.port}/control/tool`, { method: 'POST', headers: signed.headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject);
  });
  req.write(signed.body.slice(0, 10)); await receiving;
  await f.handler.close(); req.end(signed.body.slice(10));
  assert.equal(await response, 503); assert.equal(f.state.sent.length, 0);
});

test('MCP proxy lists identical tool definitions and preserves its launch dry-run default', async t => {
  const f = await fixture(t);
  const connect = async forwarding => {
    const server = await createMcp(forwarding ? {} : f.dry, forwarding ? { invoke: (name, input, extra) => f.call(name, input) } : undefined);
    cleanup(t, () => server.close());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'forwarding-test', version: '1' }); cleanup(t, () => client.close());
    await server.connect(serverTransport); await client.connect(clientTransport); return client;
  };
  const direct = await connect(false), proxy = await connect(true);
  assert.deepEqual(await proxy.listTools(), await direct.listTools());
  assert.deepEqual(await proxy.callTool({ name: 'address', arguments: {} }), await direct.callTool({ name: 'address', arguments: {} }));
  assert.deepEqual(await proxy.callTool({ name: 'transfer', arguments: transfer }), await direct.callTool({ name: 'transfer', arguments: transfer }));
  const invalid = await proxy.callTool({ name: 'transfer', arguments: { ...transfer, live: true } }); assert.equal(invalid.isError, true);
  assert.equal(f.state.sent.length, 0);
});
