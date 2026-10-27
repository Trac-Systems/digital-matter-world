import { pathToFileURL } from 'node:url';
import { readPrivateJSON } from './config.mjs';
import { requireValue as check } from './http.mjs';
import { runtimeTransport } from '../src/transport.mjs';
import { serial, hash } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';
import { MAINNET_PARAMS } from '../../contract/beacon/bitcoin.js';
import { installValidatorFanout } from './runtime.mjs';
import { msbIdentity } from './mainnet.mjs';
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);

export async function openRuntime(config) {
  const module = await import(config.runtimeModule ? pathToFileURL(config.runtimeModule).href : './runtime.mjs');
  check(typeof module.openRuntime === 'function', 'trac_runtime_interface');
  return module.openRuntime({ configFile: config.runtimeConfig });
}
export async function createTrac({ runtime, config, deployment, store, network }) {
  const { peer, bus } = runtime, api = peer?.protocol?.instance?.api;
  check(api && peer.config.dmw.network === network && same(peer.config.dmw, deployment) && same(deployment.beacon.params, MAINNET_PARAMS), 'trac_deployment');
  check(peer.base.key.toString('hex') === config.bootstrap && msbIdentity(bus).bootstrapHex === config.msbBootstrap && String(msbIdentity(bus).networkId) === String(config.networkId), 'trac_network');
  check((await api.dmwAuthority()).network === network, 'trac_authority');
  const binding = hash(rules.stableJSON({ config: { bootstrap: config.bootstrap, msbBootstrap: config.msbBootstrap, networkId: config.networkId }, deployment }));
  check(!store.get('prodTrac', 'binding') || store.get('prodTrac', 'binding') === binding, 'trac_store_binding');
  await store.put('prodTrac', 'binding', binding);
  const gate = serial(), raw = async key => (await peer.base.view.get(key))?.value ?? null;
  const stamp = async () => { await peer.base.update(); const revision = peer.base.view.version, head = await api.dmwHead(), last = await api.dmwBatchLast(); check(revision === peer.base.view.version, 'trac_snapshot_changed'); return { counted: head.counted, tip: head.tip.height, tipHash: head.tip.hash, revision, last }; };
  const pinned = async (at, read) => { const before = await stamp(); if (at) check(before.counted === at.counted && same(before.last, at.last), 'trac_snapshot_changed'); const result = await read(); check(same(before, await stamp()), 'trac_snapshot_changed'); return result; };
  const sync = () => gate(async () => {
    await peer.base.update(); const end = peer.base.view.version, cursor = store.get('prodTrac', 'cursor') ?? 0;
    check(end >= cursor, 'trac_history_rewound');
    let counted = store.get('prodTrac', 'counted') ?? deployment.beacon.checkpoint.height, next = cursor, changes = [];
    const original = new Map();
    for await (const r of peer.base.view.createHistoryStream({ gte: cursor, lt: end })) {
      if (r.key === 'b/cnt' && r.type !== 'del') counted = r.value;
      if (/^m\/[0-9a-f]{64}$/.test(r.key)) {
        const id = r.key.slice(2), old = original.has(id) ? original.get(id) : store.get('prodOriginalPending', id);
        if (r.type !== 'del' && r.value.s === 0) {
          check(!old || same(Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'h')), Object.fromEntries(Object.entries(r.value).filter(([k]) => k !== 'h'))), 'trac_pending_changed');
          if (!old) changes.push({ space: 'prodAcceptances', id, value: { id, created: counted, expiry: r.value.e } }, { space: 'prodOriginalPending', id, value: r.value });
          original.set(id, r.value);
          if (Object.hasOwn(r.value, 'block')) changes.push({ space: 'prodHolds', id: hash(JSON.stringify([r.value.asset, r.value.block])), value: { id } });
        } else {
          if (r.type === 'del' && old && Object.hasOwn(old, 'block')) {
            const key = hash(JSON.stringify([old.asset, old.block]));
            const latest = changes.findLast(c => c.space === 'prodHolds' && c.id === key)?.value ?? store.get('prodHolds', key);
            if (latest?.id === id) changes.push({ space: 'prodHolds', id: key });
          }
          changes.push({ space: 'prodExits', id, value: r.type === 'del' ? { op: 'rx', height: counted } : { op: 'mc', height: counted, permitHash: r.value.permitHash } });
        }
      }
      next = r.seq + 1;
      if (changes.length >= 512) { check(Number.isSafeInteger(next), 'trac_history_sequence'); await store.transact([...changes, { space: 'prodTrac', id: 'counted', value: counted }, { space: 'prodTrac', id: 'cursor', value: next }]); changes = []; original.clear(); }
    }
    await store.transact([...changes, { space: 'prodTrac', id: 'counted', value: counted }, { space: 'prodTrac', id: 'cursor', value: end }]);
  });
  installValidatorFanout(bus.network);
  const transport = runtimeTransport(peer, bus, { installFanout: false });
  const enoughValidators = () => check(new Set(bus.network.validatorConnectionManager.connectedValidators()).size >= 3, 'trac_three_validators_required');
  const methods = {
    deployment: () => deployment,
    head: () => api.dmwHead(), authority: () => api.dmwAuthority(), batchLast: () => api.dmwBatchLast(), settings: () => api.dmwSettings(),
    read: (key, at) => pinned(at, () => raw(key)),
    balance: (owner, asset, at) => pinned(at, () => api.dmwBalance(owner, asset)), pending: (id, at) => pinned(at, () => api.dmwMint(id)),
    paymentUsed: key => raw('pay/' + key),
    agentAddress: id => api.dmwAgentAddress(id), record: key => api.dmwRecord(key), root: n => api.dmwBatchRoot(n), hashAt: n => api.dmwHashAt(n),
    nonceUsed: (owner, nonce, at) => pinned(at, async () => { const n = await api.dmwAgentNumber(owner); return n ? !!await raw(`rq/n/${n}/${nonce}`) : false; }),
    acceptance: async id => { await sync(); return store.get('prodAcceptances', id); }, exit: async id => { await sync(); return store.get('prodExits', id); },
    hold: (asset, block, at) => pinned(at, async () => { await sync(); const saved = store.get('prodHolds', hash(JSON.stringify([asset, block]))); if (!saved) return null; const pending = await api.dmwMint(saved.id), h = await api.dmwHead(); return pending && (pending.h || pending.s === 0 && h.counted <= pending.e) && pending.asset === asset && pending.block === block ? { id: saved.id, expiry: pending.h ? Number.MAX_SAFE_INTEGER : pending.e } : null; }),
    stamp,
    // Agents relay headers into the beacon. This reader never substitutes the
    // Bitcoin source's raw height for the contract's monotone counted clock.
    headers: async raws => { check(Array.isArray(raws) && raws.length > 0 && raws.length <= 20, 'trac_headers'); const accepted = rules.parseHeader(raws.at(-1)).hash; check(await raw('b/r/' + accepted), 'trac_header_not_relayed'); return { ...await api.dmwHead(), accepted }; },
    prepareMessage: (...args) => transport.prepareMessage(...args), prepareTransaction: (...args) => transport.prepareTransaction(...args),
    sendMessage: (...args) => transport.sendMessage(...args),
    sendTransaction: async prepared => { enoughValidators(); return transport.sendTransaction(prepared); },
    status: async job => { await peer.base.update(); const result = await transport.status(job); if (job.transaction) { const confirmed = await bus.getConfirmedTxInfo(job.transaction.tx); return { ...result, msb: confirmed === null ? 'pending' : 'confirmed' }; } return result; }
  };
  const call = async (method, args = []) => { check(Object.hasOwn(methods, method), 'trac_method'); return methods[method](...args); };
  call.close = () => runtime.close?.(); call.methods = methods; return call;
}
export async function configuredTrac(config, store, runtime) {
  const deployment = await readPrivateJSON(config.prod.deployment);
  const active = runtime ?? await openRuntime(config.prod.trac);
  try { return await createTrac({ runtime: active, config: config.prod.trac, deployment, store, network: config.network }); }
  catch (e) { await active.close?.(); throw e; }
}
