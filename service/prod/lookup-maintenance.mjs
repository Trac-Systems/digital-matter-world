// Independent bounded maintenance. Slow source catch-up must not hold the
// Bitcoin observation call open or run a catalog scan on a public request.
import { lifecycleSignal } from '../src/lifecycle.mjs';
export function lookupMaintenance({ lookups, inventory, ethereum, interval }) {
  let closed = false; const status = {}, pending = new Map();
  const tasks = [
    ['tap', () => lookups.tick()], ['bitmaps', () => inventory.tick()],
    ['ethereum', async () => { const block = await ethereum.rpc('eth_getBlockByNumber', ['latest', false]); return ethereum.events.advance(block.number); }]
  ];
  const run = () => {
    if (closed) return Promise.resolve(status);
    for (const [kind, task] of tasks) {
      if (closed) break;
      if (pending.has(kind)) continue;
      const work = (async () => {
        try { const complete = await task(); status[kind] = { ok: true, ...(typeof complete === 'boolean' ? { complete } : {}) }; }
        catch (error) { status[kind] = { ok: false, reason: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'source_lookup_unavailable' }; }
      })().finally(() => { pending.delete(kind); });
      pending.set(kind, work);
    }
    return Promise.all([...pending.values()]).then(() => structuredClone(status));
  };
  const timer = setInterval(run, interval); timer.unref();
  const signal = lifecycleSignal(), stop = () => { closed = true; clearInterval(timer); };
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  return { run, status: () => structuredClone(status), async close() { stop(); signal?.removeEventListener('abort', stop); await Promise.allSettled([...pending.values()]); } };
}
