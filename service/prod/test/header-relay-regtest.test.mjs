import test from 'node:test';
import assert from 'node:assert/strict';
import { relayFixture } from './header-relay-fixture.mjs';
import { regtest } from '../../test/ord-regtest.mjs';
import { createBitcoin } from '../bitcoin.mjs';
import { waitIndexed } from '../../../local/common.mjs';
import { deployment } from '../../../contract/tests/helpers/harness.mjs';
import { parseHeader, REGTEST_PARAMS, workFor } from '../../../contract/beacon/bitcoin.js';

test('production relay follows real ord/regtest headers into the contract across a reorg and restart', { timeout: 180000 }, async t => {
  const r = await regtest(); t.after(() => r.close());
  const source = await createBitcoin({ kind: 'ord', urlFile: r.sourceFile }, { requestsPerSecond: 100 }, { network: 'regtest' });
  const genesis = parseHeader(await source.header(await source.blockHash(0)));
  const options = { ...deployment, beacon: { checkpoint: { height: 0, hash: genesis.hash, bits: genesis.bits, time: genesis.time,
    chainwork: workFor(genesis.bits).toString() }, params: REGTEST_PARAMS } };
  const f = await relayFixture(t, 0, { source, options });
  let time = Date.now();
  const drain = async () => {
    for (let i = 0; i < 12; i++) {
      await f.relay.tick(f.outbox); await f.outbox.tick(time += 1000);
      if (!f.store.count('outbox')) { assert.deepEqual((await f.reads.trac('head')).tip, await source.tip()); return; }
    }
    assert.fail('production_relay_drain');
  };
  await drain(); const old = await source.tip();
  assert.equal(f.messages.length, Math.ceil(old.height / 20));
  await r.rpc('setmocktime', [(await source.headerInfo(old.hash)).timestamp + 60]);
  await r.rpc('invalidateblock', [await source.blockHash(old.height - 2)]); await r.mine(4); await waitIndexed(r.manifest);
  await f.relay.tick(f.outbox); const queued = f.store.list('outbox');
  assert.equal(queued.length, 1); assert.equal(queued[0].value.value.headers.length, 4);
  await f.reopen(); await f.relay.tick(f.outbox); assert.deepEqual(f.store.list('outbox'), queued);
  await drain(); assert.equal(f.messages.length, Math.ceil(old.height / 20) + 1);
});
