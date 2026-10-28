import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, hex32, gatewayOrigin, localOrigin, MAINNET_GATEWAYS } from './check.mjs';
import { stableJSON } from '../../rules/src/index.js';
import { validateDeployment } from '../../contract/state.js';
import { MAINNET_PARAMS } from '../../contract/beacon/bitcoin.js';
import { TRAC_MAINNET } from '../../service/prod/mainnet.mjs';
import { bitcoinAddress } from './addresses.mjs';
import { paymentPayer } from './signing.mjs';

export const MAINNET_FILE = fileURLToPath(new URL('../networks/mainnet.json', import.meta.url));
export const NETWORK_FIELDS = ['version', 'mode', 'network', 'bitcoinNetwork', 'gateway', 'gatewayKey', 'receiptSigners',
  'headerSource', 'paymentOrigin', 'trac', 'puzzleBits', 'powLimitBits', 'runtime'];
const own = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
export async function readNetworkJSON(path) {
  const fd = await open(path, 'r');
  try {
    const stat = await fd.stat();
    check(stat.isFile() && stat.size <= 65536, 'Expected a network/config JSON file below 64 KiB');
    return JSON.parse(await fd.readFile('utf8'));
  } finally { await fd.close(); }
}
export function validateRoster(roster) {
  check(Array.isArray(roster) && roster.length === 5 && roster.every(m => own(m, ['id', 'identity']) &&
    /^[a-zA-Z0-9._:-]{1,96}$/.test(m.id) && hex32(m.identity) && !/^0+$/.test(m.identity)) &&
    new Set(roster.map(m => m.id)).size === 5 && new Set(roster.map(m => m.identity)).size === 5, 'Pin five distinct receipt signers');
}
export function validateMainnet(profile) {
  check(profile && !JSON.stringify(profile).includes('TO-BE-FILLED-AT-LAUNCH'),
    'Mainnet pins are TO-BE-FILLED-AT-LAUNCH. Obtain the launch-pinned repository release; setup/preflight cannot use this template.');
  check(own(profile, NETWORK_FIELDS) && NETWORK_FIELDS.every(k => Object.hasOwn(profile, k)), 'Unexpected mainnet network fields');
  check(profile.version === 1 && profile.mode === 'mainnet' && profile.network === 'dmw-mainnet' && profile.bitcoinNetwork === 'mainnet', 'Pinned DMW mainnet required');
  for (const field of ['gateway', 'paymentOrigin', 'headerSource']) {
    gatewayOrigin(profile[field], 'mainnet');
    check(MAINNET_GATEWAYS.includes(profile[field]), 'Use the exact pinned production origin');
  }
  check(hex32(profile.gatewayKey) && !/^0+$/.test(profile.gatewayKey), 'Pinned gateway key required');
  validateRoster(profile.receiptSigners);
  check(profile.puzzleBits === 12 && profile.powLimitBits === 0x1d00ffff, 'Mainnet puzzle and proof-of-work limits required');
  const p = profile.trac, r = profile.runtime;
  check(own(p, ['networkId', 'bootstrap', 'msbBootstrap', 'adminPublicKey', 'committeePublicKey']) &&
    p.networkId === String(TRAC_MAINNET.networkId) && p.msbBootstrap === TRAC_MAINNET.msbBootstrap &&
    [p.bootstrap, p.adminPublicKey].every(k => hex32(k) && !/^0+$/.test(k)) && p.bootstrap !== p.msbBootstrap, 'Pinned Trac mainnet context required');
  check(own(r, ['msbChannel', 'peerChannel', 'dhtBootstrap', 'deployment']) &&
    r.msbChannel === TRAC_MAINNET.msbChannel && r.peerChannel === TRAC_MAINNET.peerChannel &&
    stableJSON(r.dhtBootstrap) === stableJSON(TRAC_MAINNET.dhtBootstrap), 'Pinned Trac discovery required');
  validateDeployment(r.deployment);
  check(own(r.deployment, ['network', 'admin', 'committee', 'beacon']) && own(r.deployment.beacon, ['checkpoint', 'params']) &&
    own(r.deployment.beacon.checkpoint, ['height', 'hash', 'bits', 'time', 'chainwork', 'times']), 'Public deployment fields only');
  check(r.deployment.network === profile.network && r.deployment.admin === p.adminPublicKey && r.deployment.committee === p.committeePublicKey &&
    stableJSON(r.deployment.beacon.params) === stableJSON(MAINNET_PARAMS), 'Deployment must match the pinned mainnet authorities and Bitcoin rules');
  return profile;
}
export function validateOwner(owner = {}, network = 'mainnet') {
  check(own(owner, ['receiver', 'payer']), 'Invalid owner addresses');
  for (const [group, fields] of [['receiver', ['bitcoin', 'ethereum']], ['payer', ['tap', 'ethereum']]]) {
    if (!owner[group]) continue;
    check(own(owner[group], fields), 'Invalid owner address fields');
    for (const [rail, address] of Object.entries(owner[group])) {
      if (rail === 'ethereum') paymentPayer('ethereum', address);
      else bitcoinAddress(address, network, group);
    }
  }
  return owner;
}
export function validateLocalConfig(c) {
  check(c && c.localOnly === true && c.mode !== 'mainnet' && typeof c.network === 'string' && !/mainnet/i.test(c.network), 'Explicit local test network required');
  localOrigin(c.gateway);
  check(isAbsolute(c.adapter ?? ''), 'An absolute trusted local adapter is required for regtest');
  if (c.headerSource) localOrigin(c.headerSource);
  check(c.puzzleBits === 0 && c.powLimitBits === 0x207fffff, 'Regtest puzzle and proof-of-work limits required');
  check(hex32(c.gatewayKey), 'Pinned local gateway required'); validateRoster(c.receiptSigners);
  return c;
}
export async function networkProfile({ network = 'mainnet', networkFile } = {}) {
  check(['mainnet', 'regtest'].includes(network), 'Choose --network mainnet or regtest');
  check(network !== 'mainnet' || !networkFile, 'Mainnet always uses kit/networks/mainnet.json; --network-file is regtest only');
  if (network === 'mainnet') return validateMainnet(await readNetworkJSON(MAINNET_FILE));
  check(isAbsolute(networkFile ?? ''), 'Regtest setup requires an absolute --network-file');
  return validateLocalConfig(await readNetworkJSON(networkFile));
}
export async function validatePlayerConfig(config, { pins } = {}) {
  if (config.mode !== 'mainnet') {
    check(config.localOnly === true && isAbsolute(config.adapter ?? ''), 'Use a trusted local adapter or pinned mainnet setup');
    localOrigin(config.gateway); return config;
  }
  pins ??= await readNetworkJSON(MAINNET_FILE);
  validateMainnet(pins);
  check(own(config, [...NETWORK_FIELDS, 'directory', 'owner', 'headers', 'strategy', 'bitcoin']), 'Unpinned production config field');
  if (config.bitcoin !== undefined) {
    check(own(config.bitcoin, ['authority', 'funding']), 'Only a public token authority ID and cardinal funding outpoints belong in Bitcoin config');
    check(config.bitcoin.authority === undefined || /^[0-9a-f]{64}i[0-9]+$/.test(config.bitcoin.authority), 'Invalid token authority inscription ID');
    check(config.bitcoin.funding === undefined || Array.isArray(config.bitcoin.funding) && config.bitcoin.funding.length <= 1000 && config.bitcoin.funding.every(c => own(c, ['txid', 'vout']) && hex32(c.txid) && Number.isSafeInteger(c.vout) && c.vout >= 0), 'Invalid cardinal funding outpoints');
  }
  const projected = Object.fromEntries(NETWORK_FIELDS.map(k => [k, config[k]]));
  validateMainnet(projected);
  check(stableJSON(projected) === stableJSON(pins), 'Production config differs from the repository pins; use the matching launch release');
  check(isAbsolute(config.directory ?? ''), 'An absolute signer directory is required');
  for (const field of ['headers', 'strategy']) if (config[field] !== undefined) check(isAbsolute(config[field]), `An absolute ${field} file is required`);
  validateOwner(config.owner);
  return config;
}
