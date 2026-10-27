// Isolated chain producer for reader tests. Application clients receive only
// ord HTTP; Core is used here solely to create/reorganize the regtest chain.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { BUILD, ORD, bitcoin, ordArgs, ordWallet, receiveAddress, waitFor, waitIndexed, mine } from '../../local/common.mjs';
export async function regtest() {
  const base = Number(process.env.DMW_TEST_PORT_BASE ?? 59790);
  for (const port of [base, base + 1]) {
    const socket = createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => socket.close(resolve));
  }
  const root = await realpath(await mkdtemp(join(BUILD, 'reader-ord-'))), children = [];
  const manifest = { root, bitcoin: { rpc: `http://127.0.0.1:${base}` }, ord: { url: `http://127.0.0.1:${base+1}` } };
  const start = async (name, binary, args) => {
    const log = await open(join(root, name + '.log'), 'a', 0o600);
    const child = spawn('nice', ['-n', '20', binary, ...args], { stdio: ['ignore', log.fd, log.fd] });
    children.push(child); await once(child, 'spawn'); await log.close();
  };
  const close = async () => {
    for (const child of children.toReversed()) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  };
  try {
    await mkdir(join(root, 'bitcoin')); await mkdir(join(root, 'ord'));
    await start('bitcoin', 'bitcoind', ['-regtest', `-datadir=${root}/bitcoin`, '-server=1', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${base}`, '-fallbackfee=0.00001']);
    await waitFor(() => bitcoin(manifest, 'getblockchaininfo'), 'regtest producer');
    await bitcoin(manifest, 'createwallet', ['faucet']);
    manifest.bitcoin.miningAddress = await bitcoin(manifest, 'getnewaddress', ['', 'bech32m'], 'faucet');
    await bitcoin(manifest, 'generatetoaddress', [110, manifest.bitcoin.miningAddress]);
    await start('ord', ORD, [...ordArgs(manifest), '--index-addresses', '--index-sats', 'server', '--http', '--address', '127.0.0.1', '--http-port', String(base+1), '--polling-interval', '100ms']);
    await waitIndexed(manifest);
    await ordWallet(manifest, ['create']);
    const receiver = await receiveAddress(manifest);
    await bitcoin(manifest, 'sendtoaddress', [receiver, 10], 'faucet'); await mine(manifest);
    const sourceFile = join(root, 'tap-source.url'); await writeFile(sourceFile, manifest.ord.url, { mode: 0o600 });
    return { root, manifest, receiver, sourceFile, close, rpc: (method, args) => bitcoin(manifest, method, args), mine: n => mine(manifest, n) };
  } catch (error) { await close(); throw error; }
}
