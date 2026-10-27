import { access, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ROOT, REGTEST_TEMPLATE, DEFAULT_TARGET, loadTarget, validateTarget, endpoint, need } from './target.mjs';

// Deployment inputs are selected before any lifecycle/process code runs.
// The lifecycle manifest records PIDs and readiness, never deployment inputs.
export async function playgroundTarget({ profile = 'default', filename, dataDirectory } = {}) {
  need(['default', 'rehearsal'].includes(profile), 'playground_profile');
  if (!filename) {
    filename = profile === 'default' ? DEFAULT_TARGET : join(ROOT, 'deploy/targets', profile + '.local.json');
    try { await access(filename); } catch (e) { if (e.code !== 'ENOENT') throw e; filename = REGTEST_TEMPLATE; }
  }
  // Old local launch files may retain removed service-spending fields. Project
  // those exact obsolete slots away; reject every other schema mismatch.
  const target = validateTarget(playgroundTargetInput(JSON.parse(await readFile(resolve(filename), 'utf8'))));
  need(target.mode === 'regtest' && target.bitcoin.chain === 'regtest' && target.ethereum.chainId === '31337', 'playground_requires_local_target');
  const ports = structuredClone(target.local.playground.ports);
  for (const [key, spec] of Object.entries({ bitcoin: target.bitcoin.rpc, ord: target.indexer.endpoint, ethereum: target.ethereum.rpc, trac: target.trac.endpoint, gateway: target.gateway.endpoint })) {
    if (spec.urlFile) ports[key] = Number(new URL((await endpoint({ ...spec, authFile: '', tokenFile: '' })).url).port);
  }
  if (target.committee.members.every(m => m.signer.urlFile && m.sidecar.urlFile)) {
    ports.tss = await Promise.all(target.committee.members.map(async m => Number(new URL((await endpoint({ ...m.sidecar, authFile: '', tokenFile: '' })).url).port)));
    ports.signers = await Promise.all(target.committee.members.map(async m => Number(new URL((await endpoint({ ...m.signer, authFile: '', tokenFile: '' })).url).port)));
  }
  const values = Object.values(ports).flat();
  need(values.every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) && new Set(values).size === values.length, 'target_ports');
  const data = resolve(dataDirectory || target.local.playground.dataDirectory || join(ROOT, profile === 'default' ? 'playground/.data' : 'playground/.' + profile));
  return { target, filename: resolve(filename), ports: Object.freeze(ports), data };
}

export function playgroundTargetInput(input) {
  need(input?.mode === 'regtest', 'playground_requires_local_target');
  const target = structuredClone(input);
  const removed = {
    bitcoin: ['wallet', 'cancelFeeRate', 'releaseAddress', 'releaseKeyFile'],
    ethereum: ['payerKeyFile', 'relayerAddress', 'relayerKeyFile'],
    funding: ['ethereumPayerWei', 'ethereumRelayerWei', 'tapPayerAtoms'],
    runtime: ['inscriberDirectory', 'releaseAuthority'],
    policy: ['ethereumRefundAfterBitcoin', 'networkFeeSats'],
  };
  for (const [section, keys] of Object.entries(removed)) for (const key of keys) delete target[section]?.[key];
  if (target.local?.smoke) delete target.local.smoke.networkFeeSats;
  if (target.runtime) target.runtime.ownerInscriptionsFile ??= '';
  return target;
}
