import { mkdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { privateJSON, worksheetTarget, validateTarget, need } from './target.mjs';
import { privatePath, productionURL } from '../service/prod/config.mjs';
import { atomicWrite } from '../service/src/util.mjs';
import { encodeTracAddress } from '../rules/src/trac-address.js';
import { payoutAddress } from '../rules/src/payout-bindings.mjs';
import { validateRuntimePolicy } from './runtime.mjs';

// Public inputs only. No role keys, network access, processes or chain writes.
export function collectSingleHostInputs(worksheet, roles, descriptors) {
  const w = structuredClone(worksheet), t = worksheetTarget(w.target);
  validateTarget(t); need(w.operations?.layout === 'single-host', 'single_host_layout');
  need(descriptors.length === 5, 'single_host_roster');
  for (const name of ['funding', 'treasury', 'authorityHolder', 'payer', 'receiver']) {
    const address = roles.bitcoin?.[name + 'Address']; payoutAddress('tap', address, 'mainnet'); t.bitcoin[name + 'Address'] = address;
  }
  for (const name of ['admin', 'treasury', 'payer']) {
    const address = roles.ethereum?.[name + 'Address']; payoutAddress('ethereum', address, 'mainnet'); t.ethereum[name + 'Address'] = address;
  }
  for (const k of ['hostPublicKey', 'writerPublicKey']) need(/^[0-9a-f]{64}$/.test(roles.trac?.[k]), 'single_host_trac_key');
  need(roles.trac.hostPublicKey !== roles.trac.writerPublicKey, 'single_host_writer');
  t.trac.adminPublicKey = t.trac.hostAdminPublicKey = roles.trac.hostPublicKey;
  t.trac.writerPublicKey = roles.trac.writerPublicKey;
  t.trac.balance.hostAddress = encodeTracAddress(t.trac.hostAdminPublicKey);
  t.trac.balance.writerAddress = encodeTracAddress(t.trac.writerPublicKey);
  need(/^[0-9a-f]{64}$/.test(roles.gatewayKey), 'single_host_gateway_key'); t.public.gatewayKey = roles.gatewayKey;
  const urls = new Set();
  for (const [i, m] of t.committee.members.entries()) {
    const d = descriptors.find(d => d.id === m.id), h = w.operations.hosts.operators[i], reader = w.files.operatorReads[i];
    need(d?.network === t.network && h.id === m.id && reader.readerId === m.id && h.unixUser === 'dmw-' + m.id, 'single_host_member');
    for (const kind of ['sidecar', 'signer']) {
      const url = productionURL(h[kind + 'URL']);
      need(url.startsWith('http://127.0.0.1:') && !urls.has(url), 'single_host_ports'); urls.add(url);
      need(new URL(url).host === reader[kind === 'sidecar' ? 'sidecarListen' : 'listen'], 'single_host_listener');
    }
    need(d.url === h.sidecarURL, 'single_host_descriptor');
    for (const k of ['identity', 'encryption']) { need(!m[k] || m[k] === d[k], 'single_host_identity_changed'); m[k] = d[k]; }
    need(reader.tap.endpoints.length === 1, 'single_host_source');
  }
  validateRuntimePolicy(t); w.target = t;
  return w;
}

export async function prepareSingleHostInputs(filename) {
  const w = await privateJSON(filename), target = worksheetTarget(w.target);
  // The original launch input becomes immutable as soon as a journal exists.
  try { await lstat(join(target.paths.output, 'launch-journal')); throw Error('single_host_launch_already_started'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const roles = await privateJSON(w.files.roleAddressesFile);
  const descriptors = await Promise.all(target.committee.members.map(m => privateJSON(join(dirname(w.files.roleAddressesFile), m.id + '-public.json'))));
  const out = collectSingleHostInputs(w, roles, descriptors), t = out.target, c = out.files.tracRuntime;
  for (const dir of [t.paths.output, join(t.paths.output, 'verification'), t.runtime.data, t.runtime.contexts,
    t.runtime.readerData, c.directory, c.hostDirectory, c.fundingDirectory,
    dirname(t.trac.runtimeConfigFile), out.operations.ceremony.decisionDirectory, join(dirname(t.runtime.data), 'build')]) {
    await mkdir(dir, { recursive: true, mode: 0o700 }); await privatePath(dir, { directory: true });
  }
  out.operations.ceremony.session ??= randomBytes(32).toString('hex');
  for (const [i, m] of t.committee.members.entries()) for (const kind of ['signer', 'sidecar'])
    await atomicWrite(m[kind].urlFile, out.operations.hosts.operators[i][kind + 'URL'] + '\n');
  await atomicWrite(t.gateway.endpoint.urlFile, out.operations.hosts.gateway.internalURL + '\n');
  await atomicWrite(t.trac.runtimeConfigFile, JSON.stringify(c, null, 2));
  await atomicWrite(join(dirname(t.runtime.data), 'header-source.json'), JSON.stringify(out.files.headerSource, null, 2));
  await atomicWrite(filename, JSON.stringify(out, null, 2));
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    need(process.argv.length === 4 && process.argv[2] === '--inputs', 'arguments');
    await prepareSingleHostInputs(process.argv[3]);
    console.log('Prepared the one-host layout from public role and committee identities. No keys read or services contacted.');
  } catch { console.error('STOP: provide an owned single-host worksheet, public role file and five matching local descriptors before launch.'); process.exitCode = 1; }
}
