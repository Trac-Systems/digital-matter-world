import { encodeTracAddress } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHistory, historyProof } from '../lib/headers.mjs';
import { backtest } from '../lib/backtest.mjs';
import { checkProposal } from '../lib/search.mjs';
import { PATTERN_LIMITS } from '../../rules/src/index.js';
import { discoverFixture } from '../../rules/scripts/discover-fixture.mjs';
const path = process.env.DMW_HEADERS;
test('verify large mainnet archive, evaluate a proposal and replay its final 1,000 blocks', { skip: !path, timeout: 180000 }, async t => {
  const history = await loadHistory(path), proof = historyProof(history), owner = '11'.repeat(32);
  const patterns = discoverFixture({ length: history.length - 1000, field: (...a) => history.field(...a), get: h => history.get(h) });
  assert.ok(proof.count >= 920000);
  const analysis = checkProposal({ proposal: { name: 'dmwtestnonce', pat: '[123]', fld: 10, dt: 'n' }, history, tip: history.get(history.length - 1), existing: patterns, owner });
  assert.ok(analysis.record.rarity >= PATTERN_LIMITS.minMatchingBlocks);
  const report = await backtest({ history, patterns: patterns, owner: encodeTracAddress(owner), start: history.length - 1000 });
  assert.equal(report.events, 1000); assert.equal(report.settledEvents, 998); assert.ok(report.wins > 0);
  t.diagnostic(JSON.stringify({ ...report, proposalMatchingBlocks: analysis.record.rarity }));
});
