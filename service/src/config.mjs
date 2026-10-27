import { rules } from './rules.mjs';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './util.mjs';
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export function localURL(value) {
  let u; try { u = new URL(value); } catch { throw Error('endpoint_invalid'); }
  check(u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && !u.search && !u.hash, 'endpoint_must_be_loopback');
  return u.href.replace(/\/$/, '');
}
export async function loadConfig(filename) {
  check(isAbsolute(filename ?? ''), 'absolute_config_required');
  const path = await realpath(filename), rel = relative(repo, path);
  check(rel.startsWith('../'), 'config_outside_repository_required');
  const c = JSON.parse(await readFile(path, 'utf8'));
  check(c.claimsPerWindow === undefined || Number.isSafeInteger(c.claimsPerWindow) && c.claimsPerWindow >= 1 && c.claimsPerWindow <= rules.MAX_CLAIMS_PER_WINDOW, 'claim_budget_config');
  if (c.mode === 'prod') return (await import('../prod/config.mjs')).loadConfig(path);
  check(c.version === 1 && c.mode === 'regtest' && /^[a-zA-Z0-9._:-]{1,96}$/.test(c.network), 'config_network');
  check(c.listen?.host === '127.0.0.1' && Number.isSafeInteger(c.listen.port) && c.listen.port >= 0 && c.listen.port <= 65535, 'config_listen');
  for (const name of ['ethereum', 'trac']) check(typeof c.endpoints?.[name] === 'string', 'endpoint_required');
  check(!c.endpoints.bitcoind && !c.endpoints.indexer && isAbsolute(c.local?.tapSourceFile ?? ''), 'tap_source_file_required');
  check(!['inscriberDirectory', 'networkFeeSats', 'ethereumRelayer', 'ethereumRefundHeight', 'tapRelayer'].some(k => Object.hasOwn(c.local, k)), 'service_wallet_removed');
  c.endpoints = Object.fromEntries(Object.entries(c.endpoints).map(([k, v]) => [k, localURL(v)]));
  for (const name of ['data', 'gatewayKey', 'adapter']) check(isAbsolute(c[name] ?? ''), 'config_path');
  for (const name of ['data', 'gatewayKey']) check(relative(repo, resolve(c[name])).startsWith('../'), 'private_path_outside_repository');
  check(Array.isArray(c.committee) && c.committee.length === 5, 'committee_config');
  c.committee = c.committee.map(s => ({ ...s, url: localURL(s.url) }));
  return c;
}
