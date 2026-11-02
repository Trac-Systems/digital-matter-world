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
import { init, unlock, publicKey, wipeWallet } from '../lib/keyring.mjs';
import { temp, cleanup, bitcoinAddress } from './helpers.mjs';

const cli = fileURLToPath(new URL('../bin/dmw.mjs', import.meta.url));
async function fixture(t) {
  const directory = await temp(t), password = 'disposable bulk link test password'; await init({ directory, password });
  const wallet = await unlock({ directory, password }), owner = publicKey(wallet); wipeWallet(wallet);
  const configFile = join(directory, 'config.json'), config = { localOnly: true, network: 'dmw-kit-test', bitcoinNetwork: 'regtest', directory,
    gateway: 'http://127.0.0.1:1', gatewayKey: '09'.repeat(32), owner: { payer: { tap: bitcoinAddress() } }, fixtureOwner: owner,
    journalPacing: { intervalMs: 0, perTip: 100 }, linkConcurrency: 2, maxBlocks: 3,
    adapter: fileURLToPath(new URL('./fixtures/bulk-link-adapter.mjs', import.meta.url)) };
  const save = () => writeFile(configFile, JSON.stringify(config)); await save();
  const env = { ...process.env, DMW_SIGNER_PASSWORD: password };
  const args = input => [cli, ...input, '--config', configFile];
  const command = input => promisify(execFile)(process.execPath, args(input), { env, timeout: 20000 });
  const records = () => readFile(join(directory, 'fixture-link-records.json'), 'utf8').then(JSON.parse);
  return { directory, env, config, configFile, save, args, command, records };
}

test('link-bitmaps CLI is dry-run by default and live foreground waits for every item', async t => {
  const f = await fixture(t);
  const dry = JSON.parse((await f.command(['link-bitmaps', '--blocks', '1,2,2'])).stdout);
  assert.equal(dry.state, 'dry-run'); assert.equal(dry.total, 2); await assert.rejects(f.records(), { code: 'ENOENT' });
  await assert.rejects(f.command(['link-bitmaps', '--blocks', '1,2,3,4']), error => /too_many_blocks/.test(error.stdout));
  const live = JSON.parse((await f.command(['link-bitmaps', '--blocks', '1,2', '--live'])).stdout);
  assert.equal(live.job.state, 'done'); assert.equal(live.job.counts.linked, 2); assert.equal(Object.keys(await f.records()).length, 2);
  const status = JSON.parse((await f.command(['read', 'link_bitmaps_status'])).stdout); assert.equal(status.jobs[0].id, live.job.id);
});

test('foreground interruption preserves a running job and a new CLI process resumes it', async t => {
  const f = await fixture(t); f.config.fixtureHold = true; await f.save();
  const child = spawn(process.execPath, f.args(['link-bitmaps', '--blocks', '1,2', '--live']), { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); cleanup(t, async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  let stdout = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.resume();
  for (let n = 0; n < 200; n++) {
    const ready = await f.records().then(r => Object.values(r).filter(i => i.state === 'reserving').length === 2, () => false);
    if (ready) break;
    assert.ok(n < 199, 'fixture link requests submitted'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  child.kill('SIGINT'); assert.deepEqual(await exited, [0, null]); const paused = JSON.parse(stdout).job; assert.equal(paused.state, 'running');
  const before = await f.records(); f.config.fixtureHold = false; await f.save();
  const resumed = JSON.parse((await f.command(['link-bitmaps', '--blocks', '2,1', '--live'])).stdout);
  assert.equal(resumed.job.id, paused.id); assert.equal(resumed.job.counts.linked, 2); assert.deepEqual(await f.records(), before);
});

test('MCP exposes both tools, preserves dry-run, starts durable live work and reads status', async t => {
  const f = await fixture(t); f.config.fixtureHold = true; await f.save();
  async function connect(live) {
    const transport = new StdioClientTransport({ command: process.execPath, args: f.args(['mcp', ...(live ? ['--live'] : [])]), env: f.env, stderr: 'pipe' });
    transport.stderr?.resume();
    const client = new Client({ name: 'bulk-link-test', version: '1' }); cleanup(t, () => client.close()); await client.connect(transport); return client;
  }
  const dry = await connect(false), listed = await dry.listTools();
  assert.ok(listed.tools.some(t => t.name === 'link_bitmaps')); assert.ok(listed.tools.some(t => t.name === 'link_bitmaps_status' && t.annotations.readOnlyHint));
  const preview = JSON.parse((await dry.callTool({ name: 'link_bitmaps', arguments: { blocks: ['1'] } })).content[0].text);
  assert.equal(preview.state, 'dry-run'); await assert.rejects(f.records(), { code: 'ENOENT' }); await dry.close();
  const live = await connect(true);
  const started = JSON.parse((await live.callTool({ name: 'link_bitmaps', arguments: { blocks: ['1', '2'] } })).content[0].text);
  assert.equal(started.job.state, 'running');
  const again = JSON.parse((await live.callTool({ name: 'link_bitmaps', arguments: { blocks: ['2', '1'] } })).content[0].text);
  assert.equal(again.job.id, started.job.id); assert.equal(again.existing, true);
  const detail = JSON.parse((await live.callTool({ name: 'link_bitmaps_status', arguments: { jobId: started.job.id, limit: 1 } })).content[0].text);
  assert.equal(detail.items[0].block, '1'); assert.equal(detail.next, 1);
});
