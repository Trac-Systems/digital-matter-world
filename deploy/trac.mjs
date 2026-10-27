import { tracBootstrap } from './trac-bootstrap.mjs';
import { bitcoin } from '../local/common.mjs';
import { relayHeaders } from '../service/local/relay.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { localNetwork, until } from '../contract/tests/helpers/local-network.mjs';
import { controls } from '../contract/runtime/control.js';
import { REGTEST_PARAMS } from '../contract/beacon/bitcoin.js';
import { runtimeTransport } from '../service/src/transport.mjs';
import { Store } from '../service/src/store.mjs';
import { rules } from '../service/src/rules.mjs';
import { check, diskCheck, atomicWrite, serial, hash } from '../service/src/util.mjs';
import { localURL } from '../service/src/config.mjs';
import { jsonRequest } from '../service/src/http-client.mjs';

export function tracClient(endpoint, token) {
  localURL(endpoint);
  return async (method, args = []) => {
    const r = await jsonRequest(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method, args }), timeout: 45000 });
    const body = r.value; check(r.ok && !body.error, body.error ?? 'trac_unavailable', 503); return body.result;
  };
}
export const holdKey = (asset, block) => hash(JSON.stringify([asset, block]));
export async function liveHold(events, api, asset, block) {
  const saved = events.get('liveHolds', holdKey(asset, block)); if (!saved) return null;
  const current = await api.dmwMint(saved.id), counted = (await api.dmwHead()).counted;
  if (!current || current.s !== 0 || current.asset !== asset || current.block !== block || counted > current.e) return null;
  return { id: saved.id, expiry: current.e };
}
export async function startTrac(config) {
  await diskCheck(); check(config.listen.host === '127.0.0.1', 'local_listener');
  const network = await localNetwork({ directory: config.directory, cleanup: false });
  let events, server;
  const close = async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await events?.close(); await network.close(); };
  try {
    const validator = await network.msb(), bus = await network.client(validator), genesis = rules.parseHeader(config.genesis);
    const dmw = { network: config.network, admin: config.admin, committee: config.committee, beacon: { checkpoint: config.checkpoint, params: REGTEST_PARAMS } };
    check(config.checkpoint.height === 2016 && config.checkpoint.hash === genesis.hash, 'checkpoint_binding');
    const indexer = await network.peer('indexer', bus, null, { dmw }), writer = await network.peer('writer', bus, indexer.base.key.toString('hex'), { dmw });
    await network.fund(validator, indexer.wallet); await network.fund(validator, writer.wallet);
    const { admin, registration } = await tracBootstrap({ indexer, writer, bus, deployment: dmw, mode: 'regtest' });
    const api = writer.protocol.instance.api, transport = runtimeTransport(writer, bus, { installFanout: false });
    events = await Store.open(join(network.root, 'events')); const gate = serial();
    const row = async key => (await writer.base.view.get(key))?.value ?? null;
    const sync = () => gate(async () => {
      await writer.base.update(); const end = writer.base.view.version;
      let counted = events.get('meta', 'counted') ?? 0;
      const changes = [], pending = new Map();
      for await (const r of writer.base.view.createHistoryStream({ gte: events.get('meta', 'cursor') ?? 0, lt: end })) {
        if (r.key === 'b/cnt' && r.type !== 'del') counted = r.value;
        if (/^m\/[0-9a-f]{64}$/.test(r.key)) {
          const id = r.key.slice(2), old = pending.get(id) ?? events.get('originalPending', id);
          if (r.type !== 'del' && r.value.s === 0 && Object.hasOwn(r.value, 'block')) { changes.push({ space: 'liveHolds', id: holdKey(r.value.asset, r.value.block), value: { id } }); pending.set(id, r.value); }
          else if (old && Object.hasOwn(old, 'block')) changes.push({ space: 'liveHolds', id: holdKey(old.asset, old.block) });
          if (r.type !== 'del' && r.value.s === 0) changes.push({ space: 'acceptances', id, value: { id, created: counted, expiry: r.value.e } }, { space: 'originalPending', id, value: r.value });
          if (r.type === 'del') changes.push({ space: 'exits', id, value: { op: 'rx', height: counted } });
          else if (r.value.s === 1) changes.push({ space: 'exits', id, value: { op: 'rl', height: counted, inscription: r.value.inscription } });
        }
      }
      if (changes.length || (events.get('meta', 'cursor') ?? 0) !== end) await events.transact([...changes, { space: 'meta', id: 'counted', value: counted }, { space: 'meta', id: 'cursor', value: end }]);
    });
    const connect = async () => { if (!bus.network.validatorConnectionManager.connectionCount()) { await bus.network.tryConnect(validator.wallet.publicKey.toString('hex'), 'validator'); await until(() => bus.network.validatorConnectionManager.connectionCount() > 0, 'validator connection'); } };
    const methods = {
      deployment: () => ({ ...dmw, hostAdmin: indexer.wallet.publicKey.toString('hex'), registration }),
      hashAt: height => api.dmwHashAt(height), lock: id => api.dmwLock(id),
      bitcoinHeader: hash => bitcoin(config.manifest, 'getblockheader', [hash, false]),
      bitcoinHash: height => bitcoin(config.manifest, 'getblockhash', [height]),
      bitcoinHeight: () => bitcoin(config.manifest, 'getblockcount'),
      read: async (key, at) => { check((await api.dmwHead()).counted === at.counted && rules.stableJSON(await api.dmwBatchLast()) === rules.stableJSON(at.last), 'snapshot_changed'); return row(key); },
      head: () => api.dmwHead(), authority: () => api.dmwAuthority(), batchLast: () => api.dmwBatchLast(), settings: () => api.dmwSettings(),
      balance: (owner, asset) => api.dmwBalance(owner, asset), pending: id => api.dmwMint(id), agentAddress: id => api.dmwAgentAddress(id),
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
        const publicRead = req.url === '/public';
        check(req.method === 'POST' && (publicRead || req.headers.authorization === `Bearer ${config.token}`), 'unauthorized', 401);
        let text = ''; for await (const part of req) { text += part; check(Buffer.byteLength(text) <= 4_000_000, 'body_limit', 413); }
        const { method, args } = JSON.parse(text); check(Object.hasOwn(methods, method) && Array.isArray(args), 'rpc_method');
        if (publicRead) check(['authority', 'head', 'hashAt', 'balance', 'settings', 'lock', 'pending', 'batchLast', 'root', 'record', 'bitcoinHeader', 'bitcoinHash', 'bitcoinHeight'].includes(method), 'read_only', 403);
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
