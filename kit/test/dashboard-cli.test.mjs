import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../lib/keyring.mjs';
import { temp, cleanup } from './helpers.mjs';

const cli = fileURLToPath(new URL('../bin/dmw.mjs', import.meta.url));
test('dashboard CLI unlocks once, prints one private link, binds requested loopback port and exits on SIGINT', async t => {
  const directory = await temp(t), password = 'disposable dashboard test password';
  await init({ directory, password });
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ localOnly: true, network: 'dmw-kit-test', bitcoinNetwork: 'regtest', directory,
    gateway: 'http://127.0.0.1:5570', gatewayKey: '09'.repeat(32),
    adapter: fileURLToPath(new URL('./fixtures/mcp-adapter.mjs', import.meta.url)) }));
  const child = spawn(process.execPath, [cli, 'dashboard', '--config', config, '--port', '0'], { env: { ...process.env, DMW_SIGNER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); cleanup(t, async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  let stdout = '', stderr = '';
  const link = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) resolve(stdout.trim()); });
    child.once('exit', () => reject(Error('Dashboard exited before login')));
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const url = new URL(await link);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/login'); assert.equal(url.hash.length, 44);
  assert.equal((await fetch(url.origin + '/api/info')).status, 401);
  child.kill('SIGINT'); assert.deepEqual(await exited, [0, null]);
  assert.equal(stdout.trim().split('\n').length, 1); assert.equal((stdout + stderr).includes(password), false);
  assert.equal(stderr.includes(url.hash.slice(1)), false);
  await assert.rejects(fetch(url.origin));
});

test('dashboard CLI refuses invalid ports and relative config before unlocking', async () => {
  for (const args of [['--port', '65536', '--config', '/not-used.json'], ['--port', '1.5', '--config', '/not-used.json'], ['--config', 'relative.json']]) {
    await assert.rejects(promisify(execFile)(process.execPath, [cli, 'dashboard', ...args], { env: { ...process.env, DMW_SIGNER_PASSWORD: '' }, timeout: 5000 }),
      error => error.code === 1 && /Invalid dashboard port|absolute local --config/.test(error.stdout));
  }
});
