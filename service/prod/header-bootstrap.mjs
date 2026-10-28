import { setImmediate } from 'node:timers/promises';
import { check } from '../src/util.mjs';
import { decimalV2 } from '../../rules/src/integers-v2.js';

// Startup work for each independent reader, before it can serve a quote or a
// signer request. Keep the reader's bounded, persisted catch-up pages; only the
// explicit bootstrap drains them. Source/verification failures abort startup.
export async function initializeHeaderReader({ client, indexer, views }) {
  const tip = await client.tip();
  let history;
  for (;;) {
    try { history = await views.view(tip.height, tip.hash); break; }
    catch (error) {
      if (error.message !== 'bitcoin_history_catching_up') throw error;
      await setImmediate();
    }
  }
  const at = value => views.ordinal(value);
  check(history.hashAt(at(tip.height)) === tip.hash && await client.blockHash(tip.height) === tip.hash, 'bitcoin_bootstrap_canonical');
  const tap = await indexer.stamp();
  check(BigInt(tap.height) <= BigInt(tip.height) && history.hashAt(at(tap.height)) === tap.hash, 'tap_bootstrap_canonical');
  return { ready: true, bitcoin: { height: decimalV2(tip.height), hash: tip.hash }, tap: { height: decimalV2(tap.height), hash: tap.hash } };
}
