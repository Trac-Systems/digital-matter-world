import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { check, hex32, privateDirectory } from './check.mjs';
import { publicKey } from './keyring.mjs';
import { validatePlayerConfig, validateLocalConfig } from './network.mjs';
import { validateDeployment } from '../../contract/state.js';
import { loadPlayerPeer } from './player-peer.mjs';

const require = createRequire(new URL('../../contract/package.json', import.meta.url));
const dependency = name => import(pathToFileURL(require.resolve(name)).href);

// The native trac-peer/MSB stack used by the Pear runtime also runs under Node.
// Adapt the already unlocked local wallet in memory. Never call the upstream
// interactive initKeyPair, which would export an unencrypted keypair file.
export function runtimeWallets(wallet) {
  const raw = {
    publicKey: Buffer.from(publicKey(wallet), 'hex'), secretKey: wallet.secretKey,
    address: wallet.address, sign: bytes => Buffer.from(wallet.sign(bytes)),
  };
  const peer = {
    get publicKey() { return raw.publicKey.toString('hex'); },
    get secretKey() { return Buffer.from(raw.secretKey).toString('hex'); },
    get address() { return raw.address; },
    sign: bytes => raw.sign(bytes).toString('hex'),
    verify(signature, message, key = peer.publicKey) {
      try {
        const pk = typeof key === 'string' ? Buffer.from(key, 'hex') : Buffer.from(key);
        const sig = typeof signature === 'string' ? Buffer.from(signature, 'hex') : Buffer.from(signature);
        if (pk.length !== 32 || sig.length !== 64) return false;
        const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk]), format: 'der', type: 'spki' });
        return verify(null, Buffer.from(message), publicKey, sig);
      } catch { return false; }
    },
    async initKeyPair() { check(raw.publicKey.length === 32 && raw.secretKey?.length === 64, 'Unlock the local Trac signer first'); },
  };
  return { raw, peer };
}

export function playerPeerStore(config) {
  if (!config.runtime.deployment.v2) return 'peer';
  check(hex32(config.trac.bootstrap), 'Pinned notary bootstrap required');
  return 'peer-v2-' + config.trac.bootstrap;
}

export async function openPlayerRuntime({ wallet, config }) {
  const production = config.mode === 'mainnet';
  await validatePlayerConfig(config);
  if (!production) {
    validateLocalConfig(config); validateDeployment(config.runtime?.deployment);
    check(config.runtime.deployment.beacon.params.retarget === false && config.runtime.deployment.beacon.params.powLimitBits === 0x207fffff &&
      config.runtime.dhtBootstrap?.length > 0 && config.runtime.dhtBootstrap.every(s => /^127\.0\.0\.1:[0-9]+$/.test(s)) &&
      config.runtime.msbChannel === 'dmw-local-msb' && config.runtime.peerChannel === 'dmw-local-subnet', 'Loopback regtest runtime required');
    // The upstream peer has no DHT bind-host option. The existing local loader
    // constrains socket binding as well as discovery, without editing packages.
    await import('../../playground/loopback.cjs');
  }
  const directory = await privateDirectory(join(config.directory, production ? 'trac-mainnet' : 'trac-regtest'));
  const [{ Peer, createConfig, ENV, ensureTextCodecs }, { MainSettlementBus }, { createConfig: msbConfig, ENV: MSB_ENV },
    { default: Contract }, { default: Protocol }] = await Promise.all([
    loadPlayerPeer(pathToFileURL(require.resolve('trac-peer')).href), dependency('trac-msb/src/index.js'), dependency('trac-msb/src/config/env.js'),
    import('../../contract/contract.js'), import('../../contract/protocol.js'),
  ]);
  await ensureTextCodecs();
  const wallets = runtimeWallets(wallet), r = config.runtime;
  let peer, bus, closing;
  const close = () => closing ??= (async () => {
    try { await peer?.close(); } finally { try { await peer?.store.close(); } finally { await bus?.close(); } }
  })();
  try {
    const mc = msbConfig(production ? MSB_ENV.MAINNET : MSB_ENV.DEVELOPMENT, { bootstrap: config.trac.msbBootstrap, channel: r.msbChannel,
      dhtBootstrap: r.dhtBootstrap, storesDirectory: directory, storeName: 'msb',
      enableInteractiveMode: false, enableWallet: true, enableValidatorObserver: production, enableRoleRequester: false,
      enableTxApplyLogs: false, enableErrorApplyLogs: false, debug: false });
    check(!production || mc.networkId === 918, 'Pinned MSB network 918 required');
    bus = new MainSettlementBus(mc, wallets.raw); await bus.ready();
    if (!production && r.validatorKey) await bus.network.tryConnect(r.validatorKey, 'validator');
    const pc = createConfig(production ? ENV.MAINNET : ENV.DEVELOPMENT, { bootstrap: config.trac.bootstrap, channel: r.peerChannel, dhtBootstrap: r.dhtBootstrap,
      storesDirectory: directory, storeName: playerPeerStore(config), txContentHash: 'utf8-strict', enableInteractiveMode: false,
      enableTxlogs: false, replicate: true, enableUpdater: true, enableBackgroundTasks: true,
      apiMsgExposed: false, apiTxExposed: false, maxTxDelay: 21600, txPoolMaxSize: 10000 });
    pc.dmw = r.deployment;
    peer = new Peer({ config: pc, msb: bus, wallet: wallets.peer, protocol: Protocol, contract: Contract }); await peer.ready();
    return { peer, bus, close };
  } catch (error) { await close(); throw error; }
}
