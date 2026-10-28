import { supportedNode } from '../node-version.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, buildRoot, createGroup, loadGroup, startSidecar, privateJSON, rpc, randomHex, descriptor, delay } from './tss.mjs';
import { ceremony } from './tss.mjs';
const exec = promisify(execFile);
const directory = resolve(root, '.run');
const registryFile = resolve(directory, 'processes.json');
async function registry() { try { return JSON.parse(await readFile(registryFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
async function saveRegistry(rows) { await writeFile(registryFile + '.tmp', JSON.stringify(rows), { mode: 0o600 }); await rename(registryFile + '.tmp', registryFile); }
async function record(pid, config) { const rows = await registry(); rows.push({ pid, config }); await saveRegistry(rows); }
async function alive(pid, config) {
  try { const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'command=']); return stdout.trim().split(' ').includes(config); } catch { return false; }
}
export async function down() {
  const rows = await registry(), remaining = [];
  for (const row of rows.reverse()) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 1 || !row.config.startsWith(directory + '/')) throw Error('pid_registry_invalid');
    if (await alive(row.pid, row.config)) {
      process.kill(row.pid, 'SIGTERM');
      for (let i = 0; i < 100 && await alive(row.pid, row.config); i++) await delay(100);
      if (await alive(row.pid, row.config)) { process.kill(row.pid, 'SIGKILL'); await delay(100); }
      if (await alive(row.pid, row.config)) remaining.push(row);
    }
  }
  if (rows.length) await saveRegistry(remaining);
  if (remaining.length) throw Error('processes_still_alive');
  console.log(`Stopped ${rows.length} recorded processes; no committee processes remain in the registry.`);
}
export async function build() {
  const { stdout } = await exec('df', ['-Pk', '/']); console.log(stdout.trim());
  const free = Number(stdout.trim().split('\n').at(-1).trim().split(/\s+/)[3]);
  if (free < 100 * 1024 * 1024) throw Error('less_than_100_GB_free');
  for (const dir of ['go-path', 'go-mod', 'go-cache', 'tmp']) await mkdir(resolve(buildRoot, dir), { recursive: true });
  const env = { ...process.env, GOTELEMETRY: 'off', GOPATH: resolve(buildRoot, 'go-path'), GOMODCACHE: resolve(buildRoot, 'go-mod'), GOCACHE: resolve(buildRoot, 'go-cache'), GOTMPDIR: resolve(buildRoot, 'tmp') };
  const { stdout: version } = await exec('go', ['version']); if (!version.includes('go1.26.')) throw Error('go_1_26_required');
  await exec('go', ['build', '-trimpath', '-o', resolve(buildRoot, 'dmw-tss'), '.'], { cwd: resolve(root, 'tss'), env, maxBuffer: 2 << 20 });
}
export async function up() {
  if (!supportedNode()) throw Error('node_24_22_1_or_newer_24_required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const launchLock = await open(resolve(directory, 'launcher.lock'), 'wx', 0o600);
  const children = []; let complete = false;
  try {
    const rows = await registry(); for (const row of rows) if (await alive(row.pid, row.config)) throw Error('already_running');
    await saveRegistry([]); await build();
    let group;
    try { ({ group } = await loadGroup(directory)); } catch (e) { if (e.code !== 'ENOENT') throw e; group = await createGroup(directory); }
    for (const p of group) children.push(await startSidecar(p, record));
    const states = await Promise.all(group.map(p => rpc(p.url, p.token, '/status')));
    if (states.every(p => !p.public)) { console.log('Generating a new 3-of-5 distributed key.'); await ceremony(group, 'keygen'); }
    else if (!states.every(p => p.public === states[0].public && p.epoch === states[0].epoch && !p.retired)) throw Error('inconsistent_key_state');
    const state = await rpc(group[0].url, group[0].token, '/status'), members = group.map(descriptor), clients = [];
    for (let i = 0; i < group.length; i++) {
      const p = group[i], configFile = resolve(p.directory, 'signer.json'), credentials = resolve(p.directory, 'signer-credentials.json');
      let secret;
      try { secret = JSON.parse(await readFile(credentials, 'utf8')); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const base = JSON.parse(await readFile(resolve(p.directory, 'credentials.json'), 'utf8'));
        secret = { identity: base.identity, encryption: base.encryption, apiToken: randomHex(), sidecarToken: p.token, passphrase: randomHex(), journalKey: randomHex() }; await privateJSON(credentials, secret);
      }
      const config = { id: p.id, network: 'dmw-regtest', epoch: state.epoch, listen: `127.0.0.1:${57600 + i}`, sidecar: p.url, directory: p.directory, secrets: credentials, members, readModule: resolve(root, 'signer/reads.mjs') };
      try { await privateJSON(configFile, config); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const log = await open(resolve(p.directory, 'signer.log'), 'a', 0o600);
      const child = spawn(process.execPath, [resolve(root, 'signer/service.mjs'), configFile], { stdio: ['ignore', log.fd, log.fd] }); child.on('error', () => {}); await log.close();
      if (!child.pid) throw Error('signer_spawn'); children.push(child); await record(child.pid, configFile);
      let healthy = false;
      for (let n = 0; n < 100; n++) {
        if (child.exitCode !== null) throw Error('signer_start_failed');
        try { await rpc(`http://${config.listen}`, secret.apiToken, '/health', {}, 500); healthy = true; break; } catch { await delay(100); }
      }
      if (!healthy) throw Error('signer_start_timeout');
      clients.push({ id: p.id, url: `http://${config.listen}`, token: secret.apiToken, peer: descriptor(p) });
    }
    await writeFile(resolve(directory, 'clients.json'), JSON.stringify(clients), { mode: 0o600 });
    for (const child of children) child.unref(); complete = true;
    console.log('Five sidecars and five signers are running on loopback. Public key:', state.public);
    console.log('Signing reads refuse until a local read adapter is configured. Stop with: node committee/run.mjs down');
  } finally {
    if (!complete && children.length) await down();
    await launchLock.close(); await unlink(resolve(directory, 'launcher.lock'));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  (command === 'up' ? up() : command === 'down' ? down() : command === 'build' ? build() : Promise.reject(Error('usage: node committee/run.mjs up|down|build'))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
