import { KIT_VERSION, KIT_DOWNLOAD_URL } from '../../rules/src/kit-release.js';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { financialMintId } from '../../rules/src/financial-mint.js';
import { linkId, stableJSON } from '../../rules/src/index.js';
import { check, sha256, privateRead, atomicWrite } from './check.mjs';
import { NETWORK_FIELDS, networkProfile, validatePlayerConfig } from './network.mjs';

export function requireKitVersion(minimum) {
  const parts = value => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(BigInt) : null;
  const required = parts(minimum), installed = parts(KIT_VERSION);
  check(required, 'Invalid minimum kit version');
  const difference = installed.findIndex((n, i) => n !== required[i]);
  if (difference >= 0 && installed[difference] < required[difference])
    throw Object.assign(Error(`upgrade_required: This network requires kit ${minimum}; installed kit is ${KIT_VERSION}. Obtain the matching release from ${KIT_DOWNLOAD_URL}. Keep your player directory and saved actions.`), { code: 'upgrade_required' });
}

// Explicit local command: install only the reviewed checkout's public network
// pins, preserving all player-owned settings and an exact private backup.
export async function upgradeConfig({ configFile, networkFile, pins } = {}) {
  check(isAbsolute(configFile ?? ''), 'Pass an absolute existing --config file');
  const bytes = await privateRead(configFile, 65536), previous = JSON.parse(bytes);
  const projected = Object.fromEntries(NETWORK_FIELDS.map(k => [k, previous[k]]));
  if (previous.headerManifestTrust) projected.headerManifestTrust = previous.headerManifestTrust;
  await validatePlayerConfig(previous, { pins: projected });
  const network = previous.mode === 'mainnet' ? 'mainnet' : 'regtest';
  check(network !== 'mainnet' || !networkFile, 'Mainnet upgrades use the reviewed repository pins');
  pins ??= await networkProfile({ network, networkFile });
  check(previous.network === pins.network && previous.mode === pins.mode, 'Upgrade must preserve the player network');
  const next = { ...previous, ...pins };
  for (const field of ['directory', 'owner', 'headers', 'strategy', 'bitcoin', 'headerChunkLimits', 'headerHTTPSettings']) {
    if (Object.hasOwn(previous, field)) next[field] = previous[field]; else delete next[field];
  }
  if (!pins.headerManifestTrust) delete next.headerManifestTrust;
  await validatePlayerConfig(next, { pins });
  check(next.directory === previous.directory && stableJSON(next.owner ?? {}) === stableJSON(previous.owner ?? {}), 'Upgrade must preserve player settings');
  if (stableJSON(next) === stableJSON(previous)) return { version: KIT_VERSION, changed: false, config: configFile, directory: next.directory };
  const backup = `${configFile}.before-kit-${KIT_VERSION}`;
  try {
    const fd = await open(backup, 'wx', 0o600);
    try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; check((await privateRead(backup, 65536)).equals(bytes), 'Upgrade backup already contains a different configuration'); }
  // Refuse a concurrent edit instead of replacing another session's settings.
  check((await privateRead(configFile, 65536)).equals(bytes), 'Configuration changed during upgrade; retry');
  await atomicWrite(configFile, JSON.stringify(next, null, 2) + '\n');
  return { version: KIT_VERSION, changed: true, config: configFile, backup, directory: next.directory };
}

// An imported financial request retains its v1 signature, nonce and fee terms.
// Resolve its existing identity before preparing any v2 reservation. A missing
// read is not evidence that an earlier send or payment never happened.
export async function resumeLegacyFinancial(agent, kind, actionId, intent) {
  const key = `${kind}/${actionId}`, saved = agent.journal.get(key);
  if (!saved || saved.body.request?.v === 2) return null;
  check(saved.fingerprint === sha256(stableJSON(intent)), `Conflicting ${kind} action ID`);
  const id = (kind === 'mint' ? financialMintId : linkId)(agent.network, saved.body.request);
  const response = await (kind === 'mint' ? agent.service.mintStatus(id) : agent.service.linkStatus(id));
  check((response.requestId ?? response.id) === id, 'Financial request ID mismatch');
  if (agent.dryRun) return { state: 'dry-run', requestId: id, request: response, signed: false };
  const result = { state: 'submitted', request: response, paymentLink: agent.service.paymentLink(id, agent.paymentOrigin, kind),
    next: [{ tool: kind === 'mint' ? 'poll_mint' : 'poll_link', arguments: { id } }] };
  agent.journal.mark(key, 'submitted', result);
  return { ...result, replayed: true };
}
