import test from 'node:test';
import assert from 'node:assert/strict';
import { closeRuntime } from '../runtime.mjs';
import { HttpSource } from '../http.mjs';
import { withLifecycle } from '../../src/lifecycle.mjs';
import { mockServer } from './helpers.mjs';
import { lookupMaintenance } from '../lookup-maintenance.mjs';

test('Trac closes both runtimes concurrently and bounds a stalled swarm without blocking forever', async () => {
  const calls = [], never = new Promise(() => {});
  const runtime = { peer: { txObserverTask: { stop: () => calls.push('peer-poll') }, updaterTask: { stop: () => calls.push('updater') },
    swarm: { connections: [{ destroy: () => calls.push('peer-socket') }], destroy: () => never },
    close: async () => { calls.push('peer-close'); await never; }, store: { close: async () => calls.push('peer-store') } },
    bus: { network: { transactionPoolService: { stopPool: async wait => { assert.equal(wait, false); calls.push('pool'); } },
      validatorObserverService: { stopValidatorObserver: async wait => { assert.equal(wait, false); calls.push('observer'); } },
      swarm: { connections: [{ destroy: () => calls.push('bus-socket') }], destroy: () => never } },
      close: async () => { calls.push('bus-close'); await never; } }, barrier: { close: () => calls.push('barrier') } };
  const before = performance.now();
  assert.equal(await closeRuntime(runtime, { timeoutMs: 50 }), false);
  assert.ok(performance.now() - before < 1000);
  for (const name of ['peer-poll', 'updater', 'pool', 'observer', 'peer-socket', 'bus-socket', 'peer-close', 'bus-close', 'barrier']) assert.ok(calls.includes(name), name);
  assert.ok(!calls.includes('peer-store'), 'never close a store under an active peer');
});

test('normal Trac close drains the peer before closing its store', async () => {
  const calls = [];
  assert.equal(await closeRuntime({ peer: { close: async () => calls.push('peer'), store: { close: async () => calls.push('store') } }, bus: { close: async () => calls.push('bus') } }), true);
  assert.ok(calls.indexOf('peer') < calls.indexOf('store')); assert.ok(calls.includes('bus'));
});

test('source shutdown cancels stalled bodies and queued requests without retrying', async t => {
  let entered, calls = 0;
  const receiving = new Promise(resolve => { entered = resolve; });
  const url = await mockServer(t, (_, res) => { calls++; res.writeHead(200); res.write('{'); entered(); });
  const controller = new AbortController();
  const source = withLifecycle({ signal: controller.signal }, () => new HttpSource({ url, timeoutMs: 30000, retries: 5, requestsPerSecond: 0.1 }));
  const first = assert.rejects(source.request('/one'), /source_stopped/);
  const second = assert.rejects(source.request('/two'), /source_stopped/);
  await receiving; const before = performance.now(); controller.abort(Error('source_stopped'));
  await Promise.all([first, second]);
  assert.ok(performance.now() - before < 1000); assert.equal(calls, 1);
});

test('source abort stops subsequent maintenance passes while already-started lanes drain', async () => {
  const controller = new AbortController(); let release, inventories = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const maintenance = withLifecycle({ signal: controller.signal }, () => lookupMaintenance({
    lookups: { tick: () => blocked }, inventory: { tick: () => { inventories++; } }, ethereum: {}, interval: 60000
  }));
  const pending = maintenance.run(); assert.equal(inventories, 1, 'independent lanes start together');
  controller.abort(); release(); await pending;
  await maintenance.run(); await maintenance.close(); assert.equal(inventories, 1);
});
