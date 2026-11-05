import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rpc, waitFor } from '../../local/common.mjs';
import { REGTEST_PARAMS, parseHeader, workFor } from '../../contract/beacon/bitcoin.js';
import { admissionWhileSigning } from './admission-signing-fixture.mjs';

test('Bitcoin regtest headers drive later-batch admission through gateway, five signers and unchanged kits', { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'admission-regtest-')), socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const log = await open(join(root, 'bitcoin.log'), 'w', 0o600);
  const child = spawn(process.env.DMW_BITCOIND ?? 'bitcoind', [`-datadir=${root}`, '-regtest', '-server=1', '-listen=0',
    '-discover=0', '-dnsseed=0', '-fixedseeds=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${port}`],
  { stdio: ['ignore', log.fd, log.fd] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000); await ended; clearTimeout(timer);
    }
    await rm(root, { recursive: true });
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); await log.close();
  const call = async (method, params = [], wallet) => rpc(`http://127.0.0.1:${port}` + (wallet ? '/wallet/' + wallet : ''), method, params,
    (await readFile(join(root, 'regtest/.cookie'), 'utf8')).trim());
  await waitFor(() => call('getblockchaininfo'), 'isolated regtest node');
  assert.equal((await call('getblockchaininfo')).chain, 'regtest');
  await call('createwallet', ['fixture']);
  const address = await call('getnewaddress', ['', 'bech32m'], 'fixture');
  await call('generatetoaddress', [120, address]);
  const raw = [];
  for (let height = 0; height <= 120; height++) raw.push(await call('getblockheader', [await call('getblockhash', [height]), false]));
  const genesis = parseHeader(raw[0]);
  await admissionWhileSigning(t, { chainFixture: { network: 'dmw-regtest-admission', bitcoinNetwork: 'regtest', anchor: 110, raw,
    checkpoint: { ...genesis, height: 0, chainwork: workFor(genesis.bits).toString() }, params: REGTEST_PARAMS } });
});
