import { BUILD as configuredBuildRoot } from '../../../local/common.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { History } from '../../src/history.mjs';
import { fixtureHistory } from '../helpers.mjs';

const fixture = fixtureHistory(30); let rawTip = 8, tracTip = 6, failRelay = true, relayCalls = 0;
const client = { network: 'regtest', tip: async () => ({ height: rawTip, hash: fixture.hashAt(rawTip) }), blockHash: async n => fixture.hashAt(n),
  header: async hash => fixture.raw(Array.from({ length: fixture.length }, (_, i) => i).find(n => fixture.hashAt(n) === hash)) };
mock.module('../../local/reads.mjs', { exports: { localReads: async () => ({ client, manifest: { bitcoin: client }, counted: async () => tracTip - 5, close() {},
  trac: async (method, args) => {
    if (method === 'head') return { counted: tracTip - 5, tip: { height: tracTip, hash: fixture.hashAt(tracTip) } };
    if (method === 'deployment') return { beacon: { checkpoint: { height: 6, hash: fixture.hashAt(6) } } };
    if (method === 'headers') {
      relayCalls++;
      if (failRelay) throw Error('relay-unavailable');
      for (const raw of args[0]) {
        assert.equal(raw, fixture.raw(tracTip + 1), 'Trac cannot accept a skipped header'); tracTip++;
      }
      return { counted: tracTip - 5, tip: { height: tracTip, hash: fixture.hashAt(tracTip) } };
    }
    throw Error('unexpected-trac-call');
  }
}) } });
const { createAdapters } = await import('../../local/adapter.mjs');

test('failed relay resends the exact header and preserves unacknowledged observations', async () => {
  const root = `${configuredBuildRoot}/service/regressions/adapter-data`; await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'case-')), store = await Store.open(directory), history = new History(store);
  for (let h = 0; h <= 6; h++) await history.append(h, fixture.raw(h));
  const config = { network: 'dmw-regtest', local: { contexts: join(directory, 'contexts'), escrow: { chainId: '31337', address: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20) } } };
  const adapter = await createAdapters({ config, store, history });
  try {
    const previous = { tip: 6, hash: fixture.hashAt(6), counted: 1, revision: 0 };
    await assert.rejects(adapter.observations(previous), /relay-unavailable/);
    assert.equal(history.length, 8); assert.equal(tracTip, 6);
    failRelay = false;
    const rows = await adapter.observations(previous);
    assert.deepEqual(rows.map(r => r.tip), [7]); assert.equal(tracTip, 7);
    assert.deepEqual(await adapter.observations(previous), rows); // caller crash before intake acknowledgement
    for (const row of rows) await adapter.observed(row);
    const rest = await adapter.observations(rows.at(-1)); assert.deepEqual(rest.map(r => r.tip), [8]); assert.equal(tracTip, 8);
  } finally { await adapter.close(); await store.close(); }
});
