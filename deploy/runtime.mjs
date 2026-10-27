import { join, dirname } from 'node:path';
import { ROOT, validateTarget, need, endpoint as localEndpoint, secret, privateJSON, privateDirectory } from './target.mjs';
import { endpoint as productionEndpoint, validateConfig, privatePath } from '../service/prod/config.mjs';
import { atomicWrite } from '../service/src/util.mjs';
import { validateFeePolicy, currentFee } from '../service/src/fees.mjs';
import { edPublic } from '../service/src/util.mjs';
import { CLAIM_DEFAULTS } from '../rules/src/index.js';
import { encodeTracAddress } from '../rules/src/trac-address.js';

export function localRuntime(t, o) {
  need(t.mode === 'regtest', 'local_runtime_target');
  const p = t.policy;
  return { version: 1, mode: 'regtest', network: t.network, epoch: t.committee.epoch,
    listen: { host: '127.0.0.1', port: o.ports.gateway }, pollMs: p.pollMs, puzzleBits: p.puzzleBits, claimsPerWindow: CLAIM_DEFAULTS.claimsPerWindow,
    data: join(o.directory, 'gateway'), gatewayKey: o.gatewayKey, adapter: o.adapter ?? join(ROOT, 'service/local/adapter.mjs'),
    committee: o.committee, patterns: [],
    endpoints: { ethereum: o.manifest.ethereum.rpc, trac: `http://127.0.0.1:${o.ports.trac}` },
    local: { manifest: join(o.manifest.root, 'manifest.json'), contexts: join(o.directory, 'contexts'), registry: o.registryFile,
      tracToken: o.tracToken, startTip: o.startTip, tapSourceFile: o.tapSourceFile ?? t.indexer.endpoint.urlFile, escrow: o.escrow } };
}
export async function saveRuntime(filename, config) {
  await privateDirectory(dirname(filename));
  if(config.mode === 'prod') await privatePath(dirname(filename),{directory:true});
  await atomicWrite(filename, JSON.stringify(config, null, 2) + '\n');
}
export function validateRuntimePolicy(t) {
  const p = t.policy, integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
  need(t.committee.threshold === 3 && integer(t.committee.epoch, 1, 65535), 'target_committee_policy');
  need(p.confirmations === 1 && p.ethereumConfirmations === 1, 'target_confirmation_policy');
  need(integer(p.authorityEpoch, 0, 65535) && integer(p.puzzleBits, 0, 32) && integer(p.pollMs, 100, 60000), 'target_runtime_policy');
  need(integer(t.bitcoin.feeRate, 1, 1000), 'target_fee_policy');
  need(integer(p.ethereumMaxGas, 21000, 3000000) && /^[1-9][0-9]*$/.test(p.ethereumMaxGasPriceWei), 'target_gas_policy');
  need(new Set(t.committee.members.map(m => m.id)).size === 5 && new Set(t.committee.members.map(m => m.identity)).size === 5 && new Set(t.committee.members.map(m => m.encryption)).size === 5, 'target_roster');
  for (const m of t.committee.members) { need(typeof m.id === 'string' && m.id.length > 0 && /^[0-9a-f]{64}$/.test(m.identity) && /^[0-9a-f]{64}$/.test(m.encryption), 'target_member'); encodeTracAddress(m.identity); }
}

export function targetTapConfig(t) {
  const endpoints = [t.indexer.endpoint].filter(e => e?.urlFile);
  need(endpoints.length >= 1, 'target_tap_source');
  return { endpoints, agreement: endpoints.length };
}

