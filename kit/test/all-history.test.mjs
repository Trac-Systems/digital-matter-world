import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseClaims } from '../strategies/default.mjs';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { temp, cleanup, history, fakeTrac, testWallet } from './helpers.mjs';
import { CLAIM_DEFAULTS, MAX_CLAIMS_PER_WINDOW } from '../../rules/src/index.js';
const patterns = [{ number: 0, name: 'dmwtest', fld: 4, dt: 'n', pat: '[0-9]', rarity: 201 }];
test('default hunts old matching blocks, excludes found/minted slots and follows the configured budget', () => {
  const hist = history(220), taken = { 0: new Set(Array.from({ length: 20 }, (_, i) => i)) };
  const claims = chooseClaims({ history: hist, patterns, taken, claimableHeight: 199, window: 201 });
  assert.equal(claims.length, CLAIM_DEFAULTS.claimsPerWindow);
  assert.equal(claims[0].block, 20); assert.equal(claims.at(-1).block, 20 + CLAIM_DEFAULTS.claimsPerWindow - 1);
  const all = chooseClaims({ history: hist, patterns, taken, claimsPerWindow: MAX_CLAIMS_PER_WINDOW, claimableHeight: 199, window: 201 });
  assert.equal(all.length, 181); assert.equal(all.at(-1).block, 201);
  assert.ok(!all.some(p => p.block === 200 || p.block > 201));
});
test('live historic claim drains the public found index and retries the same saved selection', async t => {
  const dir = await temp(t), hist = history(220), { trac } = fakeTrac(hist, { tip: 220 });
  const journal = await Journal.open(dir, 'all-history', { intervalMs: 0 }); cleanup(t, () => journal.close());
  const calls = [], sent = [];
  const service = { network: trac.network, patterns: async () => ({ patterns, total: 1, limit: 50, next: null }),
    latest: async () => ({ summary: {} }), publication: async () => ({ tip: 220, height: 220, tipHash: hist.hashAt(220) }),
    readPage: async (route, options) => { calls.push({ route, options }); return options.cursor ?
      { rows: [{ block: 1, found: true, minted: true }], next: null } : { rows: [{ block: 0, found: true }], next: 'next' }; },
    submit: async move => { sent.push(move); return { tip: 220, move: 'fixture' }; }
  };
  const agent = new Agent({ wallet: testWallet(), network: trac.network, trac, service, journal, dryRun: false, puzzleBits: 0, powLimitBits: 0x207fffff });
  const first = await agent.runOnce({ history: hist });
  assert.equal(first.window, 220); assert.equal(first.plots[0].block, 2); assert.equal(first.plots.length, CLAIM_DEFAULTS.claimsPerWindow);
  assert.equal(sent[0].p.window, 220); assert.equal(sent[0].p.header.height, 220); assert.ok(!('openedAt' in sent[0].p));
  assert.equal(calls.length, 2); assert.equal(calls[0].options.found, true); assert.equal(calls[1].options.cursor, 'next');
  service.readPage = () => { throw Error('saved window must not select a new bundle'); };
  assert.equal((await agent.runOnce({ history: hist })).replayed, true); assert.equal(sent.length, 1);
});
