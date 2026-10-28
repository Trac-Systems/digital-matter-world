// Independent bounded maintenance. Slow source catch-up must not hold the
// Bitcoin observation call open or run a catalog scan on a public request.
export function lookupMaintenance({ lookups, inventory, ethereum, interval }) {
  let pending, closed = false; const status = {};
  const run = () => {
    if (closed) return Promise.resolve(status);
    if (pending) return pending;
    pending = (async () => {
      for (const [kind, task] of [
        ['tap', () => lookups.tick()], ['bitmaps', () => inventory.tick()],
        ['ethereum', async () => { const block = await ethereum.rpc('eth_getBlockByNumber', ['latest', false]); return ethereum.events.advance(block.number); }]
      ]) {
        if (closed) break;
        try { const complete = await task(); status[kind] = { ok: true, ...(typeof complete === 'boolean' ? { complete } : {}) }; }
        catch (error) { status[kind] = { ok: false, reason: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'source_lookup_unavailable' }; }
      }
      return structuredClone(status);
    })().finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(run, interval); timer.unref();
  return { run, status: () => structuredClone(status), async close() { closed = true; clearInterval(timer); await pending; } };
}
