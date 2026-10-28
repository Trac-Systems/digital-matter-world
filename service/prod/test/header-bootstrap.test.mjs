import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BitcoinViews } from '../bitcoin.mjs';
import { initializeHeaderReader } from '../header-bootstrap.mjs';
import { mine, parseHeader, chain } from '../../../contract/tests/helpers/chain.mjs';
import { REGTEST_PARAMS } from '../../../contract/beacon/bitcoin.js';
import { temporary } from './helpers.mjs';

function source() {
  const genesis = mine('00'.repeat(32), 1000), raws = [genesis, ...chain(36, parseHeader(genesis))];
  const rows = raws.map((raw, height) => ({ raw, height, ...parseHeader(raw) }));
  const byHash = new Map(rows.map(row => [row.hash, row]));
  let requests = 0;
  const tip = { height: 36, hash: rows[36].hash };
  const client = { params: REGTEST_PARAMS, genesis: rows[0].hash, tip: async () => tip,
    blockHash: async height => rows[Number(height)]?.hash,
    headerInfo: async hash => { requests++; return byHash.get(hash); } };
  return { client, indexer: { stamp: async () => tip }, tip, requests: () => requests };
}

for (const integerVersion of [1, 2]) test(`six independent readers bootstrap before admission and reopen without cold quote work (integer v${integerVersion})`, async t => {
  const root = await temporary(t);
  for (let i = 0; i < 6; i++) {
    const f = source(), filename = join(root, `reader-${i}.sqlite`);
    let views = new BitcoinViews(f.client, filename, { maxHeadersPerView: 5, integerVersion });
    try {
      const ready = await initializeHeaderReader({ ...f, views });
      assert.equal(ready.ready, true); assert.equal(ready.bitcoin.height, '36');
      assert.equal(f.requests(), 37, 'each reader verifies its own complete history across bounded pages');
      views.close(); views = new BitcoinViews(f.client, filename, { maxHeadersPerView: 5, integerVersion });
      await initializeHeaderReader({ ...f, views });
      const firstQuoteView = await views.view(f.tip.height, f.tip.hash);
      assert.equal(firstQuoteView.hashAt(views.ordinal(36)), f.tip.hash);
      assert.equal(f.requests(), 37, 'restart and the first player quote fetch no historical headers');
    } finally { views.close(); }
  }
});

test('bootstrap rejects source, verification and canonical/TAP disagreement instead of declaring readiness', async () => {
  for (const failure of ['source', 'verification', 'canonical', 'tap']) {
    const f = source();
    if (failure === 'source') f.client.headerInfo = async () => { throw Error('source_unavailable'); };
    if (failure === 'verification') f.client.headerInfo = async () => ({ raw: '00'.repeat(80), height: 36 });
    if (failure === 'canonical') f.client.blockHash = async () => 'ab'.repeat(32);
    if (failure === 'tap') f.indexer.stamp = async () => ({ height: 36, hash: 'ab'.repeat(32) });
    const views = new BitcoinViews(f.client, ':memory:', { maxHeadersPerView: 5 });
    try { await assert.rejects(initializeHeaderReader({ ...f, views }), /source_unavailable|bitcoin_pow|bitcoin_bootstrap_canonical|tap_bootstrap_canonical/); }
    finally { views.close(); }
  }
});
