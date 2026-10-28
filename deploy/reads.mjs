import { registryPages } from './registry.mjs';
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import { endpoint as productionEndpoint, tapEndpoint, productionURL } from '../service/prod/config.mjs';
import { HttpSource, jsonRpc } from '../service/prod/http.mjs';
import { endpoint as localEndpoint, need } from './target.mjs';
import { GENESIS } from '../contract/beacon/bitcoin.js';
import { openFundingRuntime } from '../service/prod/runtime.mjs';
import { msbIdentity } from '../service/prod/mainnet.mjs';
import { localBalances } from './local-balances.mjs';
import { validateTracAddress } from '../rules/src/trac-address.js';
import { join } from 'node:path';
import { TapReader } from '../service/prod/tap.mjs';
import { indexedAuthority } from '../service/prod/tap-index.mjs';

export async function tlsHealth(value) {
  const url = new URL(productionURL(value));
  if (url.protocol === 'http:') return { valid: true, transport: 'loopback' };
  const addresses = await lookup(url.hostname, { all: true });
  need(addresses.length > 0 && addresses.every(a => !/^(127\.|0\.|::1$|::ffff:127\.)/.test(a.address)), 'production_dns');
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    const fail = () => { socket.destroy(); reject(Error('production_tls')); };
    socket.setTimeout(5000, fail); socket.once('error', fail);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(), expires = Date.parse(cert.valid_to);
      if (!socket.authorized || !Number.isFinite(expires) || expires <= Date.now()) return fail();
      socket.end(); resolve({ valid: true, expires, protocol: socket.getProtocol() });
    });
  });
}
export async function msbFunding(target, runtime) {
  const own = !runtime;
  runtime ??= await openFundingRuntime({ configFile: target.trac.runtimeConfigFile });
  try {
    const { bus } = runtime, identity = msbIdentity(bus);
    need(identity.bootstrapHex === target.trac.msbBootstrap && String(identity.networkId) === target.trac.networkId, 'msb_network');
    const balances = {};
    for (const role of ['host', 'writer']) {
      const address = target.trac.balance[role + 'Address']; validateTracAddress(address);
      const row = await bus.state.getNodeEntry(address); need(row?.balance?.length === 16, 'msb_funding_account');
      balances[address] = BigInt('0x' + Buffer.from(row.balance).toString('hex')).toString();
    }
    const fee = bus.state.getFee(); need(fee?.length === 16, 'msb_fee');
    return { networkId: String(identity.networkId), bootstrap: identity.bootstrapHex, observedAt: Date.now(), balances,
      feeAtoms: BigInt('0x' + Buffer.from(fee).toString('hex')).toString(), source: 'pinned-msb-runtime', validators: bus.network.validatorConnectionManager.connectedValidators() };
  } finally { if (own) await runtime.close(); }
}

