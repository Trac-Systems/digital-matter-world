import { AsyncLocalStorage } from 'node:async_hooks';
import { rules } from '../src/rules.mjs';
import { check } from '../src/util.mjs';

const same = (a, b) => a === undefined || b === undefined ? a === b : rules.stableJSON(a) === rules.stableJSON(b);
const matches = (at, before) => !at || ['counted', 'tip'].every(key => at[key] === undefined || rules.compareOrdinal(at[key], before[key]) === 0) &&
  ['tipHash', 'last', 'revision', 'batchRoot', 'authority', 'admissionPolicy']
  .every(key => at[key] === undefined || same(at[key], before[key]));

// Point reads share one immutable notary checkout inside a financial pass.
// Fresh opening/closing stamps still fence its complete source identity.
export function financialReadCheckout({ stamp, open }) {
  const storage = new AsyncLocalStorage();
  const current = () => { const scope = storage.getStore(); return scope?.active ? scope : null; };
  return {
    active: () => !!current(),
    async read(key, at) {
      const scope = current(); check(scope && matches(at, scope.before), 'trac_snapshot_changed');
      const pending = Promise.resolve().then(() => scope.view.get(key)); scope.pending.add(pending);
      try { return (await pending)?.value ?? null; } finally { scope.pending.delete(pending); }
    },
    async run(at, task) {
      const nested = current();
      if (nested) { check(matches(at, nested.before), 'trac_snapshot_changed'); return task(); }
      const before = await stamp(at); check(matches(at, before), 'trac_snapshot_changed');
      const view = await open(before.revision), scope = { before, view, active: true, pending: new Set() };
      try {
        const result = await storage.run(scope, task);
        // Gateway admission previews deliberately omit the raw append revision.
        // Keep their full semantic fence while retaining the immutable seek.
        const identity = value => {
          if (at?.revision !== undefined || !at?.admissionPolicy) return value;
          const { revision, ...snapshot } = value; return snapshot;
        };
        check(same(identity(before), identity(await stamp(at))), 'trac_snapshot_changed');
        return result;
      } finally {
        scope.active = false;
        await Promise.allSettled([...scope.pending]);
        await view.close();
      }
    }
  };
}
