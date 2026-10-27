import fs from 'fs';
import path from 'path';
import process from 'process';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { Peer, Wallet, createConfig, ENV, ensureTextCodecs } from 'trac-peer';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as createMsbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';
import MatterContract from '../contract.js';
import MatterProtocol from '../protocol.js';
import { validateDeployment } from '../state.js';
import { controls, until } from './control.js';
import { fanOutValidatorSends } from './fanout.js';

// This entry is deliberately limited to disposable loopback deployments.
export async function runPeer(config) {
  if (!globalThis.Bare || config.localOnly !== true || config.dmw?.beacon?.params?.retarget !== false ||
      !config.dhtBootstrap?.length || config.dhtBootstrap.some(x => !/^127\.0\.0\.1:[0-9]+$/.test(x))) throw new Error('Local Pear configuration required');
  validateDeployment(config.dmw);
  await ensureTextCodecs();
  let bus, peer, closed = false, stopControl;
  const close = async () => {
    if (closed) return; closed = true; stopControl?.();
    let failure;
    for (const stop of [() => peer?.close(), () => peer?.store.close(), () => bus?.close()]) try { await stop(); } catch (e) { failure ??= e; }
    if (failure) throw failure;
  };
  const shutdown = () => void close().then(() => process.exit(0), () => process.exit(1));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, shutdown);
  globalThis.Pear?.teardown?.(shutdown);
  const wallet = async (Class, file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const w = new Class(); await w.ready;
    if (fs.existsSync(file)) w.importFromFile(file, b4a.alloc(0));
    else { await w.generateKeyPair(); w.exportToFile(file, b4a.alloc(0)); fs.chmodSync(file, 0o600); }
    return w;
  };
  try {
    const mc = createMsbConfig(MSB_ENV.DEVELOPMENT, { bootstrap: config.msbBootstrap, channel: 'dmw-local-msb',
      dhtBootstrap: config.dhtBootstrap, storesDirectory: config.directory, storeName: 'msb', enableInteractiveMode: false,
      enableWallet: true, enableValidatorObserver: false, enableRoleRequester: false, enableTxApplyLogs: false });
    bus = new MainSettlementBus(mc, await wallet(PeerWallet, mc.keyPairPath)); await bus.ready();
    fanOutValidatorSends(bus.network);
    await bus.network.tryConnect(config.validatorKey, 'validator');
    await until(() => bus.state.getAdminEntry(), 'local MSB synchronized');
    await until(() => bus.network.validatorConnectionManager.connectionCount() > 0, 'validator connected');
    const pc = createConfig(ENV.DEVELOPMENT, { bootstrap: config.subnetBootstrap, channel: 'dmw-local-subnet',
      dhtBootstrap: config.dhtBootstrap, storesDirectory: config.directory, storeName: 'peer', txContentHash: 'utf8-strict',
      enableInteractiveMode: false, enableTxlogs: false, replicate: true, enableUpdater: true, enableBackgroundTasks: true,
      apiMsgExposed: true, apiTxExposed: true, maxTxDelay: 21600, txPoolMaxSize: 10000 });
    pc.dmw = config.dmw;
    peer = new Peer({ config: pc, msb: bus, wallet: await wallet(Wallet, pc.keyPairPath), protocol: MatterProtocol, contract: MatterContract });
    await peer.ready();
    const commands = controls(peer, bus);
    let pending = '', queue = Promise.resolve();
    const onData = chunk => {
      pending += chunk.toString();
      if (pending.length > 262144) { shutdown(); return; }
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        queue = queue.then(async () => {
          let id;
          try {
            const r = JSON.parse(line); id = r.id;
            if (!Object.hasOwn(commands, r.command)) throw new Error('Unknown local command');
            console.log('DMW_REPLY ' + JSON.stringify({ id, value: await commands[r.command](r.args ?? {}) }));
          } catch (e) { console.log('DMW_REPLY ' + JSON.stringify({ id, error: e.message })); }
        });
      }
    };
    process.stdin.on('data', onData); process.stdin.once('end', shutdown);
    stopControl = () => { process.stdin.removeListener('data', onData); process.stdin.removeListener('end', shutdown); process.stdin.pause(); };
    console.log('DMW_READY ' + JSON.stringify({ pid: process.pid, runtime: 'pear', bare: Bare.version,
      address: peer.wallet.publicKey, msbAddress: peer.wallet.address, writer: peer.writerLocalKey, bootstrap: peer.base.key.toString('hex') }));
  } catch (e) { await close(); throw e; }
}
