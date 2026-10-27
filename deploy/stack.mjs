import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { bitcoin, rpc, waitFor, mine, waitIndexed, ordArgs, ordWallet, receiveAddress, save, ORD, run } from '../local/common.mjs';
import { startGateway } from '../local/gateway.mjs';
import { BUILD, validate, diskCheck } from './safety.mjs';

// Import-only stack: the launcher owns every process and its lifetime.
export async function startStack({ directory, target, launch }) {
  validate(target); await diskCheck();
  const root = join(directory, 'stack');
  const ports = { bitcoin: Number(new URL(target.bitcoin.rpc).port), ord: Number(new URL(target.indexer).port), ethereum: Number(new URL(target.ethereum.rpc).port), gateway: target.walletGatewayPort };
  for (const port of [...Object.values(ports), Number(new URL(target.bitcoin.witnessRpc).port), target.trac.port, target.gateway.port,
    ...Array.from({ length: 5 }, (_, i) => target.committee.sidecarPort + i), ...Array.from({ length: 5 }, (_, i) => target.committee.signerPort + i)]) {
    const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); await new Promise(resolve => server.close(resolve));
  }
  for (const [binary, expected] of [['bitcoind', /v29\.0\.0\b/], ['forge', /Version: 1\.7\.1\b/], ['anvil', /Version: 1\.7\.1\b/]]) assert(expected.test((await run(binary, ['--version'])).stdout), 'Pinned binary version mismatch');
  await mkdir(root, { mode: 0o700 }); await mkdir(join(root, 'bitcoin')); await mkdir(join(root, 'ord'));
  const manifest = { version: 1, root, status: 'starting', ports, bitcoin: { rpc: target.bitcoin.rpc, network: 'regtest', wallet: 'faucet' },
    ord: { url: target.indexer }, ethereum: { rpc: target.ethereum.rpc, chainId: 31337 }, gateway: { url: `http://127.0.0.1:${ports.gateway}` }, trac: { mode: 'separate-local-network' }, prices: { mode: 'stub', usd: '0' }, processes: [] };
  const start = async (name, binary, args) => { const child = await launch(name, binary, args); manifest.processes.push({ name, pid: child.pid }); await save(join(root, 'manifest.json'), manifest); };
  await start('bitcoind', 'bitcoind', ['-regtest', '-datadir=' + join(root, 'bitcoin'), '-server=1', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', '-rpcport=' + ports.bitcoin, '-fallbackfee=0.00001', '-printtoconsole=1']);
  await waitFor(() => bitcoin(manifest, 'getblockchaininfo'), 'Bitcoin startup');
  await bitcoin(manifest, 'createwallet', ['faucet']); manifest.bitcoin.miningAddress = await bitcoin(manifest, 'getnewaddress', ['', 'bech32m'], 'faucet');
  await bitcoin(manifest, 'generatetoaddress', [110, manifest.bitcoin.miningAddress]);
  await start('ord', ORD, [...ordArgs(manifest), '--index-addresses', '--index-sats', 'server', '--http', '--address', '127.0.0.1', '--http-port', String(ports.ord), '--polling-interval', '100ms']);
  await waitIndexed(manifest); await save(join(root, 'ord-wallet-recovery.json'), await ordWallet(manifest, ['create']));
  manifest.bitcoin.inscriberAddress = await receiveAddress(manifest); await bitcoin(manifest, 'sendtoaddress', [manifest.bitcoin.inscriberAddress, 10], 'faucet'); await mine(manifest);
  await start('anvil', 'anvil', ['--host', '127.0.0.1', '--port', String(ports.ethereum), '--chain-id', '31337', '--silent']);
  await waitFor(() => rpc(manifest.ethereum.rpc, 'eth_chainId'), 'Anvil startup');
  await run(fileURLToPath(new URL('../eth/foundry', import.meta.url)), ['build', '--offline'], { timeout: 120000 });
  const accounts = await rpc(manifest.ethereum.rpc, 'eth_accounts');
  const send = async tx => {
    const hash = await rpc(manifest.ethereum.rpc, 'eth_sendTransaction', [{ from: accounts[0], gas: '0x4c4b40', ...tx }]);
    const receipt = await waitFor(() => rpc(manifest.ethereum.rpc, 'eth_getTransactionReceipt', [hash]), 'LocalTap transaction'); assert.equal(receipt.status, '0x1'); return receipt;
  };
  const artifact = JSON.parse(await readFile(join(BUILD, 'target/eth-out/LocalTap.sol/LocalTap.json'), 'utf8'));
  const receipt = await send({ data: artifact.bytecode.object + accounts[0].slice(2).padStart(64, '0') });
  manifest.ethereum.token = receipt.contractAddress; manifest.ethereum.accounts = accounts;
  for (const a of accounts.slice(0, 3)) await send({ to: receipt.contractAddress, data: '0x40c10f19' + a.slice(2).padStart(64, '0') + (1000000n * 10n ** 18n).toString(16).padStart(64, '0') });
  const gateway = await startGateway(manifest, { port: ports.gateway });
  manifest.status = 'ready'; await save(join(root, 'manifest.json'), manifest);
  return { manifest, close: () => gateway.stop() };
}
