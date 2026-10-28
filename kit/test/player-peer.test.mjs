import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { waitForPeerAppend } from '../lib/peer-append-wait.mjs';
import { loadPlayerPeer } from '../lib/player-peer.mjs';

test('many idle Trac connections share a single append listener and release it on deadline', async () => {
  const core = new EventEmitter(), connections = Array.from({ length: 32 }, () => new EventEmitter());
  const pending = connections.map(connection => waitForPeerAppend(core, connection, Date.now() + 30));
  assert.equal(core.listenerCount('append'), 1); assert.equal(core.listenerCount('close'), 1);
  assert.ok((await Promise.all(pending)).every(value => value === false));
  assert.equal(core.listenerCount('append'), 0); assert.equal(core.listenerCount('close'), 0);
  assert.ok(connections.every(connection => connection.listenerCount('close') === 0));
});
test('append, connection close and core shutdown clean listeners and timers without affecting other readers', async () => {
  const core = new EventEmitter(), a = new EventEmitter(), b = new EventEmitter();
  const independent = () => {}; core.on('append', independent);
  const first = waitForPeerAppend(core, a, Date.now() + 10000), second = waitForPeerAppend(core, b, Date.now() + 10000);
  a.emit('close'); assert.equal(await first, false); assert.equal(core.listenerCount('append'), 2);
  core.emit('append'); assert.equal(await second, true); assert.deepEqual(core.listeners('append'), [independent]);
  const closing = waitForPeerAppend(core, b, Date.now() + 10000); core.emit('close');
  assert.equal(await closing, false); assert.equal(b.listenerCount('close'), 0);
  b.destroyed = true;
  assert.equal(await waitForPeerAppend(core, b, Date.now() + 10000), false);
  assert.equal(await waitForPeerAppend(core, a, Date.now() - 1), false);
  assert.deepEqual(core.listeners('append'), [independent]);
});
test('the actual pinned peer uses the bounded invitation wait when loaded by the player runtime', async () => {
  const require = createRequire(new URL('../../contract/package.json', import.meta.url));
  const url = pathToFileURL(require.resolve('trac-peer')).href;
  const original = await import(url);
  const { Peer } = await loadPlayerPeer(url);
  assert.notEqual(Peer, original.Peer);
  assert.equal((await loadPlayerPeer(url)).Peer, Peer);
  assert.match(Peer.prototype._replicate.toString(), /waitForPeerAppend\(_this.base.view.core, connection, deadline\)/);
  assert.doesNotMatch(Peer.prototype._replicate.toString(), /core.once\('append', resolve\)/);
});
