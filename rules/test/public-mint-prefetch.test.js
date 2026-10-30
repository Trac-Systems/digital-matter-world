import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { PublicMintPrefetch } from '../src/public-mint-prefetch.js';
import { ClosureBudget, advanceClaimWindow } from '../src/claim-closure.js';
import { fixture, hashAt } from './claims-never-close-fixture.mjs';

test('public point prefetch batches bounded hints, caches absence and isolates snapshots and unused errors', () => {
  const calls = [], winner = r.hash('winner');
  const cache = new PublicMintPrefetch('predecessor-a', (pairs, at) => {
    calls.push({ pairs, at });
    return pairs.map(([, block]) => block === 'unused' ? { error: 'unavailable' } : { value: block === '3' ? winner : null });
  });
  for (let i = 0; i < 130; i++) cache.hint('p2:7', String(i));
  for (let i = 0; i < 130; i++) assert.equal(cache.get('p2:7', String(i)), i === 3 ? winner : null);
  assert.deepEqual(calls.map(c => c.pairs.length), [64, 64, 2]);
  assert.ok(calls.every(c => c.at === 'predecessor-a'));
  assert.equal(cache.get('p2:7', '0'), null); assert.equal(calls.length, 3);
  const other = new PublicMintPrefetch('predecessor-b', () => [{ value: winner }]);
  assert.equal(other.get('p2:7', '0'), winner);
  let attempts = 0;
  const failed = new PublicMintPrefetch('a', pairs => { attempts++; return pairs.map(([, b]) => b === '1' ? { value: null } : { error: 'unavailable' }); });
  failed.hint('p2:7', '2'); assert.equal(failed.get('p2:7', '1'), null);
  assert.throws(() => failed.get('p2:7', '2'), /unavailable/); assert.equal(attempts, 2);
  for (let i = 0; i < 5000; i++) cache.hint('p2:8', String(i));
  assert.equal(cache.hints.size, 4096);
});

test('prefetch hints retain known legacy ledger aliases', () => {
  const calls = [], cache = new PublicMintPrefetch('a', pairs => { calls.push(pairs); return pairs.map(() => ({ value: null })); });
  cache.seed({ namedEvidence: { nodes: [['hash', { value: { number: '7', legacy: { asset: 'p7' } } }]] },
    entries: [{ move: { p: { plots: [{ block: '12', patterns: ['7'] }, { block: '13', patterns: ['7'] }] } } }] });
  cache.get('p7', '12'); cache.get('p7', '13');
  assert.deepEqual(calls, [[['p7', '12'], ['p7', '13']]]);
});

test('demanded decimal identifiers retain the rules integer domain beyond the speculative hint size', () => {
  const block = '1' + '0'.repeat(300), cache = new PublicMintPrefetch('a', pairs => {
    assert.deepEqual(pairs, [['p2:7', block]]); return [{ value: null }];
  });
  cache.hint('p2:7', block); assert.equal(cache.hints.size, 0);
  assert.equal(cache.get('p2:7', block), null);
});

test('closure hints without catalog rows batch either ledger family without aliasing answers', () => {
  for (const legacy of [false, true]) {
    const calls = [], id = r.hash('legacy-winner'), asset = n => legacy ? 'p' + n.toString(36) : 'p2:' + n;
    const cache = new PublicMintPrefetch('a', pairs => {
      calls.push(pairs); return pairs.map(([a]) => ({ value: a.startsWith('p2:') ? null : id }));
    });
    cache.node({ value: { claim: { block: '12', patterns: Array.from({ length: 100 }, (_, i) => String(i)) } } });
    for (let i = 0; i < 100; i++) assert.equal(cache.get(asset(i), '12'), legacy ? id : null);
    assert.deepEqual(calls.map(c => c.length), [64, 36]);
    assert.ok(calls.flat().every(([a]) => a.startsWith('p2:') !== legacy));
    assert.equal(cache.get(legacy ? 'p2:0' : 'p0', '12'), legacy ? null : id);
  }
});

test('prefetched closure has byte-identical evidence, checkpoints, roots and work/read/byte charges at every boundary', () => {
  const run = batched => {
    const f = fixture(), plots = Array.from({ length: 40 }, (_, i) => ({ block: String(i + 1), patterns: ['7'] }));
    const cache = new PublicMintPrefetch('a', pairs => pairs.map(() => ({ value: null })));
    for (const plot of plots) cache.plot(plot);
    const evidence = r.publicMintEvidenceReader([], batched ? (a, b) => cache.get(a, b) : () => null, 100000);
    f.state.publicMintGet = evidence.get;
    r.enterClaims({ ...f, plots });
    const storage = new r.ClaimStorage({ get: () => null, cacheSize: 64 });
    let loaded = storage.load({ claimSnapshot: r.initialClaimSnapshot({ bitcoinAnchor: { height: '1200' } }, '1199'),
      claimRoot: r.claimStateRoot(r.initialClaimSnapshot({ bitcoinAnchor: { height: '1200' } }, '1199')) });
    for (const field of r.CLAIM_MAPS) for (const [key, value] of Object.entries(r.recordChanges(f.state[field]))) loaded[field] = r.recordSet(loaded[field], key, value);
    loaded.rounds = [f.event]; const saved = storage.save(loaded), nodes = new Map(saved.writes.map(row => [row.id, row.value]));
    const cold = new r.ClaimStorage({ get: id => nodes.get(id), cacheSize: 1 });
    loaded = cold.load(saved.state); loaded.publicMintGet = evidence.get;
    const event = loaded.rounds[0], chunks = [], settings = { ...f.settings, closureWorkBudget: 17 };
    while (!event.closed) {
      const budget = new ClosureBudget(settings, cold.storage);
      const output = advanceClaimWindow({ state: loaded, event, settings, counted: '1202', decidingHash: hashAt('1202'), budget });
      chunks.push({ output, budget: budget.snapshot(), checkpoint: structuredClone(event) });
      assert.ok(chunks.length < 1000);
    }
    const final = cold.save(loaded);
    return { chunks, claimRoot: final.state.claimRoot, writes: final.writes, evidence: evidence.rows() };
  };
  assert.equal(r.stableJSON(run(true)), r.stableJSON(run(false)));
});