// The same bounded read interface for loopback rehearsal and TLS production.
// There is deliberately no generic write RPC exposed by this adapter.
export async function targetReads(t, { resolveEndpoint, sourceFactory, tlsProbe = tlsHealth, runtime, lookupSettings } = {}) {
  const production = t.mode === 'mainnet', resolve = resolveEndpoint ?? (production ? productionEndpoint : localEndpoint);
  const endpoints = {}, sources = {}, tlsChecks = [];
  for (const [name, spec] of Object.entries({ bitcoin: t.bitcoin.rpc, witness: t.bitcoin.witnessRpc, indexer: t.indexer.endpoint,
    independentIndexer: t.indexer.independentEndpoint, ethereum: t.ethereum.rpc, gateway: t.gateway.endpoint, trac: t.trac.endpoint })) {
    if (!spec.urlFile) continue;
    const ep = await (production && !resolveEndpoint && ['indexer','independentIndexer'].includes(name) ? tapEndpoint : resolve)(spec); endpoints[name] = ep;
    if (production && !['indexer','independentIndexer'].includes(name)) tlsChecks.push(await tlsProbe(ep.url));
    sources[name] = sourceFactory ? sourceFactory(name, ep) : new HttpSource({ ...ep, requestsPerSecond: 10, retries: 1 });
  }
  const readOnly = (source, path = '') => { const call = jsonRpc(source, {path}); return (method, params = []) => {
    need(/^(getblockchaininfo|getblockcount|getblockhash|getblockheader|getrawtransaction|validateaddress|getaddressinfo|listunspent|estimatesmartfee|eth_chainId|eth_getCode|eth_call|eth_getBalance|eth_gasPrice|eth_estimateGas|eth_getBlockByNumber|eth_getStorageAt|eth_getTransactionCount|eth_getTransactionReceipt|eth_getTransactionByHash)$/.test(method), 'read_only_rpc');
    return call(method, params);
  }; };
  need(sources.bitcoin && sources.ethereum && sources.indexer, 'read_sources');
  const core = readOnly(sources.bitcoin), ethereum = readOnly(sources.ethereum);
  const tap = async (name, path) => (await sources[name].request('/r/tap/' + path)).result;
  return { core, ethereum, endpoints, tlsChecks,
    witness: sources.witness && readOnly(sources.witness),
    async chainAgreement() {
      const info = await core('getblockchaininfo'); need(info.chain === t.bitcoin.chain && !info.initialblockdownload, 'bitcoin_chain');
      const genesis = await core('getblockhash', [0]); if (production) need(genesis === GENESIS.hash, 'bitcoin_genesis');
      need(BigInt(await ethereum('eth_chainId')) === BigInt(t.ethereum.chainId), 'ethereum_chain');
      const names = sources.independentIndexer ? ['indexer', 'independentIndexer'] : ['indexer'];
      need(names.every(n => sources[n]), 'indexer_sources');
      const tips = [];
      for (const name of names) {
        need(await sources[name].request('/r/blockhash/0') === genesis, 'indexer_genesis');
        const height = Number(await tap(name, 'getCurrentBlock'));
        need(Number.isSafeInteger(height) && height <= info.blocks && height >= info.blocks - t.policy.confirmations, 'indexer_lag');
        const hash = await sources[name].request('/r/blockhash/' + height); need(hash === await core('getblockhash', [height]), 'indexer_core_disagreement'); tips.push({ height, hash });
      }
      need(tips.every(v => v.height === tips[0].height && v.hash === tips[0].hash), 'indexer_disagreement');
      return { height: info.blocks, hash: info.bestblockhash, genesis, indexers: tips };
    },
    async funding() {
      if (production) return msbFunding(t, runtime);
      const balances = await localBalances(t.trac.balance);
      return { balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, String(v)])), observedAt: Date.now(), source: 'local-baseline', feeAtoms: null };
    },
    async registry(registry) {
      need(registry.assets && !Array.isArray(registry.assets), 'registry_assets');
      const indexer = new TapReader({ sources: [sources.indexer, sources.independentIndexer].filter(Boolean), agreement: sources.independentIndexer ? 2 : 1,
        bitcoin: { blockHash: height => core('getblockhash', [height]) }, settings: lookupSettings });
      const active = await indexedAuthority(indexer, join(t.paths.output, 'preflight-tap-lookups.sqlite'), t.bitcoin.authorityInscription, lookupSettings);
      need(active?.ins === t.bitcoin.authorityInscription && await indexer.tap('getPrivilegeAuthCancelled/' + t.bitcoin.authorityInscription) === false, 'authority_inactive');
      for (const page of registryPages(registry)) for (const { value: a } of page) {
        const path = 'getDeployment/' + encodeURIComponent(a.indexTick ?? a.tick), d = await tap('indexer', path);
        need(d?.ins === a.id && d.prv === t.bitcoin.authorityInscription && Number(d.dec) === 0, 'registry_deployment');
        if (sources.independentIndexer) need(JSON.stringify(d) === JSON.stringify(await tap('independentIndexer', path)), 'deployment_disagreement');
        const tx = await core('getrawtransaction', [a.id.slice(0, 64), true]); need(tx.confirmations >= t.policy.confirmations, 'deployment_confirmations');
      }
    },
    async gateway() { need(sources.gateway, 'gateway_endpoint'); return sources.gateway.request('/health'); },
    async sidecar(m, path, body) {
      const ep = await resolve(m.sidecar); if (production) await tlsProbe(ep.url);
      const source = sourceFactory ? sourceFactory('sidecar-' + m.id, ep) : new HttpSource({ ...ep });
      return source.request(path, { method: 'POST', body, retry: false });
    },
    async signer(m, path, body) {
      const ep = await resolve(m.signer); if (production) await tlsProbe(ep.url);
      const source = sourceFactory ? sourceFactory('signer-' + m.id, ep) : new HttpSource({ ...ep });
      return source.request(path, { method: 'POST', body, retry: false });
    }
  };
}
