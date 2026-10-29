import { escrowEventSettings } from '../../committee/signer/escrow-events.mjs';
import { lookupSettings } from './lookup-settings.mjs';
import { readerSettings } from './reader-settings.mjs';
import { readRegistry } from '../src/registry.mjs';
import { readTapSourceURL } from '../src/source-url.mjs';
import { validateFeePolicy } from '../src/fees.mjs';
import { open, lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { requireValue, AdapterError } from './http.mjs';
import { validateDeployment } from '../../contract/state.js';
import { MAINNET_PARAMS } from '../../contract/beacon/bitcoin.js';
import { rules } from '../src/rules.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const within = (root, path) => path === root || path.startsWith(root + sep);
export async function privatePath(filename, { directory = false } = {}) {
  try {
    requireValue(isAbsolute(filename ?? '') && resolve(filename) === filename && !within(repo, filename), 'private_path');
    const canonical = await realpath(filename), stat = await lstat(filename);
    requireValue(canonical === filename && !stat.isSymbolicLink() && (directory ? stat.isDirectory() && (stat.mode & 0o777) === 0o700 : stat.isFile() && (stat.mode & 0o777) === 0o600), 'private_permissions');
    requireValue(stat.uid === process.getuid(), 'private_owner');
    // Refuse credentials beneath any checkout, including an unrelated one.
    for (let parent = directory ? filename : dirname(filename); ; parent = dirname(parent)) {
      let checkout = false; try { await access(parent + '/.git'); checkout = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      requireValue(!checkout, 'private_repository'); if (dirname(parent) === parent) break;
    }
    return filename;
  } catch (error) { if (error instanceof AdapterError) throw error; throw new AdapterError('private_file_unavailable'); }
}
export async function readSecret(filename, { maxBytes = 65536 } = {}) {
  await privatePath(filename);
  let fd;
  try {
    fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await fd.stat(); requireValue(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid() && stat.size <= maxBytes, 'private_permissions');
    const bytes = Buffer.alloc(maxBytes + 1); const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    requireValue(bytesRead <= maxBytes, 'private_file_limit'); return bytes.subarray(0, bytesRead).toString('utf8').trim();
  } catch (error) { if (error instanceof AdapterError) throw error; throw new AdapterError('private_file_unavailable'); }
  finally { await fd?.close(); }
}
export async function readPrivateJSON(filename, options) {
  const text = await readSecret(filename, options);
  try { return JSON.parse(text); } catch { throw new AdapterError('private_json'); }
}
export function productionURL(value) {
  let url; try { url = new URL(value); } catch { throw new AdapterError('endpoint_invalid'); }
  // Same-host services use explicit IPv4 loopback origins. Never extend this
  // exception to LAN addresses, hostnames, URL credentials or provider paths.
  if (typeof value === 'string' && /^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(value)) {
    requireValue(integer(Number(url.port), 1024, 65535), 'endpoint_transport');
    return url.origin;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'endpoint_transport');
  requireValue(host && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local') && !host.endsWith('.internal') && !/regtest/i.test(url.pathname) && !isIP(host) && host.includes('.'), 'endpoint_production');
  return url.href.replace(/\/$/, '');
}
export async function endpoint(spec) {
  requireValue(spec && typeof spec.urlFile === 'string' && !spec.url && !spec.password, 'endpoint_file_required');
  requireValue(!(spec.tokenFile && spec.authFile), 'endpoint_auth_choice');
  // The host's one provider credential is a read-only systemd copy. Keep the
  // ordinary secret/key policy intact and reject credential-name substitution.
  let source;
  if (spec.credentialName !== undefined) {
    requireValue(spec.credentialName === 'ethereum.url' && spec.urlFile === '/etc/dmw/private/ethereum.url'
      && !spec.authFile && !spec.tokenFile, 'endpoint_credential_scope');
    source = await (await import('../src/systemd-ethereum.mjs')).readEthereumCredential();
  } else source = await readSecret(spec.urlFile);
  const url = productionURL(source), headers = {};
  if (spec.tokenFile) { const token = await readSecret(spec.tokenFile); requireValue(token.length > 0 && !/[\r\n]/.test(token), 'endpoint_token'); headers.authorization = 'Bearer ' + token; }
  if (spec.authFile) { const auth = await readSecret(spec.authFile); requireValue(auth.includes(':') && !/[\r\n]/.test(auth), 'endpoint_auth'); headers.authorization = 'Basic ' + Buffer.from(auth).toString('base64'); }
  return { url, headers };
}
export async function tapEndpoint(spec) {
  requireValue(spec && typeof spec.urlFile === 'string' && !spec.url, 'tap_source_file_required');
  const url=await readTapSourceURL(spec.urlFile,{rootOwned:process.platform==='linux'}),headers={};
  requireValue(!(spec.tokenFile && spec.authFile),'endpoint_auth_choice');
  if(spec.tokenFile)headers.authorization='Bearer '+await readSecret(spec.tokenFile);
  if(spec.authFile)headers.authorization='Basic '+Buffer.from(await readSecret(spec.authFile)).toString('base64');
  return {url,headers};
}
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
export function evidenceSnapshotPolicy(value = {}) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => ['retries', 'backoffMs'].includes(k)), 'evidence_snapshot_policy');
  const { retries = 3, backoffMs = 50 } = value;
  requireValue(integer(retries, 0, 5) && integer(backoffMs, 0, 1000), 'evidence_snapshot_policy');
  return { retries, backoffMs };
}
export async function validateConfig(config, { committee = false } = {}) {
  requireValue(config?.pipelineDepth === undefined || [1, 2].includes(config.pipelineDepth), 'pipeline_depth');
  requireValue(config?.version === 1 && config.mode === 'prod' && /^[a-zA-Z0-9._:-]{1,96}$/.test(config.network) && !/regtest|localhost/i.test(config.network), 'config_network');
  requireValue(config.listen?.host === '127.0.0.1' && integer(config.listen.port, 1024, 65535), 'config_listen');
  requireValue(config.adapter === resolve(repo, 'service/prod/adapter.mjs'), 'config_adapter');
  requireValue(config.claimsPerWindow === undefined || integer(config.claimsPerWindow, 1, rules.MAX_CLAIMS_PER_WINDOW), 'claim_budget_config');
  const p = config.prod; requireValue(p && !config.endpoints && !config.local, 'config_production');
  readerSettings(p.readerSettings); lookupSettings(p.lookupSettings);
  const { evidenceSettings } = await import('./evidence.mjs');
  evidenceSettings(p.evidenceSettings); if (p.evidence) evidenceSettings(p.evidence.settings);
  evidenceSnapshotPolicy(p.evidenceSnapshot);
  await privatePath(config.data, { directory: true });
  for (const name of ['contexts', 'readerData']) await privatePath(p[name], { directory: true });
  await privatePath(p.registry);
  const registry = await readRegistry(p.registry, p.registrySettings), deployment = await readPrivateJSON(p.deployment);
  requireValue(registry && registry.assets && typeof registry.assets === 'object' && !Array.isArray(registry.assets), 'config_registry');
  validateFeePolicy(registry);
  validateDeployment(deployment);
  requireValue(deployment.network === config.network && rules.stableJSON(deployment.beacon?.params) === rules.stableJSON(MAINNET_PARAMS) && BigInt(deployment.beacon.checkpoint.height) % 2016n === 0n, 'config_deployment');
  if (p.http) {
    const h = p.http;
    requireValue(h.maxConcurrent === undefined || integer(h.maxConcurrent, 1, 64), 'http_policy');
    requireValue((h.requestsPerSecond === undefined || Number.isFinite(h.requestsPerSecond) && h.requestsPerSecond > 0) && (h.timeoutMs === undefined || integer(h.timeoutMs, 1, 0x7fffffff)) && (h.retries === undefined || integer(h.retries, 0, Number.MAX_SAFE_INTEGER)) && (h.backoffMs === undefined || integer(h.backoffMs, 0, Number.MAX_SAFE_INTEGER)) && (h.maxQueue === undefined || integer(h.maxQueue, 1, Number.MAX_SAFE_INTEGER)) && (h.maxBytes === undefined || integer(h.maxBytes, 1, Number.MAX_SAFE_INTEGER)) && (h.maxBackoffMs === undefined || integer(h.maxBackoffMs, 0, 0x7fffffff)), 'http_policy');
  }
  requireValue(p.bitcoin?.kind === 'ord' && !p.bitcoin.authFile && !p.bitcoin.tokenFile, 'bitcoin_source');
  const bitcoinSource = await tapEndpoint(p.bitcoin);
  requireValue(Array.isArray(p.tap?.endpoints) && p.tap.endpoints.length === 1, 'tap_sources');
  const source = await tapEndpoint(p.tap.endpoints[0]);
  requireValue(source.url === bitcoinSource.url && !p.tap.endpoints[0].authFile && !p.tap.endpoints[0].tokenFile, 'tap_bitcoin_source');
  requireValue(p.tap.agreement === 1, 'tap_agreement');
  requireValue(p.ethereum && /^[1-9][0-9]*$/.test(p.ethereum.chainId) && !['1337', '31337'].includes(p.ethereum.chainId), 'ethereum_chain');
  for (const name of ['address', 'token']) requireValue(/^0x[0-9a-f]{40}$/.test(p.ethereum[name]) && !/^0x0{40}$/.test(p.ethereum[name]), 'ethereum_address');
  requireValue(/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(p.ethereum.fromBlock) && p.ethereum.confirmations === 1 && integer(p.ethereum.maxLogRange, 1, Number.MAX_SAFE_INTEGER) && integer(p.ethereum.maxLogPages, 1, Number.MAX_SAFE_INTEGER), 'ethereum_policy');
  escrowEventSettings({ blockRange: p.ethereum.maxLogRange, ...p.ethereum.eventSettings });
  await endpoint(p.ethereum);
  requireValue(p.trac && /^[0-9a-f]{64}$/.test(p.trac.bootstrap) && /^[0-9a-f]{64}$/.test(p.trac.msbBootstrap) && p.trac.networkId !== undefined, 'trac_network');
  await readSecret(p.trac.runtimeConfig); if (p.trac.runtimeModule) await privatePath(p.trac.runtimeModule);
  if (p.headersFile) await privatePath(p.headersFile);
  if (p.headerSeed) {
    await privatePath(p.headerSeed.manifestFile); await privatePath(p.headerSeed.directory, { directory: true });
    const { validateManifestTrust } = await import('../../kit/lib/header-manifest.mjs');
    const { chunkDownloadLimits } = await import('../../kit/lib/header-chunks.mjs');
    validateManifestTrust(p.headerSeed.trust); chunkDownloadLimits(p.headerSeed.limits);
  }
  requireValue(Array.isArray(config.committee) && config.committee.length === 5 && config.committee.every(s => typeof s.id === 'string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(s.id) && s.peer?.id === s.id && /^[0-9a-f]{64}$/.test(s.peer.identity)) && new Set(config.committee.map(s => s.id)).size === 5 && new Set(config.committee.map(s => s.peer.identity)).size === 5, 'committee_config');
  requireValue((config.v2 ? typeof p.startTip === 'string' && /^[1-9][0-9]*$/.test(p.startTip) : integer(p.startTip, 1, Number.MAX_SAFE_INTEGER)) && integer(p.maxHeadersPerView, 1, Number.MAX_SAFE_INTEGER), 'bitcoin_policy');
  requireValue(committee ? !!p.evidence : !p.evidence, 'evidence_required_for_operator');
  if (p.evidence) {
    requireValue(committee && p.evidence.network === config.network && p.evidence.epoch === config.epoch && p.evidence.directory === config.data && config.committee.some(m => m.id === p.evidence.member), 'evidence_config');
    await endpoint(p.evidence.endpoint);
  }
  requireValue(!p.inscriber && !p.tapRelayer && !p.ethereum.signerKeyFile, 'service_wallet_removed');
  if (!committee) {
    requireValue(/^[0-9a-f]{64}$/.test(await readSecret(config.gatewayKey)), 'gateway_key');
  }
  return config;
}
export async function loadConfig(filename, options) {
  let config; try { config = JSON.parse(await readSecret(filename, { maxBytes: 1000000 })); } catch (e) { if (e instanceof AdapterError) throw e; throw new AdapterError('config_json'); }
  return validateConfig(config, options);
}
