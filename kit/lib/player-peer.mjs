import { registerHooks } from 'node:module';
import { check } from './check.mjs';

// Compatibility fix for the pinned trac-peer revision. Keep it in the player
// runtime, without modifying installed packages or changing other components.
// Fail explicitly when upstream changes so a dependency upgrade gets reviewed.
const modules = new Map();
export function loadPlayerPeer(url) {
  if (!modules.has(url)) modules.set(url, load(url));
  return modules.get(url);
}
async function load(original) {
  // A distinct module instance also works when a trusted local adapter already
  // imported the unmodified peer. Only the player's Peer class gets this fix.
  const target = new URL(original); target.searchParams.set('dmw-player', 'bounded-invites-v1');
  const url = target.href;
  const wait = "await new Promise((resolve) => _this.base.view.core.once('append', resolve));";
  const hook = registerHooks({ load(filename, context, nextLoad) {
    const result = nextLoad(filename, context);
    if (filename !== url) return result;
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
    check(source.split(wait).length === 2, 'Pinned Trac peer invitation wait changed; review the player runtime compatibility fix');
    const helper = new URL('./peer-append-wait.mjs', import.meta.url).href;
    return { ...result, source: `import { waitForPeerAppend } from ${JSON.stringify(helper)};\n` +
      source.replace(wait, 'if (!await waitForPeerAppend(_this.base.view.core, connection, deadline)) return;') };
  } });
  try { return await import(url); } finally { hook.deregister(); }
}
