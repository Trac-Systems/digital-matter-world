import { AccountBatchOverlay } from './account-batch.mjs';
import { coldOperations, hotState } from './replay-state.mjs';
import { rules } from './rules.mjs';

// A successor sees only its predecessor's proposed writes over accepted storage.
// No speculative state or admission reservation is committed to the live store.
export function successorStore(store, draft) {
  const overlay = new AccountBatchOverlay(store), omitted = new Set(draft.items.map(i => i.observation.id));
  for (const { output } of draft.items) overlay.apply([
    ...coldOperations(output.state), ...(output.accountWrites ?? []), ...(output.namedWrites ?? []), ...(output.claimWrites ?? []),
    ...Object.entries(rules.recordObject(output.state.finds)).map(([id, value]) => ({ space: 'finds', id, value })),
    ...Object.entries(rules.recordObject(output.state.types)).map(([id, value]) => ({ space: 'types', id, value }))
  ]);
  const final = draft.items.at(-1).output;
  overlay.apply([{ space: 'meta', id: 'ruleState', value: hotState(final.state) },
    { space: 'meta', id: 'patterns', value: final.patterns }, { space: 'meta', id: 'namedReservedBatch' }]);
  const view = new Proxy(store, { get(target, key) {
    if (key === 'get') return overlay.get.bind(overlay);
    if (key === 'list') return (space, options = {}) => space === 'observations'
      ? target.list(space, { ...options, limit: (options.limit ?? 256) + omitted.size }).filter(r => !omitted.has(r.id)).slice(0, options.limit ?? 256)
      : target.list(space, options);
    if (key === 'count' || key === 'countUint') return space => {
      const count = BigInt(target.countUint(space)) - (space === 'observations' ? BigInt([...omitted].filter(id => target.get(space, id)).length) : 0n);
      return key === 'countUint' ? String(count) : Number(count);
    };
    if (key === 'hasRows') return space => space === 'observations' ? view.count(space) > 0 : target.hasRows(space);
    if (['put', 'transact', 'compact', 'close'].includes(key)) return () => { throw Error('speculative_store_write'); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { store: view, claimNodes: overlay.spaces.get('claimNodes') ?? new Map(), namedNodes: overlay.spaces.get('namedNodes') ?? new Map() };
}

export function successorMismatch({ predecessor, draft, last, epoch, counted, settings, state, hashAt }) {
  const b = predecessor.proposal.batch, next = draft?.proposal.batch;
  if (!next) return 'missing';
  const checks = {
    sequence: String(next.n) === rules.nextUint(String(b.n)), previous: next.previous === b.root && draft.previousRoot === b.root,
    last: rules.stableJSON(last) === rules.stableJSON({ n: b.n, to: b.to }), epoch: String(epoch) === String(b.epoch),
    execution: String(counted) === String(draft.execution), settings: draft.settings.settingsHash === settings.settingsHash,
    claims: state?.claimRoot === draft.startState.claimRoot, catalog: state?.catalogRoot === draft.startState.catalogRoot,
    accounts: state?.accountRoot === draft.startState.accountRoot,
    branch: draft.items.every(i => hashAt(i.input.tip) === i.input.tipHash && hashAt(i.input.height) === i.input.blockHash)
  };
  return Object.keys(checks).find(key => !checks[key]) ?? null;
}
export const successorMatches = input => successorMismatch(input) === null;
