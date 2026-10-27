import test from 'node:test';
import assert from 'node:assert/strict';
import { headerFixture, headerAgent, network } from '../../rules/test/header-fixture.mjs';
import { rebuildBatch, rules } from '../signer/adapter.mjs';
import { fixture } from './fixture.mjs';
const proposal = built => ({ network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(b => Buffer.from(b).toString('hex')) });

test('committee rederives header finds from witnessed raw headers and rejects altered sources, winners or omitted credits', async () => {
  const f = headerFixture(); f.add(20, [{}]); for (let tip = 21; tip <= 28; tip++) f.add(tip);
  const policy = fixture(); policy.data.counted = 23; policy.reads.batchContext = async () => f.context(); policy.reads.balance = async () => '0';
  const built = f.build(); await policy.policy.approve(proposal(built));
  const context = { ...f.context(), authority: policy.data.authority };
  assert.deepEqual(rebuildBatch(network, proposal(built), context).state, f.state);
  for (const kind of ['source', 'winner', 'omitted']) {
    const files = structuredClone(f.files), last = files.findLast(f => f.settlements.some(s => s.winners.length)), w = last.settlements.find(s => s.winners.length).winners[0];
    if (kind === 'source') w.source = 'claim';
    if (kind === 'winner') { w.winner = headerAgent(2).agent; last.ops.find(o => o.op === 'ac').to = w.winner; }
    if (kind === 'omitted') { last.settlements[0].winners.shift(); last.ops.splice(last.ops.findIndex(o => o.op === 'ac'), 1); }
    const changed = rules.buildBatch({ network, epoch: 0, sequence: 1, lastTo: 14, executionHeight: 23, files });
    assert.throws(() => rebuildBatch(network, proposal(changed), context), /batch_mismatch|file_mismatch/);
  }
});

test('committee independently resumes a large header settlement across accepted batch inputs', () => {
  const f = headerFixture({ count: 500 });
  let n = 0;
  for (let tip = 20; tip <= 36; tip++) {
    const prior = f.state, last = { n, to: prior.counted }, result = f.add(tip, tip === 20 ? [{}] : []);
    const built = rules.buildBatch({ network, epoch: 0, sequence: ++n, lastTo: last.to, executionHeight: result.file.height, files: [result.file] });
    const context = { ...f.context(), state: prior, inputs: [f.inputs.at(-1)], views: [f.context().views.at(-1)], last, authority: { epoch: 0 } };
    assert.deepEqual(rebuildBatch(network, proposal(built), context).state, f.state);
  }
  assert.equal(rules.recordSize(f.state.finds), 500);
});
