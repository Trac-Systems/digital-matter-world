import { tracBootstrap } from '../deploy/trac-bootstrap.mjs';
import { runtimeTrac } from '../kit/lib/trac.mjs';
import { unlock } from '../kit/lib/keyring.mjs';
import { readdir } from 'node:fs/promises';
import { relayHeaders } from '../service/local/relay.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { localNetwork, until } from './network.mjs';
import { controls } from '../contract/runtime/control.js';
import { REGTEST_PARAMS } from '../contract/beacon/bitcoin.js';
import { runtimeTransport } from '../service/src/transport.mjs';
import { Store } from '../service/src/store.mjs';
import { rules } from '../service/src/rules.mjs';
import { check, diskCheck, atomicWrite, serial } from '../service/src/util.mjs';
import { localURL } from '../service/src/config.mjs';
import { jsonRequest } from '../service/src/http-client.mjs';

export function tracClient(endpoint, token) {
  localURL(endpoint);
  return async (method, args = []) => {
    const r = await jsonRequest(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method, args }), timeout: 45000 });
    const body = r.value; check(r.ok && !body.error, body.error ?? 'trac_unavailable', 503); return body.result;
  };
}
import { liveHold, mintEventChanges } from '../service/local/mint-events.mjs';
export { holdKey, liveHold } from '../service/local/mint-events.mjs';
export async function startTrac(config) {
  await diskCheck(); check(config.listen.host === '127.0.0.1', 'local_listener');
  const network = await localNetwork({ directory: config.directory, cleanup: false });
  let events, server;
  const close = async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await events?.close(); await network.close(); };
  try {
    const validator = await network.msb(), bus = await network.client(validator), genesis = rules.parseHeader(config.genesis);
    const dmw = { network: config.network, committee: config.committee, ...(config.admin ? { admin: config.admin } : {}), beacon: { checkpoint: config.checkpoint ?? { height: 0, hash: genesis.hash, bits: genesis.bits, time: genesis.time, chainwork: config.genesisWork, times: [genesis.time] }, params: REGTEST_PARAMS } };
    const indexer = await network.peer('indexer', bus, null, { dmw }), writer = await network.peer('writer', bus, indexer.base.key.toString('hex'), { dmw });
    await network.fund(validator, indexer.wallet); await network.fund(validator, writer.wallet);
    const { admin, registration } = await tracBootstrap({ indexer, writer, bus, deployment: dmw, mode: 'regtest' });
    const api = writer.protocol.instance.api, transport = runtimeTransport(writer, bus, { installFanout: false });
    events = await Store.open(join(network.root, 'events')); const gate = serial();
    const row = async key => (await writer.base.view.get(key))?.value ?? null;
    const sync = () => gate(async () => {
      await writer.base.update(); const end = writer.base.view.version;
      const { changes, counted } = await mintEventChanges(events, writer.base.view.createHistoryStream({ gte: events.get('meta', 'cursor') ?? 0, lt: end }));
      if (changes.length || (events.get('meta', 'cursor') ?? 0) !== end) await events.transact([...changes, { space: 'meta', id: 'counted', value: counted }, { space: 'meta', id: 'cursor', value: end }]);
    });
    const connect = async () => { if (!bus.network.validatorConnectionManager.connectionCount()) { await bus.network.tryConnect(validator.wallet.publicKey.toString('hex'), 'validator'); await until(() => bus.network.validatorConnectionManager.connectionCount() > 0, 'validator connection'); } };
    const kit = runtimeTrac(writer, { network: config.network, localOnly: true, msb: bus });
    const fundPlayer = async directory => {
      const wallet = await unlock({ directory, password: await readFile(join(directory, 'password'), 'utf8') });
      try { await network.fund(validator, wallet); } finally { wallet.secretKey?.fill(0); }
    };
    const methods = {
      assetSupply: async () => {
        const assets = new Map(), add = (asset, amount) => assets.set(asset, (assets.get(asset) ?? 0n) + BigInt(amount));
        // Expiry buckets account for reserved units once, including expiries
        // already visible in virtual balances but not yet materialized.
        for await (const r of writer.base.view.createReadStream({gte:'v/',lt:'v0'})) add(r.key.split('/')[2], r.value);
        for await (const r of writer.base.view.createReadStream({gte:'e/',lt:'e0'})) for(const [,amount] of r.value) add(r.key.split('/')[2], amount);
        for await (const r of writer.base.view.createReadStream({gte:'l/',lt:'l0'})) if(r.value?.assets) for(const [asset,amount] of r.value.assets) add(asset,amount);
        return Object.fromEntries([...assets].map(([asset,n])=>[asset,n.toString()]));
      },
      kitContext: () => kit.context(),
      kitSubmit: async packet => { await connect(); return kit.submit(packet); },
      kitStatus: tx => kit.transactionStatus(tx),
      hashAt: h => api.dmwHashAt(h),
      // Console players and bots sit in players/; kit runs keep their own signers in players/agents/.
      fund: async () => {
        for(const name of await readdir(config.players)) {
          if(name==='agents') { for(const agent of await readdir(join(config.players,name))) await fundPlayer(join(config.players,name,agent)); }
          else await fundPlayer(join(config.players,name));
        }
        return true;
      },
      fundAgent: async name => { check(typeof name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name),'agent_name'); await fundPlayer(join(config.players,'agents',name)); return true; },
      deployment: () => ({ ...dmw, admin: dmw.admin ?? indexer.wallet.publicKey.toString('hex'), registration }),
      read: async (key, at) => { check((await api.dmwHead()).counted === at.counted && rules.stableJSON(await api.dmwBatchLast()) === rules.stableJSON(at.last), 'snapshot_changed'); return row(key); },
      head: () => api.dmwHead(), authority: () => api.dmwAuthority(), batchLast: () => api.dmwBatchLast(), settings: () => api.dmwSettings(),
      balance: (owner, asset) => api.dmwBalance(owner, asset), pending: id => api.dmwMint(id), agentAddress: id => api.dmwAgentAddress(id),
      paymentUsed: key => row('pay/' + key),
      record: key => api.dmwRecord(key), root: n => api.dmwBatchRoot(n),
      nonceUsed: async (owner, nonce) => { const n = await api.dmwAgentNumber(owner); return n ? !!await row(`rq/n/${n}/${nonce}`) : false; },
      acceptance: async id => { await sync(); return events.get('acceptances', id) ?? null; },
      exit: async id => { await sync(); return events.get('exits', id) ?? null; },
      hold: async (asset, block) => { await sync(); return liveHold(events, api, asset, block); },
      stamp: async () => { const head = await api.dmwHead(); return { counted: head.counted, tip: head.tip.height, tipHash: head.tip.hash, revision: writer.base.view.version, last: await api.dmwBatchLast() }; },
      headers: headers => relayHeaders(headers, { connect, admin, row, api, until }),
      prepareMessage: (...args) => transport.prepareMessage(...args),
      sendMessage: async (...args) => { await connect(); await transport.sendMessage(...args); return true; },
      prepareTransaction: (...args) => transport.prepareTransaction(...args),
      sendTransaction: async (...args) => { await connect(); return transport.sendTransaction(...args); },
      status: (...args) => transport.status(...args)
    };
    server = createServer(async (req, res) => {
      try {
        check(req.method === 'POST' && req.headers.authorization === `Bearer ${config.token}`, 'unauthorized', 401);
        let text = ''; for await (const part of req) { text += part; check(Buffer.byteLength(text) <= 4_000_000, 'body_limit', 413); }
        const { method, args } = JSON.parse(text); check(Object.hasOwn(methods, method) && Array.isArray(args), 'rpc_method');
        const result = await methods[method](...args); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: result ?? null }));
      } catch (e) { console.error(e); res.writeHead(e.status ?? 503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: /^[a-z][a-z0-9_]{0,80}$/.test(e.message) ? e.message : 'local_trac_error' })); }
    });
    await new Promise(resolve => server.listen(config.listen.port, config.listen.host, resolve));
    await atomicWrite(config.status, JSON.stringify({ pid: process.pid, directory: network.root, endpoint: `http://127.0.0.1:${server.address().port}` }));
    return { close, methods };
  } catch (e) { await close(); throw e; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const instance = await startTrac(JSON.parse(await readFile(process.argv[2], 'utf8')));
  let closing = false; const close = () => { if (closing) return; closing = true; void instance.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
