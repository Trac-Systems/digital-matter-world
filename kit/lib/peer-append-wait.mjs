// Trac's writer-invitation waits share one append listener per core. Each wait
// ends on append, connection/core close, or its deadline, including idle cores.
const waiting = new WeakMap();
export function waitForPeerAppend(core, connection, deadline) {
  if (connection.destroyed || core.closed || Date.now() >= deadline) return Promise.resolve(false);
  return new Promise(resolve => {
    let group = waiting.get(core);
    if (!group) {
      const listeners = new Set();
      const finish = value => { for (const done of [...listeners]) done(value); };
      group = { listeners, append: () => finish(true), close: () => finish(false) };
      waiting.set(core, group);
      core.on('append', group.append); core.on('close', group.close);
    }
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); connection.off('close', closed);
      group.listeners.delete(done);
      if (!group.listeners.size) {
        core.off('append', group.append); core.off('close', group.close); waiting.delete(core);
      }
      resolve(value && !connection.destroyed && !core.closed && Date.now() < deadline);
    };
    const closed = () => done(false);
    const timer = setTimeout(closed, Math.max(1, deadline - Date.now()));
    group.listeners.add(done); connection.once('close', closed);
  });
}
