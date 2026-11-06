import { AsyncLocalStorage } from 'node:async_hooks';
import { snapshotMemo } from './snapshot-memo.mjs';
import { rules } from './rules.mjs';
import { check } from './util.mjs';

const present = value => value !== null && value !== undefined && value !== false &&
  value?.ready !== false && value?.accepted !== false && value?.fail !== true &&
  value?.confirmations !== 0 && value?.confirmations !== '0' && (!Array.isArray(value) || value.length > 0);
// Preserve optional arguments: canonical wire JSON intentionally rejects
// undefined, and collapsing it to null could alias different source calls.
const keyOf = value => value === undefined ? 'u' : value === null ? 'n' : Array.isArray(value) ?
  'a[' + value.map(keyOf).join(',') + ']' : typeof value === 'object' ?
    'o{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + keyOf(value[key])).join(',') + '}' :
    typeof value + ':' + JSON.stringify(value);
const matches = (at, stamp) => !at || rules.compareOrdinal(at.counted, stamp.counted) === 0 &&
  rules.stableJSON(at.last) === rules.stableJSON(stamp.last) &&
  (at.tip === undefined || rules.compareOrdinal(at.tip, stamp.tip) === 0) &&
  ['revision', 'tipHash'].every(key => at[key] === undefined || at[key] === stamp[key]);

// One independent reader owns these caches. Batch-local financial records are
// deliberately excluded: a later step must observe every preceding effect.
export function installFinancialReadScope(reads) {
  if (reads.withFinancialSnapshot) return;
  const context = new AsyncLocalStorage(), batchStamp = reads.batchStamp;
  const stamp = () => batchStamp.call(reads);
  const snapshots = snapshotMemo({ limit: 2048, cacheable: present });
  const immutable = snapshotMemo({ ttlMs: 300000, limit: 512, cacheable: present });
  const invalidate = () => { snapshots.clear(); immutable.clear(); };
  const current = () => { const scope = context.getStore(); return scope?.active ? scope : null; };
  reads.financialSnapshot = () => current()?.at;
  const scopedStamp = () => current() ? Promise.resolve(current().at) : stamp();
  reads.batchStamp = scopedStamp;
  const freshStamp = () => reads.batchStamp === scopedStamp ? stamp() : context.exit(() => reads.batchStamp());
  reads.memoFinancialRead = async (name, args, read, at = current()?.at) => {
    // An explicit, complete snapshot is required for persistent source reuse.
    if (!at || at.counted === undefined || !at.tipHash || !Object.hasOwn(at, 'last')) return read();
    const key = keyOf([name, args, at]);
    return structuredClone(await snapshots(key, read));
  };
  if (reads.content) {
    const read = reads.content;
    reads.content = async (...args) => structuredClone(await immutable(keyOf(['content', args]), () => read(...args)));
  }
  const settingsRead = (read, error = 'financial_settings_history') => hash => {
    const load = async () => { const value = await read(hash); if (value) check(rules.hashObject(value) === hash, error); return value; };
    return current() ? reads.memoFinancialRead('settingsByHash', [hash], load) : load();
  };
  if (reads.settingsByHash) reads.settingsByHash = settingsRead(reads.settingsByHash);
  const history = reads.feeQuotes?.settingsHistory;
  if (history?.get) reads.feeQuotes.settingsHistory = { get: settingsRead(history.get.bind(history), 'fee_settings_history') };
  // These source methods do not inspect the simulation overlay. All arguments,
  // including execution height, remain part of the key. Asset contexts also
  // consult local admissions, so rebuild them rather than retaining that state.
  for (const name of ['tap', 'included', 'privilegeAuthority', 'element', 'paymentTransfers', 'mintedInscription',
    'rulesContext', 'publicMintHeader', 'publicBitcoinHash', 'publicBitcoinBlock']) if (reads[name]) {
    const read = reads[name];
    reads[name] = (...args) => current() && (reads.withTapReadSnapshot || ['rulesContext', 'publicMintHeader', 'publicBitcoinHash', 'publicBitcoinBlock'].includes(name)) ?
      reads.memoFinancialRead(name, args, () => read(...args)) : read(...args);
  }
  reads.withFinancialSnapshot = async (at, task) => {
    const nested = current();
    if (nested) {
      check(matches(at, nested.at), 'financial_snapshot_changed');
      try { return await task(nested.at); } catch (error) { invalidate(); throw error; }
    }
    const before = await freshStamp();
    check(matches(at, before), 'financial_snapshot_changed');
    const scope = { at: before, active: true };
    try {
      const runTask = () => context.run(scope, () => task(before));
      const run = () => reads.withNotaryReadSnapshot ? reads.withNotaryReadSnapshot(before, runTask) : runTask();
      const result = reads.withTapReadSnapshot ? await reads.withTapReadSnapshot(before, run) : await run();
      check(rules.stableJSON(before) === rules.stableJSON(await freshStamp()), 'financial_snapshot_changed');
      return result;
    } catch (error) {
      // A failed closing fence must not publish any speculative source result.
      invalidate();
      throw error;
    } finally { scope.active = false; }
  };
}
