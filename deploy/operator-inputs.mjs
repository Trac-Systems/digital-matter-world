import { mkdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateJSON, loadTarget, need } from './target.mjs';
import { privatePath, productionURL } from '../service/prod/config.mjs';
import { atomicWrite } from '../service/src/util.mjs';

// Offline public-input materialization on ONE operator's host. It never reads
// keys, contacts endpoints, or provisions someone else's credentials.
export async function prepareOperatorInputs(filename, id, directory) {
  const w = await privateJSON(filename), target = structuredClone(await loadTarget(filename));
  need(w.format === 'dmw-mainnet-inputs-v1' && target.mode === 'mainnet', 'operator_input_format');
  const index = target.committee.members.findIndex(m => m.id === id);
  need(index >= 0, 'operator_input_member');
  const member = target.committee.members[index], original = dirname(member.sidecarCredentialsFile);
  directory ??= original;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privatePath(directory, { directory: true });
  const binding = { network: target.network, id, identity: member.identity, encryption: member.encryption, epoch: target.committee.epoch };
  need(binding.network && /^[0-9a-f]{64}$/.test(binding.identity) && /^[0-9a-f]{64}$/.test(binding.encryption), 'operator_input_identity');
  const bindingFile = join(directory, 'input-binding.json');
  let saved;
  try { await lstat(bindingFile); saved = await privateJSON(bindingFile); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  need(!saved || JSON.stringify(saved) === JSON.stringify(binding), 'operator_input_identity_changed');
  const relocate = value => Array.isArray(value) ? value.map(relocate) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v)]))
    : typeof value === 'string' && value.startsWith(original + '/') ? directory + value.slice(original.length) : value;
  const reader = relocate(w.files.operatorReads[index]);
  const trac = relocate(w.files.operatorTrac[index]);
  need(reader?.readerId === id && trac?.mode === 'prod', 'operator_input_reader');
  reader.network = target.network; reader.epoch = target.committee.epoch;
  const endpointDirectory = join(directory, 'endpoints');
  await mkdir(endpointDirectory, { recursive: true, mode: 0o700 });
  const urls = [];
  for (const peer of target.committee.members) {
    const host = w.operations.hosts.operators.find(h => h.id === peer.id);
    need(host, 'operator_input_host');
    for (const kind of ['sidecar', 'signer']) {
      const url = productionURL(host[kind + 'URL'] ?? 'https://' + host[kind + 'Domain']);
      const urlFile = join(endpointDirectory, peer.id + '-' + kind + '.url');
      urls.push([urlFile, url + '\n']);
      peer[kind] = { urlFile, authFile: '', tokenFile: peer.id === id ? join(endpointDirectory, kind + '.token') : '' };
    }
  }
  target.runtime.signerReads[index] = join(directory, 'reader-input.json');
  target.runtime.deploymentFile = join(directory, 'deployment.json');
  target.gateway.registryFile = join(directory, 'registry.json');
  member.credentialsFile = join(directory, 'signer-credentials.json');
  member.sidecarCredentialsFile = join(directory, 'credentials.json');
  member.shareFile = join(directory, 'share.enc');
  reader.evidence.urlFile = join(endpointDirectory, 'gateway-evidence.url');
  urls.push([reader.evidence.urlFile, productionURL(w.operations.hosts.gateway.internalURL ?? target.public.gateway) + '\n']);
  reader.trac.runtimeConfig = join(directory, 'trac-runtime.json');
  if (target.trac.bootstrap) {
    trac.subnetBootstrap = target.trac.bootstrap;
    trac.dmw = await privateJSON(target.runtime.deploymentFile);
    need(trac.dmw.network === target.network && trac.dmw.committee === target.committee.publicKey, 'operator_input_deployment');
  }
  need(trac.msbBootstrap === target.trac.msbBootstrap, 'operator_input_msb');
  for (const d of [reader.evidenceDirectory, reader.contexts, reader.readerData, trac.directory]) {
    need(d.startsWith(directory + '/'), 'operator_input_directory');
    await mkdir(d, { recursive: true, mode: 0o700 }); await privatePath(d, { directory: true });
  }
  // All validation precedes the writes. Existing identity binding may never be
  // changed; deployment output pins may be filled during the configuration step.
  await atomicWrite(bindingFile, JSON.stringify(binding));
  for (const [path, text] of urls) await atomicWrite(path, text);
  await atomicWrite(reader.trac.runtimeConfig, JSON.stringify(trac, null, 2));
  await atomicWrite(target.runtime.signerReads[index], JSON.stringify(reader, null, 2));
  await atomicWrite(join(directory, 'target.json'), JSON.stringify(target, null, 2));
  return { id, targetFile: join(directory, 'target.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    need(args.length === 4 && args[0] === '--inputs' && args[2] === '--id', 'arguments');
    await prepareOperatorInputs(args[1], args[3]);
    console.log('Prepared this operator\'s public input files. No keys read, services started or network requests made.');
  } catch {
    console.error('STOP: use operator-inputs.mjs --inputs OWNED_WORKSHEET --id MEMBER with complete public pins and local reader shapes. Private values are not printed.');
    process.exitCode = 1;
  }
}