// Resolves only the service's own credential references. Operator read configs
// are rendered on the corresponding operator host with that host's own target.
export async function renderTargetRuntime(t, { filename = t.gateway.configFile, signer = null, persist = true } = {}) {
  validateTarget(t); validateRuntimePolicy(t);
  const production = t.mode === 'mainnet', ep = production ? productionEndpoint : localEndpoint;
  const committee = [];
  for (const m of t.committee.members) {
    const { url } = await ep({ ...m.signer, authFile: '', tokenFile: '' });
    committee.push({ id: m.id, url, token: signer === null ? await secret(m.signer.tokenFile) : '', peer: { id: m.id, identity: m.identity, encryption: m.encryption, url } });
  }
  const registry = await privateJSON(t.gateway.registryFile); validateFeePolicy(registry);
  need(currentFee(registry).baseFee === t.policy.baseFeeAtoms, 'target_fee_policy_binding');
  need(Object.values(registry.assets).every(a => a.privilege === t.bitcoin.authorityInscription && a.tap?.treasury === t.bitcoin.treasuryAddress && a.ethereum?.treasury === t.ethereum.treasuryAddress), 'target_registry_roles');
  const r = t.runtime, p = t.policy;
  let config;
  if (!production) {
    const manifest = await privateJSON(r.manifestFile), urls = {};
    for (const [key, spec] of Object.entries({ bitcoin: t.bitcoin.rpc, ord: t.indexer.endpoint, ethereum: t.ethereum.rpc, trac: t.trac.endpoint })) urls[key] = (await ep(spec)).url;
    need(manifest.bitcoin.rpc === urls.bitcoin && manifest.ord.url === urls.ord && manifest.ethereum.rpc === urls.ethereum, 'target_manifest_endpoints');
    config = localRuntime(t, { directory: dirname(r.data), manifest, committee, gatewayKey: t.gateway.keyFile,
      ports: { gateway: r.listenPort, trac: Number(new URL(urls.trac).port) }, patterns: [],
      tracToken: await secret(t.trac.endpoint.tokenFile), registryFile: t.gateway.registryFile, startTip: r.startTip,
      escrow: { address: t.ethereum.escrowAddress, token: t.ethereum.tokenAddress, chainId: t.ethereum.chainId } });
    Object.assign(config, { data: r.data }); Object.assign(config.local, { contexts: r.contexts });
  } else {
    need(t.bitcoin.chain === 'main' && t.ethereum.chainId === '1' && t.ethereum.signing === 'files', 'production_network_policy');
    const deployment = await privateJSON(r.deploymentFile);
    need(deployment.network === t.network && deployment.admin === t.trac.adminPublicKey && deployment.committee === t.committee.publicKey && deployment.beacon.checkpoint.height === t.bitcoin.checkpointHeight, 'target_deployment_binding');
    if (signer === null) need(edPublic(Buffer.from(await secret(t.gateway.keyFile), 'hex')) === t.public.gatewayKey, 'target_gateway_key_binding');
    config = { version: 1, mode: 'prod', network: t.network, epoch: t.committee.epoch, listen: { host: r.listenHost, port: r.listenPort },
      data: r.data, gatewayKey: t.gateway.keyFile, adapter: join(ROOT, 'service/prod/adapter.mjs'), committee,
      patterns: [], pollMs: p.pollMs, puzzleBits: p.puzzleBits, claimsPerWindow: CLAIM_DEFAULTS.claimsPerWindow,
      prod: { contexts: r.contexts, readerData: r.readerData, registry: t.gateway.registryFile, deployment: r.deploymentFile,
        ...(r.headersFile ? { headersFile: r.headersFile } : {}), startTip: r.startTip, maxHeadersPerView: p.maxHeadersPerView,
        bitcoin: { ...t.indexer.endpoint, kind: 'ord' },
        tap: targetTapConfig(t),
        ethereum: { ...t.ethereum.rpc, chainId: t.ethereum.chainId, address: t.ethereum.escrowAddress, token: t.ethereum.tokenAddress,
          fromBlock: p.ethereumFromBlock, confirmations: p.ethereumConfirmations, maxLogRange: p.ethereumMaxLogRange, maxLogPages: p.ethereumMaxLogPages },
        trac: { bootstrap: t.trac.bootstrap, msbBootstrap: t.trac.msbBootstrap, networkId: Number(t.trac.networkId), runtimeConfig: t.trac.runtimeConfigFile } } };
    if (signer !== null) {
      need(Number.isInteger(signer) && signer >= 0 && signer < 5, 'target_signer_index');
      // Each Unix account owns its credentials, evidence and Trac observer
      // store. These readers may all use the same chain source.
      const own = await privateJSON(r.signerReads[signer]);
      need(own.readerId === t.committee.members[signer].id && own.network === t.network && own.epoch === t.committee.epoch, 'signer_read_domain');
      need(own.bitcoin?.urlFile !== t.bitcoin.rpc.urlFile && own.trac?.runtimeConfig !== t.trac.runtimeConfigFile, 'signer_independent_reads');
      need(own.evidenceDirectory !== r.data && own.contexts !== r.contexts && own.readerData !== r.readerData, 'signer_private_storage');
      need(own.ethereum?.urlFile !== t.ethereum.rpc.urlFile && own.tap?.endpoints?.length === config.prod.tap.endpoints.length && own.tap.endpoints.every(e => ![t.indexer.endpoint.urlFile, t.indexer.independentEndpoint.urlFile].includes(e.urlFile)), 'signer_private_sources');
      config.data = own.evidenceDirectory;
      const endpointFiles = e => ({urlFile:e.urlFile,authFile:e.authFile ?? '',tokenFile:e.tokenFile ?? ''});
      Object.assign(config.prod, { contexts:own.contexts, readerData:own.readerData,
        bitcoin:{...config.prod.bitcoin,...endpointFiles(own.bitcoin)},
        tap:{agreement:own.tap.endpoints.length,endpoints:own.tap.endpoints.map(endpointFiles)},
        ethereum:{...config.prod.ethereum,...endpointFiles(own.ethereum)},
        trac:{...config.prod.trac,runtimeConfig:own.trac.runtimeConfig} });
      need(own.evidence?.urlFile, 'signer_evidence_endpoint');
      config.prod.evidence = { endpoint: own.evidence, directory: own.evidenceDirectory, member: own.readerId, network: t.network, epoch: t.committee.epoch };
      delete config.prod.headersFile;
      if (own.headersFile) config.prod.headersFile = own.headersFile;
      delete config.gatewayKey;
    }
    await validateConfig(config, { committee: signer !== null });
  }
  if (persist) { await privateDirectory(dirname(filename)); await saveRuntime(filename, config); }
  return config;
}
