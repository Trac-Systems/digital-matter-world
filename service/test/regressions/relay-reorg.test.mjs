import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createBitcoin } from '../../prod/bitcoin.mjs';
import { regtest } from '../ord-regtest.mjs';
import { waitIndexed } from '../../../local/common.mjs';
import { Store } from '../../src/store.mjs';
import { History } from '../../src/history.mjs';
import { harness, deployment } from '../../../contract/tests/helpers/harness.mjs';
import { REGTEST_PARAMS, parseHeader, workFor } from '../../../contract/beacon/bitcoin.js';
let source, trac, loseResponse = false;
mock.module('../../local/reads.mjs', { exports: { localReads: async () => ({ client: source, manifest: { bitcoin: source }, close() {}, counted: async () => (await trac('head')).counted,
  trac: async (method, args) => { const value = await trac(method, args); if (method === 'headers' && loseResponse) { loseResponse = false; throw Error('lost_header_response'); } return value; }
}) } });
const { createAdapters } = await import('../../local/adapter.mjs');

test('ord-only relay survives 1, 2, 3 and 7-block reorgs and lost acknowledgements across restart', { timeout: 180000 }, async t => {
  const r = await regtest(); t.after(() => r.close());
  source = await createBitcoin({ kind: 'ord', urlFile: r.sourceFile }, { requestsPerSecond: 100 }, { network: 'regtest' });
  const genesis = parseHeader(await source.header(await source.blockHash(0)));
  const network = 'dmw-regtest-reorg', options = { ...deployment, network, beacon: { checkpoint: { height: 0, hash: genesis.hash, bits: genesis.bits, time: genesis.time, chainwork: workFor(genesis.bits).toString() }, params: REGTEST_PARAMS } }, chain = harness(options);
  trac = async (method, args = []) => {
    if (method === 'head') return chain.state().head();
    if (method === 'deployment') return options;
    assert.equal(method, 'headers'); const raws = args[0];
    for (let i = 0; i < raws.length; i += 20) assert.ok([null, 'header_known'].includes(await chain.run('hd', { headers: raws.slice(i, i + 20) })));
    return { ...await chain.state().head(), accepted: parseHeader(raws.at(-1)).hash };
  };
  const config = { network, local: { contexts: join(r.root, 'contexts'), escrow: { chainId: '31337', address: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20) } } };
  let store, adapter, previous;
  t.after(async () => { await adapter?.close(); await store?.close(); });
  const reopen = async () => { await adapter?.close(); await store?.close(); store = await Store.open(join(r.root, 'gateway')); adapter = await createAdapters({ config, store, history: new History(store) }); };
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      for (const row of await adapter.observations(previous)) { assert.ok(row.counted >= (previous?.counted ?? 0)); previous = row; await adapter.observed(row); }
      if (previous?.hash === (await source.tip()).hash) return;
    }
    assert.fail('relay_drain');
  };
  await reopen(); await drain();
  for (const depth of [1, 2, 3, 7]) {
    const old = await trac('head'), orphan = await source.blockHash(old.tip.height - depth + 1);
    await r.rpc('setmocktime', [(await source.headerInfo(old.tip.hash)).timestamp + 60]);
    await r.rpc('invalidateblock', [orphan]); await r.mine(depth + 1); await waitIndexed(r.manifest);
    loseResponse = true; await assert.rejects(adapter.observations(previous), /lost_header_response/);
    const intent = store.get('meta', 'relayIntent'); assert.ok(intent);
    await reopen(); await drain();
    const head = await trac('head'); assert.equal(head.tip.hash, (await source.tip()).hash); assert.ok(head.counted >= old.counted); assert.equal(store.get('meta', 'relayIntent'), null);
  }
});
