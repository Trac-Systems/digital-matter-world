#!/usr/bin/env node
import { mkdir, open, access, lstat, realpath, rm, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD, ROOT, DATA, CURRENT, ORD, PORTS, run, save, jsonFile, diskCheck, bitcoin, rpc, waitFor, mine, waitIndexed, ordArgs, ordWallet, receiveAddress, current } from './common.mjs';
import { startGateway } from './gateway.mjs';

const self = fileURLToPath(import.meta.url);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const maybe = async path => jsonFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const identity = async pid => (await run('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='])).stdout.trim();

export async function ownedRun(root) {
  if (dirname(root) !== DATA || !/^run-[a-f0-9-]{36}$/.test(basename(root))) throw new Error('Expected an exact absolute run path under ' + DATA);
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('Refusing symlinked run path');
  const marker = await jsonFile(join(root, 'owner.json'));
  if (marker.project !== ROOT || marker.root !== root) throw new Error('Run ownership mismatch');
  return root;
}

async function control(root, action, payload) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: join(root, 'control.sock'), path: `/${action}`, method: 'POST', timeout: 90000 }, response => {
      let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error(text)));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Control timed out'))); req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

async function stop(root) {
  await ownedRun(root);
  const manifest = await jsonFile(join(root, 'manifest.json'));
  if (manifest.status === 'stopped') return;
  const supervisor = manifest.processes.find(p => p.name === 'supervisor');
  if (supervisor && alive(supervisor.pid)) {
    if (await identity(supervisor.pid) !== supervisor.identity) throw new Error('Supervisor PID identity changed');
    await control(root, 'stop');
    await waitFor(() => !alive(supervisor.pid), 'supervisor exit', 90000);
  } else {
    for (const p of manifest.processes.toReversed()) {
      if (p.name === 'supervisor' || !alive(p.pid)) continue;
      if (await identity(p.pid) !== p.identity) throw new Error(`PID identity changed for ${p.name}`);
      process.kill(p.pid, 'SIGTERM');
      await waitFor(() => !alive(p.pid), `${p.name} exit`, 90000);
    }
    manifest.status = 'stopped'; await save(join(root, 'manifest.json'), manifest);
    const lock = await maybe(join(DATA, 'stack.lock'));
    if (lock?.root === root) await unlink(join(DATA, 'stack.lock'));
  }
}

async function freePorts() {
  for (const port of Object.values(PORTS)) {
    const server = createTcpServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
  }
}

async function up() {
  await diskCheck();
  if (process.version !== 'v23.11.0') throw new Error('Use Node 23.11.0');
  for (const [binary, expected] of [['bitcoind', /v29\.0\.0\b/], ['forge', /Version: 1\.7\.1\b/], ['anvil', /Version: 1\.7\.1\b/]]) {
    if (!expected.test((await run(binary, ['--version'])).stdout)) throw new Error(`Unexpected ${binary} version; see local/versions.json`);
  }
  await access(ORD);
  await mkdir(DATA, { recursive: true, mode: 0o700 });
  const lockPath = join(DATA, 'stack.lock');
  const existing = await maybe(lockPath);
  if (existing) throw new Error(`A stack lock exists. Run local/down first for ${existing.root}`);
  await freePorts();
  const root = join(DATA, `run-${randomUUID()}`);
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ root })); await lock.close();
  await mkdir(root, { mode: 0o700 });
  await save(join(root, 'owner.json'), { project: ROOT, root });
  const logfile = await open(join(root, 'supervisor.log'), 'a', 0o600);
  const child = spawn(process.execPath, [self, 'serve', root], { detached: true, stdio: ['ignore', logfile.fd, logfile.fd] });
  await logfile.close(); child.unref();
  try {
    const manifest = await waitFor(async () => {
      const m = await maybe(join(root, 'manifest.json'));
      if (m?.status === 'failed') throw Object.assign(new Error(m.error), { fatal: true });
      return m?.status === 'ready' ? m : false;
    }, `stack startup; inspect ${root}/supervisor.log`, 180000);
    await save(CURRENT, { manifest: join(root, 'manifest.json') });
    console.log(JSON.stringify({ root, manifest: join(root, 'manifest.json'), gateway: manifest.gateway.url, bitcoin: manifest.bitcoin.rpc, ethereum: manifest.ethereum.rpc }, null, 2));
  } catch (error) { await stop(root).catch(() => {}); throw error; }
}

