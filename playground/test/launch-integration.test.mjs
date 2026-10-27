import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { playgroundTargetInput } from '../../deploy/playground-target.mjs';
import { validateTarget } from '../../deploy/target.mjs';
import { forwardDeployment } from '../deployment-proxy.mjs';
import { playgroundRuntime } from '../bootstrap.mjs';
import { readTapSourceURL } from '../../service/src/source-url.mjs';

test('fresh template creates a private loopback ord source before starting readers', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dmw-local-source-')));
  t.after(() => rm(directory, { recursive: true }));
  const target = JSON.parse(await readFile(new URL('../../deploy/targets/regtest.json', import.meta.url)));
  assert.equal(target.indexer.endpoint.urlFile, '');
  const manifest = { root: directory, ord: { url: 'http://127.0.0.1:55888' }, ethereum: { rpc: 'http://127.0.0.1:58545' } };
  const config = await playgroundRuntime(target, { directory, manifest, ports: target.local.playground.ports });
  assert.equal(await readTapSourceURL(config.local.tapSourceFile), manifest.ord.url);
  assert.equal(target.indexer.endpoint.urlFile, '', 'The template stays unchanged');
  await assert.rejects(playgroundRuntime(target, { directory, manifest: { ...manifest, ord: { url: 'https://example.invalid' } } }), /loopback/);
});

test('local target upgrade removes only named obsolete slots', async () => {
  const input = JSON.parse(await readFile(new URL('../../deploy/targets/regtest.json', import.meta.url)));
  input.bitcoin.wallet = 'removed'; input.ethereum.relayerKeyFile = 'removed';
  delete input.runtime.ownerInscriptionsFile;
  const target = validateTarget(playgroundTargetInput(input));
  assert.equal(target.runtime.ownerInscriptionsFile, '');
  assert.equal('wallet' in target.bitcoin, false);
  assert.equal('relayerKeyFile' in target.ethereum, false);
  input.bitcoin.unknown = true;
  assert.throws(() => validateTarget(playgroundTargetInput(input)), /unknown slots/);
  input.mode = 'mainnet'; assert.throws(() => playgroundTargetInput(input), /local_target/);
});

test('deployment proxy forwards exact indexed intake and rejects extra fields', async () => {
  const body = { asset: 'c1', phase: 'deployment', inscription: 'a'.repeat(64) + 'i0' }, calls = [];
  const engine = { post: async (...args) => { calls.push(args); return { state: 'registered' }; } };
  assert.deepEqual(await forwardDeployment(engine, body), { state: 'registered' });
  assert.deepEqual(calls, [['/mint/deployment', body]]);
  await assert.rejects(forwardDeployment(engine, { ...body, wallet: 'unexpected' }), /invalid_deployment/);
  await assert.rejects(forwardDeployment(engine, { ...body, inscription: 'bad' }), /invalid_deployment/);
  assert.equal(calls.length, 1);
});

test('link, status and already-running up use a copy of the manifest without starting processes', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dmw-launch-lifecycle-')));
  const source = new URL('../.data/manifest.json', import.meta.url);
  t.after(() => rm(dir, { recursive: true }));
  let original; try { original = await readFile(source); } catch (error) { if (error.code === 'ENOENT') { t.skip('No saved local manifest to copy'); return; } throw error; }
  // Keep all saved target/manifest fields, but use this test's own process for
  // liveness. Even if the real playground stops concurrently, up cannot spawn.
  const copy = { ...JSON.parse(original), state: 'ready', supervisor: { pid: process.pid, identity: execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }).trim() } };
  const snapshot = Buffer.from(JSON.stringify(copy));
  await writeFile(join(dir, 'manifest.json'), snapshot, { mode: 0o600 });
  // A disposable token prevents the actual console login credential entering logs.
  await writeFile(join(dir, 'control.token'), 'test-copy-only', { mode: 0o600 });
  for (const action of ['link', 'status', 'up']) {
    const result = spawnSync(process.execPath, ['playground/run.mjs', action], { encoding: 'utf8', env: { ...process.env, DMW_PLAYGROUND_DATA: dir } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, action === 'status' ? /"state": "ready"/ : /test-copy-only/);
  }
  assert.deepEqual(await readFile(source), original);
  assert.deepEqual(await readFile(join(dir, 'manifest.json')), snapshot);
});
