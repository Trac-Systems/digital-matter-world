import { relayHeaders } from './relay.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { localNetwork, until } from '../../contract/tests/helpers/local-network.mjs';
import { controls } from '../../contract/runtime/control.js';
import { REGTEST_PARAMS } from '../../contract/beacon/bitcoin.js';
import { runtimeTransport } from '../src/transport.mjs';
import { Store } from '../src/store.mjs';
import { rules } from '../src/rules.mjs';
import { financialInventoryPage } from '../src/financial-inventory.mjs';
import { check, diskCheck, atomicWrite, serial } from '../src/util.mjs';
import { localURL } from '../src/config.mjs';
import { jsonRequest } from '../src/http-client.mjs';

export function tracClient(endpoint, token) {
  localURL(endpoint);
  return async (method, args = []) => {
    const r = await jsonRequest(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method, args }), timeout: 45000 });
    const body = r.value; check(r.ok && !body.error, body.error ?? 'trac_unavailable', 503); return body.result;
  };
}
import { liveHold, mintEventChanges } from './mint-events.mjs';
export { holdKey, liveHold } from './mint-events.mjs';
export async function startTrac(config) {
  await diskCheck(); check(config.listen.host === '127.0.0.1', 'local_listener');
  const network = await localNetwork({ directory: config.directory, cleanup: false });
  let events, server;
  const close = async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await events?.close(); await network.close(); };
  try {
    const validator = await network.msb(), bus = await network.client(validator), genesis = rules.parseHeader(config.genesis);
    const dmw = { network: config.network, committee: config.committee, beacon: { checkpoint: { height: 0, hash: genesis.hash, bits: genesis.bits, time: genesis.time, chainwork: config.genesisWork, times: [genesis.time] }, params: REGTEST_PARAMS } };
    const indexer = await network.peer('indexer', bus, null, { dmw }), writer = await network.peer('writer', bus, indexer.base.key.toString('hex'), { dmw });
    await network.fund(validator, indexer.wallet); await network.fund(validator, writer.wallet);
    const admin = controls(indexer, bus); await admin.setup({ writer: writer.writerLocalKey }); await until(() => writer.base.writable, 'writer admitted');
    const api = writer.protocol.instance.api, transport = runtimeTransport(writer, bus, { installFanout: false });
    events = await Store.open(join(network.root, 'events')); const gate = serial();
    const row = async key => (await writer.base.view.get(key))?.value ?? null;
    const sync = () => gate(async () => {
      await writer.base.update(); const end = writer.base.view.version;
      const { changes, counted } = await mintEventChanges(events, writer.base.view.createHistoryStream({ gte: events.get('meta', 'cursor') ?? 0, lt: end }));
      if (changes.length || (events.get('meta', 'cursor') ?? 0) !== end) await events.transact([...changes, { space: 'meta', id: 'counted', value: counted }, { space: 'meta', id: 'cursor', value: end }]);
    });
    const connect = async () => { if (!bus.network.validatorConnectionManager.connectionCount()) { await bus.network.tryConnect(validator.wallet.publicKey.toString('hex'), 'validator'); await until(() => bus.network.validatorConnectionManager.connectionCount() > 0, 'validator connection'); } };
    const methods = {
      assetSupply: async () => {
        const assets = new Map(), add = (asset, amount) => assets.set(asset, (assets.get(asset) ?? 0n) + BigInt(amount));
        for await (const r of writer.base.view.createReadStream({ gte: 'v/', lt: 'v0' })) add(r.key.split('/')[2], r.value);
        for await (const r of writer.base.view.createReadStream({ gte: 'e/', lt: 'e0' })) for (const [, amount] of r.value) add(r.key.split('/')[2], amount);
        for await (const r of writer.base.view.createReadStream({ gte: 'l/', lt: 'l0' })) if (r.value?.assets) for (const [asset, amount] of r.value.assets) add(asset, amount);
        return Object.fromEntries([...assets].map(([asset, amount]) => [asset, amount.toString()]));
      },
      deployment: () => ({ ...dmw, admin: indexer.wallet.publicKey.toString('hex') }),
      read: async (key, at) => {
        const before = await methods.stamp(); at ??= before;
        check(before.counted === at.counted && rules.stableJSON(before.last) === rules.stableJSON(at.last) &&
          (at.revision === undefined || before.revision === at.revision), 'snapshot_changed');
        const value = await row(key); check(rules.stableJSON(before) === rules.stableJSON(await methods.stamp()), 'snapshot_changed'); return value;
      },
      financialPage: async (range, at) => {
        const before = await methods.stamp();
        check(rules.stableJSON(before) === rules.stableJSON(at), 'snapshot_changed');
        const view = writer.base.view.checkout(before.revision);
        try { return await financialInventoryPage(view, range, (await view.get('s/assets'))?.value?.settings); }
        finally { await view.close(); check(rules.stableJSON(before) === rules.stableJSON(await methods.stamp()), 'snapshot_changed'); }
      },
      head: () => api.dmwHead(), authority: () => api.dmwAuthority(), batchLast: () => api.dmwBatchLast(), settings: () => api.dmwSettings(), rulesContext: () => api.dmwRulesContext(), settingsByHash: hash => api.dmwSettingsByHash(hash),
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
      } catch (e) { res.writeHead(e.status ?? 503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: /^[a-z][a-z0-9_]{0,80}$/.test(e.message) ? e.message : 'local_trac_error' })); }
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
