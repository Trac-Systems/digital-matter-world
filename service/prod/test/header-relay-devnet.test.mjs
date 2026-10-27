import test from 'node:test';
import assert from 'node:assert/strict';
import { relayFixture } from './header-relay-fixture.mjs';
import { Outbox, runtimeTransport } from '../../src/transport.mjs';
import { localNetwork, until } from '../../../contract/tests/helpers/local-network.mjs';
import { controls } from '../../../contract/runtime/control.js';
import { deployment } from '../../../contract/tests/helpers/harness.mjs';

test('production relay catches up 1,700 headers through real local Trac signed messages without paid sends', { timeout: 180000 }, async t => {
  const f = await relayFixture(t, 1700), local = await localNetwork({ directory: f.root });
  try {
    const validator = await local.msb(), bus = await local.client(validator);
    const indexer = await local.peer('indexer', bus), writer = await local.peer('writer', bus, indexer.base.key.toString('hex'));
    for (const peer of [indexer, writer]) await local.fund(validator, peer.wallet);
    await controls(indexer, bus).setup({ writer: writer.writerLocalKey });
    await until(() => writer.base.writable, 'writer ready');
    const api = writer.protocol.instance.api;
    f.reads.trac = async (method, args = []) => {
      await writer.base.update();
      if (method === 'head') return api.dmwHead();
      if (method === 'deployment') return deployment;
      assert.equal(method, 'hashAt'); return api.dmwHashAt(args[0]);
    };
    const runtime = runtimeTransport(writer, bus, { installFanout: false }), sent = new Set();
    const transport = { ...runtime,
      status: async job => { await writer.base.update(); return runtime.status(job); },
      sendMessage: async message => { sent.add(message.signature); return runtime.sendMessage(message); },
      prepareTransaction: async () => assert.fail('header paid preparation'), sendTransaction: async () => assert.fail('header paid send') };
    const outbox = new Outbox({ store: f.store, transport }), start = performance.now();
    await f.relay.tick(outbox);
    await until(async () => { await outbox.tick(); return f.store.count('outbox') === 0; }, 'header catch-up', 120000);
    const elapsed = performance.now() - start;
    assert.equal(sent.size, 85); assert.equal(f.store.count('sent'), 85);
    assert.ok(f.store.list('sent').every(r => r.value.tx === null));
    await writer.base.update(); assert.deepEqual((await api.dmwHead()).tip, await f.reads.client.tip());
    assert.equal((await writer.base.view.get('txl'))?.value ?? 0, 0);
    t.diagnostic(`Real local Trac: 1700 headers / 85 distinct free messages in ${elapsed.toFixed(0)} ms (${(1700 / (elapsed / 1000)).toFixed(1)} headers/s)`);
  } finally { await local.close(); }
});
