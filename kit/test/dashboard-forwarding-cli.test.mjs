import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { init, publicKey } from '../lib/keyring.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { temp, cleanup, testWallet } from './helpers.mjs';

const cli = fileURLToPath(new URL('../bin/dmw.mjs', import.meta.url)), run = promisify(execFile);
async function fixture(t) {
  const directory = await temp(t), password = 'disposable forwarding test password';
  await init({ directory, password });
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ localOnly: true, network: 'dmw-kit-test', bitcoinNetwork: 'regtest', directory,
    gateway: 'http://127.0.0.1:1', gatewayKey: publicKey(testWallet(9)), powLimitBits: 0x207fffff, puzzleBits: 0,
    adapter: fileURLToPath(new URL('./fixtures/forwarding-adapter.mjs', import.meta.url)) }));
  const env = { ...process.env, DMW_SIGNER_PASSWORD: password };
  const command = (args, overrides = {}) => run(process.execPath, [cli, ...args, '--config', config], { env: { ...env, ...overrides }, timeout: 15000 });
  const json = async (name, value) => { const file = join(directory, name + '.json'); await writeFile(file, JSON.stringify(value)); return file; };
  const events = async () => (await readFile(join(directory, 'fixture-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const start = async () => {
    const child = spawn(process.execPath, [cli, 'dashboard', '--config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit'); cleanup(t, async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
    let stdout = '', stderr = '';
    const link = new Promise((resolve, reject) => {
      child.once('error', reject); child.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) resolve(stdout.split('\n')[0]); });
      child.once('exit', () => reject(Error('Fixture dashboard exited before login: ' + stderr)));
    });
    child.stderr.on('data', data => { stderr += data; });
    const url = new URL(await link);
    return { pid: child.pid, url, logs: () => stdout + stderr, stop: async () => { child.kill('SIGINT'); assert.deepEqual(await exited, [0, null]); } };
  };
  return { directory, password, config, command, json, events, start, env };
}

test('CLI read, action, deploy-ticker, once and status share the running dashboard without reopening its adapter', async t => {
  const f = await fixture(t);
  const args = { actionId: 'forwarded', to: encodeTracAddress('ab'.repeat(32)), assets: [['p0', '1']] };
  const input = await f.json('transfer', args);
  const directRead = JSON.parse((await f.command(['read', 'address'])).stdout);
  const directDry = JSON.parse((await f.command(['action', 'transfer', input])).stdout);
  const directTicker = JSON.parse((await f.command(['deploy-ticker', 'p2:1', 'Chosen ticker'])).stdout);
  const directOnce = JSON.parse((await f.command(['once'])).stdout);
  const before = (await f.events()).length, dashboard = await f.start();
  const forwarded = async args => {
    const output = await f.command(args); assert.match(output.stderr, /command ran inside it/);
    assert.equal(output.stdout.trim().split('\n').length, 1); return JSON.parse(output.stdout);
  };
  assert.deepEqual(await forwarded(['read', 'address']), directRead);
  assert.deepEqual(await forwarded(['action', 'transfer', input]), directDry);
  assert.deepEqual(await forwarded(['deploy-ticker', 'p2:1', 'Chosen ticker']), directTicker);
  assert.deepEqual(await forwarded(['once']), directOnce);
  assert.equal((await forwarded(['status'])).dryRun, true);
  assert.equal((await forwarded(['status', '--live'])).dryRun, false);
  await assert.rejects(f.command(['read', 'transfer', input, '--live']), error => /Use action transfer/.test(error.stdout));
  await assert.rejects(f.command(['action', 'transfer', input], { DMW_SIGNER_PASSWORD: 'incorrect test password' }));
  assert.equal((await f.events()).slice(before).filter(e => e.type === 'send').length, 0);
  assert.equal((await forwarded(['action', 'transfer', input, '--live'])).state, 'submitted');
  assert.equal((await forwarded(['action', 'transfer', input, '--live'])).replayed, true);
  const deploy = await forwarded(['deploy-ticker', 'p2:1', 'Chosen ticker', '--live']);
  assert.equal(deploy.pid, dashboard.pid); assert.equal(deploy.ticker, 'Chosen ticker');
  assert.equal((await forwarded(['once', '--live'])).header.state, 'received');
  await assert.rejects(f.command(['dashboard']), error => /already running/.test(error.stdout));
  const current = (await f.events()).slice(before);
  assert.equal(current.filter(e => e.type === 'open').length, 1);
  assert.equal(current.filter(e => e.type === 'send').length, 1);
  assert.ok(current.every(e => e.pid === dashboard.pid));
  const control = JSON.parse(await readFile(join(f.directory, 'dashboard-control.json')));
  assert.equal(dashboard.logs().includes(control.token), false); assert.equal(dashboard.logs().includes(f.password), false);
  await dashboard.stop();
  await assert.rejects(readFile(join(f.directory, 'dashboard-control.json')), { code: 'ENOENT' });
  const stopped = await f.command(['read', 'address']); assert.doesNotMatch(stopped.stderr, /ran inside it/);
  assert.deepEqual(JSON.parse(stopped.stdout), directRead);
});

test('stdio MCP proxies inside the dashboard, retains dry-run, supports explicit live launch, and never opens an adapter', async t => {
  const f = await fixture(t), dashboard = await f.start();
  const connect = async live => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--config', f.config, ...(live ? ['--live'] : [])], env: f.env, stderr: 'pipe' });
    let stderr = ''; transport.stderr.on('data', b => { stderr += b; });
    const client = new Client({ name: 'dashboard-proxy-test', version: '1' }); cleanup(t, () => client.close());
    await client.connect(transport); return { client, transport, stderr: () => stderr };
  };
  const dry = await connect(false), live = await connect(true);
  assert.deepEqual(await dry.client.listTools(), await live.client.listTools());
  const args = { id: '01'.repeat(32), paymentIds: [] };
  const preview = await dry.client.callTool({ name: 'report_ticker_payment', arguments: args });
  assert.equal(JSON.parse(preview.content[0].text).state, 'dry-run');
  const sent = await live.client.callTool({ name: 'report_ticker_payment', arguments: args });
  assert.equal(JSON.parse(sent.content[0].text).pid, dashboard.pid);
  const attempted = await dry.client.callTool({ name: 'report_ticker_payment', arguments: { ...args, live: true } });
  assert.equal(attempted.isError, true);
  const events = await f.events(); assert.equal(events.filter(e => e.type === 'open').length, 1);
  assert.equal(events.filter(e => e.type === 'ticker-payment').length, 1);
  assert.ok(events.every(e => e.pid === dashboard.pid));
  assert.match(dry.stderr(), /tool calls will run inside it/); assert.equal(dry.stderr().includes(f.password), false);
  await dry.client.close(); await live.client.close(); await dashboard.stop();
});

test('a stale control file falls back to direct CLI and a live but unreachable control never retries directly', async t => {
  const f = await fixture(t), path = join(f.directory, 'dashboard-control.json');
  await writeFile(path, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
  await f.command(['read', 'address']); assert.equal((await f.events()).length, 1);
  const dashboard = await f.start(), control = JSON.parse(await readFile(path)); await dashboard.stop();
  // This test process owns the record; the old server is closed.
  await writeFile(path, JSON.stringify({ ...control, pid: process.pid }), { mode: 0o600 });
  await assert.rejects(f.command(['read', 'address']), error => /connection was interrupted/.test(error.stdout));
  assert.equal((await f.events()).filter(e => e.type === 'open').length, 2);
});
