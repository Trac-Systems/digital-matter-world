import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { Outbox, runtimeTransport } from '../../src/transport.mjs';
import { HeaderRelay } from '../header-relay.mjs';
import { BitcoinViews } from '../bitcoin.mjs';
import { temporary } from './helpers.mjs';
import { fixtureHistory, secret, gateway, signEd } from '../../test/helpers.mjs';
import { harness, deployment, alice } from '../../../contract/tests/helpers/harness.mjs';
import { chain, parseHeader } from '../../../contract/tests/helpers/chain.mjs';

export async function relayFixture(t, count = 45, { maxJobs = 128, deferred = false, source, options = deployment } = {}) {
  let store, views, outbox, relay, nonce = 0;
  const root = await temporary(t, async () => { views?.close(); await store?.close(); });
  const history = fixtureHistory(count), raws = Array.from({ length: history.length }, (_, i) => history.raw(i));
  const headers = new Map(raws.map(raw => [parseHeader(raw).hash, raw]));
  let branch = raws;
  const contract = harness(options), messages = [], deliveries = [];
  const client = source ?? { params: options.beacon.params, genesis: options.beacon.checkpoint.hash,
    tip: async () => ({ height: branch.length - 1, hash: parseHeader(branch.at(-1)).hash }),
    blockHash: async height => branch[height] ? parseHeader(branch[height]).hash : null,
    header: async hash => headers.get(hash) };
  const deliver = async message => {
    const packet = JSON.parse(message.prepared.text);
    assert.equal(message.signature, signEd(Buffer.from(JSON.stringify(message.prepared) + message.nonce), secret));
    assert.ok([null, 'header_known'].includes(await contract.run(packet.op, packet.value, alice.address, true)));
  };
  const api = {
    prepareMessage: (text, sender) => ({ text, sender }), generateNonce: () => String(++nonce),
    post: async (prepared, signature, nonce) => { const message = { prepared, signature, nonce }; messages.push(message); if (deferred) deliveries.push(message); else await deliver(message); },
    dmwHashAt: height => contract.state().beacon().hashAt(height), dmwBatchRoot: async n => contract.db.get('bt/' + n) ?? null
  };
  const transport = runtimeTransport({ config: { dmw: options }, wallet: { publicKey: gateway, sign: text => signEd(Buffer.from(text), secret) },
    protocol: { instance: { api } }, base: { view: { get: async key => contract.db.has(key) ? { value: contract.db.get(key) } : null } } }, {}, { installFanout: false });
  transport.prepareTransaction = transport.sendTransaction = async () => assert.fail('headers must never spend sponsorship');
  const reads = { client,
    trac: async (method, args = []) => {
      if (method === 'head') return contract.state().head();
      if (method === 'deployment') return options;
      if (method === 'hashAt') return api.dmwHashAt(args[0]);
      if (method === 'stamp') { const head = await contract.state().head(); return { counted: head.counted, tip: head.tip.height, tipHash: head.tip.hash, revision: contract.metrics.puts, last: await contract.state().batchLast() }; }
      assert.ok(transport[method], method); return transport[method](...args);
    },
    batchLast: () => contract.state().batchLast(), batchRoot: api.dmwBatchRoot, committeeEpoch: () => contract.state().committeeEpoch(),
    counted: async () => (await contract.state().head()).counted, batchHeaders: async () => []
  };
  const reopen = async () => {
    views?.close(); await store?.close();
    store = await Store.open(join(root, 'store'), { groupDelay: 0 });
    views = new BitcoinViews(client, join(root, 'bitcoin.sqlite')); reads.views = views;
    outbox = new Outbox({ store, transport, maxJobs }); relay = new HeaderRelay({ reads, store });
  };
  await reopen();
  return { root, reads, contract, transport, messages, deliveries, deliver, reopen, history,
    get store() { return store; }, get outbox() { return outbox; }, get relay() { return relay; },
    async fork(height, length, tag = 1) {
      branch = [...branch.slice(0, height + 1), ...chain(length, { ...parseHeader(branch[height]), height }, 600, tag)];
      for (const raw of branch) headers.set(parseHeader(raw).hash, raw);
    },
    async advanceContract(height) {
      const start = (await contract.state().head()).tip.height + 1;
      for (let i = start; i <= height; i += 20) assert.equal(await contract.run('hd', { headers: branch.slice(i, Math.min(i + 20, height + 1)) }, alice.address, true), null);
    }
  };
}
