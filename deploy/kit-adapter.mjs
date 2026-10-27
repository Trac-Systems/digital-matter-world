import assert from 'node:assert/strict';
import { TracClient } from '../kit/lib/trac.mjs';
import { loopback } from './safety.mjs';

// The published rehearsal adapter exposes reads. Paid transactions need the
// agent's own funded writer and MSB transaction adapter.
export async function create({ config, network, localOnly }) {
  assert.equal(localOnly, true); assert.equal(network, config.network);
  const origin = loopback(config.trac);
  const read = async (method, args = []) => {
    const r = await fetch(origin + '/public', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(15000) });
    assert(r.ok, 'Local read unavailable'); const body = await r.json(); assert(!body.error); return body.result;
  };
  const names = { dmwAuthority: 'authority', dmwHead: 'head', dmwHashAt: 'hashAt', dmwBalance: 'balance', dmwSettings: 'settings', dmwLock: 'lock', dmwMint: 'pending', dmwBatchLast: 'batchLast', dmwBatchRoot: 'root', dmwRecord: 'record' };
  return { trac: new TracClient({ network, api: Object.fromEntries(Object.entries(names).map(([name, method]) => [name, (...args) => read(method, args)])) }),
    source: { height: () => read('bitcoinHeight'), hash: h => read('bitcoinHash', [h]), header: h => read('bitcoinHeader', [h]) } };
}
