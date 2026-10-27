import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readSecret, privatePath, readPrivateJSON } from './config.mjs';
import { requireValue as check } from './http.mjs';
import { validateDeployment } from '../../contract/state.js';
import { MAINNET_PARAMS } from '../../contract/beacon/bitcoin.js';
import { rules } from '../src/rules.mjs';
import { TRAC_MAINNET, msbIdentity } from './mainnet.mjs';
import { fanOutValidatorSends } from '../../contract/runtime/fanout.js';
const patched = new WeakSet();
export function installValidatorFanout(network) {
  if (patched.has(network)) return;
  fanOutValidatorSends(network, 3);
  const orchestrator = network.validatorMessageOrchestrator, send = orchestrator.send.bind(orchestrator);
  orchestrator.send = (message, retries = 0) => {
    // Also cover host registration, which sends directly through the MSB.
    // A pool that shrinks after startup must not silently reduce fanout.
    if (retries === 0) check(new Set(network.validatorConnectionManager.connectedValidators()).size >= 3, 'trac_three_validators_required');
    return send(message, retries);
  };
  patched.add(network);
}
export function validateValidators(c) {
  if (c.validators === 'auto') {
    check(c.msbBootstrap === TRAC_MAINNET.msbBootstrap && c.msbChannel === TRAC_MAINNET.msbChannel, 'trac_mainnet_discovery');
  } else check(Array.isArray(c.validators) && c.validators.length >= 3 && c.validators.length <= 16 && new Set(c.validators).size === c.validators.length && c.validators.every(s => /^[0-9a-f]{64}$/.test(s)), 'trac_validators');
}
// trac-peer always loads the peer key from <stores>/<peer store>/db/keypair.json and
// otherwise starts an interactive terminal prompt, which a service cannot answer.
// Place an exact owned 0600 copy of the configured key there; an existing file must match.
export async function installPeerKey(source, target) {
  const key = await readSecret(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = await open(target, 'wx', 0o600); await fd.writeFile(key); await fd.sync(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; check(await readSecret(target) === key, 'trac_peer_key_mismatch'); }
  finally { await fd?.close(); }
}
export async function waitForValidators(bus, c, { timeoutMs = 120000, intervalMs = 250, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  validateValidators(c);
  check(msbIdentity(bus).bootstrapHex === c.msbBootstrap, 'trac_msb_binding');
  if (c.validators === 'auto') check(Number(msbIdentity(bus).networkId) === TRAC_MAINNET.networkId, 'trac_mainnet_binding');
  else await Promise.all(c.validators.map(key => bus.network.tryConnect(key, 'validator')));
  // The MSB observer derives candidates from its replicated mainnet state, just
  // as RESET does. Startup waits; an empty/partial pool never enables writes.
  const end = now() + timeoutMs;
  do {
    const validators = [...new Set(bus.network.validatorConnectionManager.connectedValidators())];
    if (validators.length >= 3) return validators;
    await pause(intervalMs);
  } while (now() < end);
  throw Error('trac_three_validators_required');
}
const require = createRequire(new URL('../../contract/package.json', import.meta.url));
const dependency = name => import(pathToFileURL(require.resolve(name)).href);

export function fundingRuntimeConfig(c) {
  check(c.mode === 'prod' && c.localOnly !== true, 'trac_runtime_config');
  check(typeof c.fundingDirectory === 'string' && c.fundingDirectory.length > 0 &&
    c.fundingDirectory !== c.directory && c.fundingDirectory !== c.hostDirectory, 'trac_funding_directory');
  check(/^[0-9a-f]{64}$/.test(c.msbBootstrap) && typeof c.msbChannel === 'string' && c.msbChannel.length > 0 && c.msbChannel.length <= 128, 'trac_msb_config');
  check(Array.isArray(c.dhtBootstrap) && c.dhtBootstrap.length > 0 && c.dhtBootstrap.length <= 16 && c.dhtBootstrap.every(s => typeof s === 'string' && /^[a-zA-Z0-9.-]+:[0-9]+$/.test(s) && !/localhost|regtest|^127\.|^0\./i.test(s)), 'trac_discovery');
  validateValidators(c);
  return c;
}

// Preparation must be able to read MSB balances before a DMW subnet exists.
// Use a separate observer store, so admission can also run while the gateway
// owns its writer store. This creates no Peer, role key or paid transaction.
export async function openFundingRuntime({ configFile }) {
  const c = fundingRuntimeConfig(await readPrivateJSON(configFile, { maxBytes: 1000000 }));
  await privatePath(c.fundingDirectory, { directory: true });
  await readSecret(c.msbWallet);
  const [{ MainSettlementBus }, { createConfig, ENV }, { default: Wallet }] = await Promise.all([
    dependency('trac-msb/src/index.js'), dependency('trac-msb/src/config/env.js'), dependency('trac-wallet')
  ]);
  const wallet = new Wallet(); await wallet.ready; wallet.importFromFile(c.msbWallet, Buffer.alloc(0));
  const config = createConfig(ENV.MAINNET, { bootstrap: c.msbBootstrap, channel: c.msbChannel,
    dhtBootstrap: c.dhtBootstrap, storesDirectory: c.fundingDirectory, storeName: 'msb',
    enableInteractiveMode: false, enableWallet: true, enableValidatorObserver: true,
    enableRoleRequester: false, enableTxApplyLogs: false, enableErrorApplyLogs: false, debug: false });
  let bus;
  try {
    bus = new MainSettlementBus(config, wallet); await bus.ready();
    await waitForValidators(bus, c);
    return { bus, close: () => bus.close() };
  } catch { await bus?.close(); throw Error('trac_funding_runtime_unavailable'); }
}

// Joins normal mainnet using its public discovery settings and owned wallets.
// This entry never creates a network or key.
export async function openRuntime({ configFile }) {
  return connectRuntime(await readPrivateJSON(configFile, { maxBytes: 1000000 }));
}
export async function connectRuntime(c, { create = false } = {}) {
  check(c.mode === 'prod' && c.localOnly !== true, 'trac_runtime_config');
  validateDeployment(c.dmw);
  check(rules.stableJSON(c.dmw.beacon?.params) === rules.stableJSON(MAINNET_PARAMS) && c.dmw.beacon.checkpoint.height % 2016 === 0, 'trac_mainnet_deployment');
  check(Array.isArray(c.dhtBootstrap) && c.dhtBootstrap.length > 0 && c.dhtBootstrap.length <= 16 && c.dhtBootstrap.every(s => typeof s === 'string' && /^[a-zA-Z0-9.-]+:[0-9]+$/.test(s) && !/localhost|regtest|^127\.|^0\./i.test(s)), 'trac_discovery');
  validateValidators(c);
  for (const field of (create ? ['msbBootstrap'] : ['msbBootstrap', 'subnetBootstrap'])) check(/^[0-9a-f]{64}$/.test(c[field]), 'trac_bootstrap');
  for (const field of ['msbChannel', 'peerChannel']) check(typeof c[field] === 'string' && c[field].length > 0 && c[field].length <= 128, 'trac_channel');
  await privatePath(c.directory, { directory: true }); await readSecret(c.msbWallet); await readSecret(c.peerWallet);
  const [{ Peer, Wallet, createConfig, ENV, ensureTextCodecs }, { MainSettlementBus }, { createConfig: msbConfig, ENV: MSB_ENV }, { default: PeerWallet }, { default: Contract }, { default: Protocol }] = await Promise.all([
    dependency('trac-peer'), dependency('trac-msb/src/index.js'), dependency('trac-msb/src/config/env.js'), dependency('trac-wallet'), import('../../contract/contract.js'), import('../../contract/protocol.js')
  ]);
  await ensureTextCodecs(); let peer, bus, closed = false;
  const close = async () => { if (closed) return; closed = true; try { await peer?.close(); } finally { try { await peer?.store.close(); } finally { await bus?.close(); } } };
  const wallet = async (Class, file) => { const w = new Class(); await w.ready; w.importFromFile(file, Buffer.alloc(0)); return w; };
  try {
    const mc = msbConfig(MSB_ENV.MAINNET, { bootstrap: c.msbBootstrap, channel: c.msbChannel, dhtBootstrap: c.dhtBootstrap, storesDirectory: c.directory, storeName: 'msb', enableInteractiveMode: false, enableWallet: true, enableValidatorObserver: true, enableRoleRequester: false, enableTxApplyLogs: false, enableErrorApplyLogs: false, debug: false });
    bus = new MainSettlementBus(mc, await wallet(PeerWallet, c.msbWallet)); await bus.ready();
    await waitForValidators(bus, c);
    installValidatorFanout(bus.network);
    const pc = createConfig(ENV.MAINNET, { bootstrap: create ? null : c.subnetBootstrap, channel: c.peerChannel, dhtBootstrap: c.dhtBootstrap, storesDirectory: c.directory, storeName: 'peer', txContentHash: 'utf8-strict', enableInteractiveMode: false, enableTxlogs: false, replicate: true, enableUpdater: true, enableBackgroundTasks: true, apiMsgExposed: true, apiTxExposed: true, maxTxDelay: 21600, txPoolMaxSize: 10000 });
    pc.dmw = c.dmw;
    await installPeerKey(c.peerWallet, pc.keyPairPath);
    peer = new Peer({ config: pc, msb: bus, wallet: await wallet(Wallet, c.peerWallet), protocol: Protocol, contract: Contract }); await peer.ready();
    return { peer, bus, close };
  } catch { await close(); throw Error('trac_runtime_unavailable'); }
}
