// Fresh, authenticated replication watermark for terminal migration readers.
// A local Autobase update is not a network synchronization proof. The pinned
// indexer answers a random challenge over its existing Noise connection, then
// the reader verifies both committed Hypercore trees before reading any state.
import Protomux from 'protomux';
import c from 'compact-encoding';
import { randomBytes } from 'node:crypto';
import { hashObject, stableJSON } from '../../rules/src/core.js';

export const BARRIER_DEFAULTS = Object.freeze({ timeoutMs: 30000, pollMs: 25, attempts: 3, retryMs: 1000, requestTimeoutMs: 5000 });
const installed = new WeakMap(), hex = value => typeof value === 'string' ? value : value.toString('hex');
const need = (ok, code) => { if (!ok) throw Error(code); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function limits(settings) {
  const value = { ...BARRIER_DEFAULTS, ...settings };
  need(Object.keys(value).every(k => k in BARRIER_DEFAULTS) && Object.values(value).every(n => Number.isSafeInteger(n) && n > 0), 'terminal_barrier_settings');
  return value;
}
async function tree(core) {
  const length = core.length;
  need(Number.isSafeInteger(length) && length > 0 && core.signedLength === length, 'terminal_barrier_uncommitted');
  const result = { key: hex(core.key), length, hash: hex(await core.treeHash(length)) };
  need(core.length === length && core.signedLength === length, 'terminal_barrier_changed');
  return result;
}
async function watermark(peer, nonce) {
  need(peer.base.isIndexer && hex(peer.wallet.publicKey) === peer.config.dmw.admin, 'terminal_barrier_authority');
  await peer.base.update();
  const system = await tree(peer.base.core), view = await tree(peer.base.view.core);
  need(peer.base.core.length === system.length && peer.base.view.core.length === view.length, 'terminal_barrier_changed');
  return { domain: 'dmw-terminal-watermark-v1', nonce, notary: hex(peer.base.key), admin: peer.config.dmw.admin,
    deploymentHash: hashObject(peer.config.dmw), system, view };
}
export function installTerminalBarrier(peer) {
  if (installed.has(peer)) return installed.get(peer);
  need(peer.swarm && peer.config.dmw?.v2, 'terminal_barrier_runtime');
  const channels = new Map(), pending = new Map(), paired = new Map(); let closed = false;
  const identity = { protocol: 'dmw-terminal-watermark-v1', id: peer.base.key };
  const attach = connection => {
    if (closed || connection.destroyed) return;
    const mux = Protomux.from(connection);
    if (!paired.has(connection)) {
      // A peer can finish connecting before the other process installs its
      // barrier. Protomux rejects that first channel, but the Noise connection
      // stays healthy. Keep a pairing handler so a later open can recover.
      paired.set(connection, mux); mux.pair(identity, () => attach(connection));
      connection.once('close', () => { mux.unpair(identity); paired.delete(connection); });
    }
    if (channels.has(connection)) return;
    const channel = mux.createChannel({ ...identity,
      onclose() { if (channels.get(connection)?.channel === channel) channels.delete(connection); } });
    if (!channel) return;
    let serving = false;
    const message = channel.addMessage({ encoding: c.json, async onmessage(packet) {
      try {
        if (packet?.request && /^[0-9a-f]{64}$/.test(packet.request) && !serving) {
          // Read-only peers never claim to be the authoritative indexer.
          if (!peer.base.isIndexer || hex(peer.wallet.publicKey) !== peer.config.dmw.admin) return;
          serving = true;
          try {
            const body = await watermark(peer, packet.request);
            message.send({ body, signature: peer.wallet.sign(stableJSON(body)) });
          } catch { message.send({ nonce: packet.request, unavailable: true }); }
          finally { serving = false; }
        } else {
          const nonce = packet?.body?.nonce ?? packet?.nonce, waiter = pending.get(nonce);
          if (waiter && hex(connection.remotePublicKey) === waiter.admin) waiter.resolve(packet);
        }
      } catch { /* Malformed/disconnected remote cannot escape a network callback. */ }
    } });
    channels.set(connection, { channel, message }); channel.open();
  };
  peer.swarm.on('connection', attach);
  for (const connection of peer.swarm.connections) attach(connection);
  const controller = {
    async synchronize({ admin = peer.config.dmw.admin, ...settings } = {}) {
      const policy = limits(settings);
      for (let attempt = 0; attempt < policy.attempts; attempt++) {
        try { return await controller.synchronizeOnce({ admin, ...policy }); }
        catch (error) {
          if (closed || error.message !== 'terminal_barrier_unavailable' || attempt + 1 === policy.attempts) throw error;
          await pause(policy.retryMs);
        }
      }
    },
    async synchronizeOnce({ admin = peer.config.dmw.admin, ...settings } = {}) {
      const policy = limits(settings), deadline = Date.now() + policy.timeoutMs;
      need(admin === peer.config.dmw.admin && hex(peer.wallet.publicKey) !== admin, 'terminal_barrier_independent_reader');
      // An explicit join avoids relying on a cached/discovered peer list.
      peer.swarm.joinPeer(Buffer.from(admin, 'hex'));
      while (!closed && Date.now() < deadline) {
        for (const connection of peer.swarm.connections) attach(connection);
        const entry = [...channels].find(([connection]) => hex(connection.remotePublicKey) === admin);
        if (!entry) { await pause(policy.pollMs); continue; }
        const nonce = randomBytes(32).toString('hex'), requestedAt = Date.now(); let timer;
        const reply = new Promise(resolve => {
          pending.set(nonce, { admin, resolve });
          timer = setTimeout(() => resolve(null), Math.max(1, Math.min(policy.requestTimeoutMs, deadline - Date.now())));
        });
        let packet;
        try { entry[1].message.send({ request: nonce }); packet = await reply; }
        finally { clearTimeout(timer); pending.delete(nonce); }
        if (!packet || packet.unavailable) { await pause(policy.pollMs); continue; }
        const body = packet.body;
        need(body?.domain === 'dmw-terminal-watermark-v1' && body.nonce === nonce && body.admin === admin
          && body.notary === hex(peer.base.key) && body.deploymentHash === hashObject(peer.config.dmw)
          && peer.wallet.verify(packet.signature, stableJSON(body), admin), 'terminal_barrier_authentication');
        for (const pin of [body.system, body.view]) need(pin && /^[0-9a-f]{64}$/.test(pin.key) && /^[0-9a-f]{64}$/.test(pin.hash)
          && Number.isSafeInteger(pin.length) && pin.length > 0, 'terminal_barrier_watermark');
        while (!closed && Date.now() < deadline) {
          await peer.base.update();
          const pairs = [[peer.base.core, body.system], [peer.base.view.core, body.view]];
          if (pairs.every(([core, pin]) => hex(core.key) === pin.key && core.length >= pin.length && core.signedLength >= pin.length)) {
            for (const [core, pin] of pairs) need(hex(await core.treeHash(pin.length)) === pin.hash, 'terminal_barrier_tree_conflict');
            // If newer state arrived during catch-up, request a new watermark.
            // Never read a newer speculative view using an older proof.
            if (pairs.some(([core, pin]) => core.length !== pin.length)) break;
            // Age starts before the network round trip, not after a potentially
            // slow replication. Catch-up cannot refresh an old observation.
            return { ...body, synchronized: true, observedAt: requestedAt };
          }
          await pause(policy.pollMs);
        }
      }
      throw Error('terminal_barrier_unavailable');
    },
    close() {
      closed = true; peer.swarm.removeListener('connection', attach);
      for (const waiter of pending.values()) waiter.resolve(null);
      for (const mux of paired.values()) mux.unpair(identity);
      for (const { channel } of channels.values()) channel.close();
      paired.clear(); channels.clear(); installed.delete(peer);
    }
  };
  installed.set(peer, controller); return controller;
}
