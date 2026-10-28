import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditedReplay } from '../signer/replay-cache.mjs';
const fixture = () => ({ network: 'test', proposal: { batch: { settingsHash: 'settings', root: 'root' } },
  context: { state: { claimRoot: 'claims' }, inputs: [{ tip: '10', height: '9', claimEvidence: { nodes: [['node', { value: 1 }]] } }],
    history: { length: 11 }, hashAt: h => 'hash/' + h } });
test('only a successful full audit caches one exact replay; preparation gets an independent copy', async () => {
  let calls = 0; const f = fixture(), cache = new AuditedReplay(async () => ({ digest: String(++calls), files: [{ value: 1 }] }));
  const run = () => cache.run(f.network, f.proposal, f.context);
  await assert.rejects(cache.audit(async () => { await run(); throw Error('preflight_failed'); }), /preflight_failed/);
  assert.equal((await run()).digest, '2');
  await cache.audit(run); const cached = await run(); assert.equal(cached.digest, '3'); cached.files[0].value = 9;
  assert.equal((await run()).files[0].value, 1); assert.equal(calls, 3);
  cache.clear(); assert.equal((await run()).digest, '4');
});
test('changed proof, accepted state, proposal and verified branch always replay', async () => {
  const mutations = [f => { f.context.inputs[0].claimEvidence.nodes = []; }, f => { f.context.state.claimRoot = 'changed'; },
    f => { f.proposal.batch.root = 'conflict'; }, f => { f.context.hashAt = h => 'fork/' + h; }, f => { f.context.history.length++; }];
  for (const mutate of mutations) {
    let calls = 0; const f = fixture(), cache = new AuditedReplay(async () => ({ digest: String(++calls) }));
    await cache.audit(() => cache.run(f.network, f.proposal, f.context)); mutate(f);
    await cache.run(f.network, f.proposal, f.context); assert.equal(calls, 2);
  }
});
