import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BitcoinViews } from '../bitcoin.mjs';
import { collectMigrationEvidence } from '../migration-export.mjs';
import { mine, chain, parseHeader } from '../../../contract/tests/helpers/chain.mjs';
import { REGTEST_PARAMS } from '../../../contract/beacon/bitcoin.js';

test('operator export hashes one ordered verified branch through the counted anchor, excluding forks and newer headers', async t => {
  const genesis = mine('0'.repeat(64), 1000), raws = [genesis, ...chain(30, parseHeader(genesis))];
  const views = new BitcoinViews({ params: REGTEST_PARAMS, genesis: parseHeader(genesis).hash }, ':memory:',
    { settings: { headerPageRows: 3, headerCachePages: 1 } });
  t.after(() => views.close());
  let parent;
  for (let n = 0; n < raws.length; n++) parent = views.insert(raws[n], n, parent);
  const fork = chain(5, parseHeader(raws[20]), 601, 1);
  parent = views.get.get(parseHeader(raws[20]).hash);
  for (let n = 0; n < fork.length; n++) parent = views.insert(fork[n], 21 + n, parent);
  const history = await views.view(30, parseHeader(raws[30]).hash), counted = 24, last = { n: 3, to: counted };
  assert.deepEqual([...history.rawRange(counted)], raws.slice(0, counted + 1));
  assert.throws(() => [...history.rawRange(31)], /bitcoin_header_height/);
  const anchorHash = parseHeader(raws[counted]).hash;
  const notary = { options: { network: 'dmw-regtest' }, records: [['b/cnt', counted], ['bt/last', last], ['b/r/' + anchorHash, [counted]]] };
  const result = await collectMigrationEvidence({
    store: { migrationRows: async () => ({ stamp: { counted, last }, rows: [], artifacts: [] }) },
    notarySnapshot: async () => notary,
    historyFor: async () => ({ ...history, raw: () => { throw Error('repeated_named_header_lookup'); } })
  });
  assert.deepEqual(result.anchor, { height: String(counted), hash: anchorHash });
  assert.equal(result.headersHash, createHash('sha256').update(Buffer.from(raws.slice(0, counted + 1).join(''), 'hex')).digest('hex'));
  views.db.prepare('DELETE FROM headers WHERE hash=?').run(parseHeader(raws[10]).hash);
  assert.throws(() => [...history.rawRange(counted)], /bitcoin_history_missing/);
});
