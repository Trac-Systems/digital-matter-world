import { validateChosenTicker } from '../../rules/src/ticker-names.js';
import { check, serial } from './util.mjs';

// All service helpers take the indexed TAP ticker, so ordinary compound tokens
// and DMT tokens retain their separate namespaces.
export function indexedTicker(tick) {
  check(typeof tick === 'string', 'ticker_invalid');
  const lower = tick.toLowerCase();
  return lower.startsWith('dmt-') ? 'dmt-' + validateChosenTicker(tick.slice(4)) : validateChosenTicker(tick);
}
export async function tickerAvailable(reads, tick) {
  tick = indexedTicker(tick);
  check(typeof reads?.tap === 'function', 'tap_ticker_lookup_required');
  const row = await reads.tap('getDeployment/' + encodeURIComponent(tick));
  // Only the adapter's explicit absence value is evidence of availability.
  if (row === null) return true;
  check(row && typeof row.tick === 'string' && row.tick.toLowerCase() === tick && typeof row.ins === 'string' && row.ins.length,
    'ticker_lookup_binding');
  return false;
}

// Store enforces a single durable writer. Share the admission queue across all
// callers using that writer, including distinct provisioning service instances.
const gates = new WeakMap();
function gate(store) {
  if (!gates.has(store)) gates.set(store, serial());
  return gates.get(store);
}
const space = 'tickerReservations';
export function reserveTicker(store, tick, requestId) {
  tick = indexedTicker(tick);
  check(typeof requestId === 'string' && requestId.length > 0, 'ticker_request');
  return gate(store)(async () => {
    const old = store.get(space, tick);
    check(!old || old.requestId === requestId, 'ticker_reserved', 409);
    if (!old) await store.put(space, tick, { requestId });
    return true;
  });
}
export function releaseTicker(store, tick, requestId) {
  tick = indexedTicker(tick);
  check(typeof requestId === 'string' && requestId.length > 0, 'ticker_request');
  return gate(store)(async () => {
    const old = store.get(space, tick);
    if (!old || old.requestId !== requestId) return false;
    await store.transact([{ space, id: tick }]);
    return true;
  });
}
