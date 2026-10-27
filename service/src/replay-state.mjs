import { rules } from './rules.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, hash } from './util.mjs';

// Lifetime indexes live as individual journaled rows. Only keys that the next
// bounded replay can read are materialized in its input snapshot.
export const coldMaps = ['receiptSeals', 'linkPayments', 'links'];
export function coldOperations(state) {
  const ops = [];
  for (const field of coldMaps) for (const [id, value] of Object.entries(rules.recordObject(state[field]))) ops.push({ space: 'replay/' + field, id, value });
  for (const [field, values] of Object.entries(state.mints ?? {})) for (const [id, value] of Object.entries(values)) ops.push({ space: field === 'finished' ? 'mintFinished' : 'replay/mints/' + field, id, value });
  return ops;
}
export function hotState(state) {
  return { ...state, balances: {}, finds: {}, types: {}, usedNonces: {}, receiptSeals: {}, linkPayments: {}, links: {}, mints: {} };
}
export async function archiveState(store, state) {
  const operations = coldOperations(state);
  for (let i = 0; i < operations.length; i += 256) await store.transact(operations.slice(i, i + 256));
  return operations.length;
}
export function hydrateState(store, state, observations) {
  state.receiptSeals ??= {};
  for (const o of observations) {
    const key = `${o.tip}/${o.hash}`, root = store.get('replay/receiptSeals', key);
    if (root) state.receiptSeals[key] = root;
    for (const { value: { move } } of store.list('intake/' + o.id, { limit: 1000 })) if (move.t === 'craft') {
      state.types ??= {};
      for (const [asset] of [...move.p.request.in, ...move.p.request.out]) {
        const type = store.get('types', asset);
        if (type) state.types[asset] = type;
      }
    }
  }
  return state;
}
