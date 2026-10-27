import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { History } from '../src/history.mjs';
import { Replay } from '../src/replay.mjs';
import { Intake } from '../src/intake.mjs';
import { initialState, rules } from '../src/rules.mjs';
import { temp, fixtureHistory, patterns, agent, network, secret, attestRoot, receiptSigners } from './helpers.mjs';
test('discovery scans over 20,000 disk headers in the background worker', async () => {
  const store = await Store.open(await temp()), fixture = fixtureHistory(20030), history = new History(store), replay = new Replay();
  try {
    for (let first = 0; first < fixture.length; first += 1000) {
      const end = Math.min(fixture.length, first + 1000), operations = [];
      for (let h = first; h < end; h++) operations.push({ space: 'headers', id: String(h).padStart(16, '0'), value: { raw: fixture.raw(h), hash: fixture.hashAt(h) } });
      operations.push({ space: 'meta', id: 'headerHeight', value: end - 1 }); await store.transact(operations);
    }
    const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0, discoveryMaxHeight: 2000000 }), who = agent(), tip = 20006;
    await intake.observe({ tip, hash: history.hashAt(tip), counted: tip - 5, confirmed: tip - 5 });
    const proposal = { name: 'dmwones', pat: '1', fld: 4, dt: 'n' }, salt = 'ab'.repeat(32);
    let state = initialState(tip, history.hashAt(tip), tip - 6), table = patterns, found = false;
    for (let offset = 0; offset < 16; offset++) {
      const current = tip + offset;
      if (offset === 0 || offset === 2) {
        const move = rules.solveMove({ v: 1, network, a: who.address, t: offset ? 'discovery-reveal' : 'discovery-commit', b: current, h: history.hashAt(current),
          p: offset ? { proposal, salt } : { commitment: rules.discoveryCommitment(proposal, salt, who.address) } }, who.secret, 0);
        await intake.accept(rules.stableJSON(move));
      }
      const entries = intake.entries().map(r => r.value);
      const observation = await intake.observe({ tip: current + 1, hash: history.hashAt(current + 1), counted: current - 4, confirmed: current - 4 });
      const output = await replay.run({ height: current - 5, blockHash: history.hashAt(current - 5), tip: current, tipHash: history.hashAt(current), network, gateway: intake.gateway,
        state, patterns: table, entries, receiptRoot: observation.receiptRoot, rootAttestations: entries.length ? await attestRoot(observation.receiptRoot) : [], settings: { puzzleBits: 0, receiptSigners } }, history);
      for (const move of output.file.moves) assert.equal(move.reason, 'accepted');
      assert.ok(output.file.discovery.work <= 4096);
      found ||= output.file.discoveries.some(d => d.record.name === proposal.name);
      state = output.state; table = output.patterns;
    }
    assert.equal(found, true);

  } finally { await replay.close(); await store.close(); }
});