async function serve(root) {
  await ownedRun(root);
  const manifest = {
    version: 1, root, status: 'starting', ports: PORTS,
    bitcoin: { rpc: `http://127.0.0.1:${PORTS.bitcoin}`, network: 'regtest', wallet: 'faucet' },
    ord: { url: `http://127.0.0.1:${PORTS.ord}`, revision: 'b8f6ea35cf6b9d405d4db7c58555e3c8ab33e8cd' },
    gateway: { url: `http://127.0.0.1:${PORTS.gateway}` },
    ethereum: { rpc: `http://127.0.0.1:${PORTS.ethereum}`, chainId: 31337 },
    trac: { mode: 'stub', broadcasts: 'rejected' }, prices: { mode: 'stub', usd: '0' },
    processes: [{ name: 'supervisor', pid: process.pid, identity: await identity(process.pid) }],
  };
  const write = () => save(join(root, 'manifest.json'), manifest);
  await write();
  const children = []; let gateway, timer, miningTask, stopping, startup;
  async function start(name, command, args) {
    const log = await open(join(root, `${name}.log`), 'a', 0o600);
    const child = spawn(command, args, { stdio: ['ignore', log.fd, log.fd] });
    children.push(child);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await log.close();
    manifest.processes.push({ name, pid: child.pid, identity: await identity(child.pid) });
    child.on('exit', () => { if (!stopping && manifest.status === 'ready') void shutdown().then(() => server.close()); });
    await write();
  }
  const shutdown = () => stopping ??= (async () => {
    clearInterval(timer);
    await startup?.catch(() => {});
    await miningTask?.catch(() => {});
    if (gateway) await gateway.stop();
    for (const child of children.toReversed()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGTERM');
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'child shutdown', 90000);
    }
    manifest.status = 'stopped'; await write();
    const lock = await maybe(join(DATA, 'stack.lock'));
    if (lock?.root === root) await unlink(join(DATA, 'stack.lock'));
  })();
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (req.url === '/stop') {
      void shutdown().then(() => { res.end('stopped'); server.close(); }).catch(error => { res.writeHead(500).end(error.message); }); return;
    }
    if (req.url !== '/mine' || manifest.status !== 'ready' || stopping) { res.writeHead(409).end('Stack is not ready'); return; }
    try {
      let input = ''; for await (const chunk of req) { input += chunk; if (input.length > 1024) throw new Error('Control request too large'); }
      const { count, seconds, stop: stopMining } = JSON.parse(input);
      if (!stopMining && (!Number.isSafeInteger(count) || count < 1 || count > 100000 || !Number.isFinite(seconds) || seconds < 0.1)) throw new Error('Invalid mining count or interval');
      clearInterval(timer); await miningTask;
      manifest.mining = stopMining ? null : { count, seconds }; await write();
      if (!stopMining) timer = setInterval(() => {
        if (miningTask) return;
        miningTask = mine(manifest, count).catch(error => { clearInterval(timer); console.error(error.message); }).finally(() => { miningTask = null; });
      }, seconds * 1000);
      res.end(stopMining ? 'Automatic mining stopped' : 'Automatic mining started');
    } catch (error) { res.writeHead(400).end(error.message); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(join(root, 'control.sock'), resolve); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown().then(() => server.close()));
  startup = (async () => {
    await mkdir(join(root, 'bitcoin')); await mkdir(join(root, 'ord'));
    await start('bitcoind', 'bitcoind', ['-regtest', `-datadir=${root}/bitcoin`, '-server=1', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${PORTS.bitcoin}`, '-fallbackfee=0.00001', '-printtoconsole=1']);
    await waitFor(() => bitcoin(manifest, 'getblockchaininfo'), 'Bitcoin Core');
    await bitcoin(manifest, 'createwallet', ['faucet']);
    manifest.bitcoin.miningAddress = await bitcoin(manifest, 'getnewaddress', ['', 'bech32m'], 'faucet');
    await bitcoin(manifest, 'generatetoaddress', [110, manifest.bitcoin.miningAddress]);
    await start('ord', ORD, [...ordArgs(manifest), '--index-addresses', '--index-sats', 'server', '--http', '--address', '127.0.0.1', '--http-port', String(PORTS.ord), '--polling-interval', '100ms']);
    await waitIndexed(manifest);
    await save(join(root, 'ord-wallet-recovery.json'), await ordWallet(manifest, ['create']));
    manifest.bitcoin.inscriberAddress = await receiveAddress(manifest);
    await bitcoin(manifest, 'sendtoaddress', [manifest.bitcoin.inscriberAddress, 10], 'faucet');
    await mine(manifest);
    await start('anvil', 'anvil', ['--host', '127.0.0.1', '--port', String(PORTS.ethereum), '--chain-id', '31337', '--silent']);
    await waitFor(() => rpc(manifest.ethereum.rpc, 'eth_chainId'), 'Anvil');
    await run(`${ROOT}/eth/foundry`, ['build', '--offline'], { timeout: 120000 });
    const accounts = await rpc(manifest.ethereum.rpc, 'eth_accounts');
    const artifact = await jsonFile(`${BUILD}/target/eth-out/LocalTap.sol/LocalTap.json`);
    const hash = await rpc(manifest.ethereum.rpc, 'eth_sendTransaction', [{ from: accounts[0], data: artifact.bytecode.object + accounts[0].slice(2).padStart(64, '0'), gas: '0x4c4b40' }]);
    const receipt = await waitFor(() => rpc(manifest.ethereum.rpc, 'eth_getTransactionReceipt', [hash]), 'token deployment');
    if (receipt.status !== '0x1') throw new Error('Token deployment reverted');
    manifest.ethereum.token = receipt.contractAddress;
    manifest.ethereum.accounts = accounts;
    for (const account of accounts.slice(0, 3)) {
      const data = '0x40c10f19' + account.slice(2).padStart(64, '0') + (1000000n * 10n ** 18n).toString(16).padStart(64, '0');
      const tx = await rpc(manifest.ethereum.rpc, 'eth_sendTransaction', [{ from: accounts[0], to: receipt.contractAddress, data, gas: '0x30d40' }]);
      const minted = await waitFor(() => rpc(manifest.ethereum.rpc, 'eth_getTransactionReceipt', [tx]), 'token mint');
      if (minted.status !== '0x1') throw new Error('Token mint reverted');
    }
    gateway = await startGateway(manifest);
    manifest.status = 'ready'; await write();
    console.log('Local stack ready');
  })();
  try { await startup; } catch (error) {
    console.error(error.message); manifest.error = error.message;
    await shutdown(); manifest.status = 'failed'; await write(); server.close(); process.exitCode = 1;
  }
}

async function main() {
  const [action, argument, intervalArg] = process.argv.slice(2);
  if (action === 'up') return up();
  if (action === 'serve') return serve(argument);
  if (action === 'down') {
    const manifest = argument ? null : await current().catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const root = argument || manifest?.root;
    if (!root) { console.log('No current stack'); return; }
    await stop(root); console.log('Stopped ' + root); return;
  }
  if (action === 'wipe') {
    if (!argument) throw new Error('wipe requires the exact absolute run path from the manifest');
    await ownedRun(argument); await stop(argument);
    const m = await jsonFile(join(argument, 'manifest.json'));
    for (const p of m.processes) if (alive(p.pid)) throw new Error('Recorded PID is still alive; refusing deletion');
    await rm(argument, { recursive: true });
    const pointer = await maybe(CURRENT);
    if (pointer?.manifest === join(argument, 'manifest.json')) await unlink(CURRENT);
    console.log('Deleted ' + argument); return;
  }
  if (action === 'mine') {
    const manifest = await current();
    if (argument === 'stop') { console.log(await control(manifest.root, 'mine', { stop: true })); return; }
    const count = Number(argument || 1);
    if (!intervalArg) { console.log(JSON.stringify(await mine(manifest, count))); return; }
    const seconds = Number(intervalArg);
    if (!Number.isFinite(seconds) || seconds < 0.1) throw new Error('Interval must be at least 0.1 seconds');
    console.log(await control(manifest.root, 'mine', { count, seconds }));
    return;
  }
  if (action === 'status') { console.log(JSON.stringify(await current(), null, 2)); return; }
  throw new Error('Usage: node local/stack.mjs up|down [run]|wipe /absolute/run|mine [blocks] [seconds]|status');
}
if (process.argv[1] === self) main().catch(error => { console.error(error.message); process.exitCode = 1; });
