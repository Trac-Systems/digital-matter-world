import { pathToFileURL } from 'node:url';
import { readPrivateJSON } from './config.mjs';
import { requireValue as check } from './http.mjs';
import { runtimeTransport } from '../src/transport.mjs';
import { serial, hash } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';
import { financialInventoryPage } from '../src/financial-inventory.mjs';
import { MAINNET_PARAMS } from '../../contract/beacon/bitcoin.js';
import { installValidatorFanout } from './runtime.mjs';
import { msbIdentity } from './mainnet.mjs';
import { isApplicationNotaryKey } from '../../contract/runtime/notary-records.js';
import { lifecycleSignal, abortable } from '../src/lifecycle.mjs';
import { pointBatch, pointResults } from '../../rules/src/point-read-batch.js';
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
export const tracBinding = (config, deployment) => hash(rules.stableJSON({ config: {
  bootstrap: config.bootstrap, msbBootstrap: config.msbBootstrap, networkId: config.networkId }, deployment }));

export async function openRuntime(config) {
  const module = await import(config.runtimeModule ? pathToFileURL(config.runtimeModule).href : './runtime.mjs');
  check(typeof module.openRuntime === 'function', 'trac_runtime_interface');
  return module.openRuntime({ configFile: config.runtimeConfig });
}
export async function createTrac({ runtime, config, deployment, store, network }) {
  const signal = lifecycleSignal();
  const { peer, bus } = runtime, api = peer?.protocol?.instance?.api;
  check(api && peer.config.dmw.network === network && same(peer.config.dmw, deployment) && same(deployment.beacon.params, MAINNET_PARAMS), 'trac_deployment');
  check(peer.base.key.toString('hex') === config.bootstrap && msbIdentity(bus).bootstrapHex === config.msbBootstrap && String(msbIdentity(bus).networkId) === String(config.networkId), 'trac_network');
  check((await abortable(api.dmwAuthority(), signal)).network === network, 'trac_authority');
  let progressSpace = 'prodTrac';
  if (deployment.v2) {
    const manifest = rules.activationManifest(deployment.v2.manifest, deployment.v2.manifestHash), active = await abortable(api.dmwRulesContext(), signal);
    check(manifest.network === network && manifest.route === 'terminal-import' && active?.ready && active.manifestHash === deployment.v2.manifestHash, 'trac_activation_binding');
    // A new notary has a new view revision and deployment binding. Preserve
    // the legacy checkpoint; never reuse its cursor against the imported log.
    progressSpace = 'prodTracV2/' + deployment.v2.manifestHash;
  }
  const binding = tracBinding(config, deployment);
  signal?.throwIfAborted();
  check(!store.get(progressSpace, 'binding') || store.get(progressSpace, 'binding') === binding, 'trac_store_binding');
  await store.put(progressSpace, 'binding', binding);
  const gate = serial(), raw = async key => (await peer.base.view.get(key))?.value ?? null;
  const clock = rules.ordinalCodec(!!deployment.v2);
  const sourceVersion = () => clock.value(rules.decimalV2(peer.base.view.version));
  // Decimal-capable sources receive exact strings. Existing Hyperbee sources
  // still require a numeric seek; refuse beyond that adapter's capability.
  const sourceSeek = value => typeof peer.base.view.version === 'string' ? rules.decimalV2(value) : rules.safeNumberV2(rules.decimalV2(value));
  const stamp = async () => { await peer.base.update(); const revision = sourceVersion(), head = await api.dmwHead(), last = await api.dmwBatchLast(); check(revision === sourceVersion(), 'trac_snapshot_changed'); return { counted: head.counted, tip: head.tip.height, tipHash: head.tip.hash, revision, last }; };
  // Read the gateway's complete financial clock from one immutable checkout.
  // Retain its raw seek internally for readMany; it is not a liveness fence.
  const financialSnapshot = async () => {
    await peer.base.update(); const revision = sourceVersion();
    return peer.protocol.instance.withView(async state => {
      const head = await state.head(), last = await state.batchLast();
      return { counted: head.counted, tip: head.tip.height, tipHash: head.tip.hash, last, revision,
        batchRoot: await state.get('bt/' + last.n) ?? null,
        authority: { network: state.options.network, admin: await state.admin(), committee: await state.committee(),
          epoch: await state.committeeEpoch(), paused: await state.paused(), pauseUntil: (await state.get('ad/pause'))?.until ?? null },
        admissionPolicy: { ready: !!await state.get('v2/ready'), settingsHash: rules.hashObject(await state.get('v2/settings')),
          scheduledSettingsHash: rules.hashObject(await state.get('v2/settings-next') ?? null) } };
    });
  };
  // Pin reads to the batch clock (counted, tip, last). The raw subnet version also moves on
  // unrelated appends, which made every long prepare fail on a live network.
  const batchClock = s => ({ counted: s.counted, tip: s.tip, tipHash: s.tipHash, last: s.last });
  const pinned = async (at, read) => {
    // Only the explicit gateway preview stamp lacks revision and has policy.
    // Ordinary and signer reads continue to acquire their original strict stamp.
    const snapshot = at?.revision === undefined && at?.admissionPolicy ? financialSnapshot : stamp;
    const before = await snapshot(); if (at) check(clock.compare(before.counted, rules.decimalV2(at.counted)) >= 0 && same(before.last, at.last), 'trac_snapshot_changed');
    const result = await read(before); check(same(batchClock(before), batchClock(await snapshot())), 'trac_snapshot_changed'); return result;
  };
  const sync = () => gate(async () => {
    await abortable(peer.base.update(), signal); signal?.throwIfAborted();
    const end = sourceVersion(), cursor = clock.value(rules.decimalV2(store.get(progressSpace, 'cursor') ?? 0));
    check(clock.compare(end, cursor) >= 0, 'trac_history_rewound');
    let counted = store.get(progressSpace, 'counted') ?? deployment.beacon.checkpoint.height, next = cursor, changes = [];
    const original = new Map();
    for await (const r of peer.base.view.createHistoryStream({ gte: sourceSeek(cursor), lt: sourceSeek(end) })) {
      signal?.throwIfAborted();
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
      next = clock.add(r.seq);
      if (changes.length >= 512) { await store.transact([...changes, { space: progressSpace, id: 'counted', value: counted }, { space: progressSpace, id: 'cursor', value: next }]); changes = []; original.clear(); }
    }
    signal?.throwIfAborted();
    await store.transact([...changes, { space: progressSpace, id: 'counted', value: counted }, { space: progressSpace, id: 'cursor', value: end }]);
  });
  installValidatorFanout(bus.network);
  const transport = runtimeTransport(peer, bus, { installFanout: false });
  const enoughValidators = () => check(new Set(bus.network.validatorConnectionManager.connectedValidators()).size >= 3, 'trac_three_validators_required');
  const methods = {
    deployment: () => deployment,
    head: () => api.dmwHead(), authority: () => api.dmwAuthority(), batchLast: () => api.dmwBatchLast(), settings: () => api.dmwSettings(),
    rulesContext: () => api.dmwRulesContext(),
    terminalWatermark: async () => {
      check(deployment.v2 && runtime.barrier, 'trac_terminal_barrier_required');
      return runtime.barrier.synchronize();
    },
    renewalSlice: n => api.dmwReceiptRenewalSlice(n),
    settingsByHash: hash => api.dmwSettingsByHash(hash),
    read: (key, at) => pinned(at, () => raw(key)),
    readMany: (keys, at) => {
      pointBatch(keys);
      return pinned(at, async before => {
        const view = peer.base.view.checkout(sourceSeek(before.revision));
        try {
          const rows = await pointResults(keys, async key => (await view.get(key))?.value ?? null);
          return rows.map(row => { if (row.error) throw Error(row.error); return row.value; });
        } finally { await view.close(); }
      });
    },
    financialPage: (range, at) => pinned(at, async () => {
      const view = peer.base.view.checkout(sourceSeek(at.revision));
      try { return await financialInventoryPage(view, range, (await view.get('s/assets'))?.value?.settings); }
      finally { await view.close(); }
    }),
    balance: (owner, asset, at) => pinned(at, () => api.dmwBalance(owner, asset)), pending: (id, at) => pinned(at, () => api.dmwMint(id)),
    paymentUsed: key => raw('pay/' + key),
    agentAddress: id => api.dmwAgentAddress(id), record: key => api.dmwRecord(key), root: n => api.dmwBatchRoot(n), hashAt: n => api.dmwHashAt(n),
    nonceUsed: (owner, nonce, at) => pinned(at, async () => { const n = await api.dmwAgentNumber(owner); return n ? !!await raw(`rq/n/${n}/${nonce}`) : false; }),
    acceptance: async id => { await sync(); return store.get('prodAcceptances', id); }, exit: async id => { await sync(); return store.get('prodExits', id); },
    hold: (asset, block, at) => pinned(at, async () => { await sync(); const saved = store.get('prodHolds', hash(JSON.stringify([asset, block]))); if (!saved) return null; const pending = await api.dmwMint(saved.id), h = await api.dmwHead(); return pending && (pending.h || pending.s === 0 && h.counted <= pending.e) && pending.asset === asset && pending.block === block ? { id: saved.id, expiry: pending.h ? Number.MAX_SAFE_INTEGER : pending.e } : null; }),
    stamp,
    // Gateway quote/admission only. A checkout makes stamp acquisition atomic
    // even if the live view advances during these reads. Signers still use stamp.
    financialPreviewStamp: async () => {
      const { revision, ...at } = await financialSnapshot(); return at;
    },
    migrationSnapshot: async () => {
      const at = await stamp(), view = peer.base.view.checkout(sourceSeek(at.revision)), records = [];
      try {
        for await (const { key, value } of view.createReadStream()) if (isApplicationNotaryKey(key)) records.push([key, value]);
        records.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        check(same(at, await stamp()), 'trac_snapshot_changed');
        return { options: deployment, records, revision: at.revision };
      } finally { await view.close(); }
    },
    // Agents relay headers into the beacon. This reader never substitutes the
    // Bitcoin source's raw height for the contract's monotone counted clock.
    headers: async raws => { check(Array.isArray(raws) && raws.length > 0 && raws.length <= 20, 'trac_headers'); const accepted = rules.parseHeader(raws.at(-1)).hash; check(await raw('b/r/' + accepted), 'trac_header_not_relayed'); return { ...await api.dmwHead(), accepted }; },
    prepareMessage: (...args) => transport.prepareMessage(...args), prepareTransaction: (...args) => transport.prepareTransaction(...args),
    sendMessage: (...args) => transport.sendMessage(...args),
    sendTransaction: async prepared => { enoughValidators(); return transport.sendTransaction(prepared); },
    status: async job => { await peer.base.update(); const result = await transport.status(job); if (job.transaction) { const confirmed = await bus.getConfirmedTxInfo(job.transaction.tx); return { ...result, msb: confirmed === null ? 'pending' : 'confirmed' }; } return result; }
  };
  const call = async (method, args = []) => {
    // A bare string would be spread into characters and silently miss.
    check(Array.isArray(args), 'trac_arguments');
    signal?.throwIfAborted(); check(Object.hasOwn(methods, method), 'trac_method');
    return abortable(methods[method](...args), signal);
  };
  call.close = () => runtime.close?.(); call.methods = methods; return call;
}
export async function configuredTrac(config, store, runtime) {
  const deployment = await readPrivateJSON(config.prod.deployment);
  const active = runtime ?? await openRuntime(config.prod.trac);
  try { return await createTrac({ runtime: active, config: config.prod.trac, deployment, store, network: config.network }); }
  catch (e) { await active.close?.(); throw e; }
}
