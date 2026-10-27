import { withTapSource } from '../helpers.mjs';
import { BUILD as configuredBuildRoot } from '../../../local/common.mjs';
import { createFeePolicy } from '../../src/fees.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureHistory } from '../helpers.mjs';
import { hash } from '../../src/util.mjs';
import { BitcoinViews } from '../../prod/bitcoin.mjs';
import { REGTEST_PARAMS } from '../../../contract/beacon/bitcoin.js';
const history = fixtureHistory(10), earlier = hash('earlier'), later = hash('later'), payer = 'local-payer'; let failEarlier = true;
const client = { kind: 'ord', network: 'regtest', params: REGTEST_PARAMS, genesis: history.hashAt(0),
  tip: async () => ({ height: 8, hash: history.hashAt(8) }), blockHash: async n => history.hashAt(n),
  header: async id => history.raw(Array.from({ length: history.length }, (_, i) => i).find(n => history.hashAt(n) === id)),
  included: async () => ({ height: 1, blockHash: history.hashAt(1), confirmations: 8 }),
  block: async () => ({ tx: [earlier, later] }),
  source: { request: async path => {
    if (path.startsWith('/content/')) return JSON.stringify({ redeem: { data: path.includes(earlier) ? earlier : later } });
    if (path.includes('/getLockConsume/')) return { result: null };
    if (path.includes(earlier) && failEarlier) throw Error('indexer_timeout');
    return { result: { owner: payer, total: '100', tick: 'tap', kind: 'htlc', condition: { type: 'hashlock', hash: hash('test-preimage') }, refund: payer, claim: 'treasury', amt: '60', al: [], refund_after: '300' } };
  } }
};
mock.module('../../prod/bitcoin.mjs', { namedExports: { BitcoinViews, createBitcoin: async () => client } });
const { localReads } = await import('../../local/reads.mjs');
