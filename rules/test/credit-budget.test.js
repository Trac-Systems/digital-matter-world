import test from 'node:test';
import assert from 'node:assert/strict';
import { CreditBudget } from '../src/claims-paged.js';
import { stableJSON, utf8 } from '../src/core.js';

// Retain the full remeasurement algorithm as a differential oracle for exact
// packing, including unsuccessful additions and previously returned arrays.
class RemeasuredBudget extends CreditBudget {
  add(winner) {
    const old = this.owners.get(winner.winner) ?? { balances: new Map(), bytes: 0, ops: [] };
    const balances = new Map(old.balances); balances.set(winner.asset, (balances.get(winner.asset) ?? 0n) + BigInt(winner.count));
    const ops = this.ownerOps(winner.winner, balances), bytes = ops.reduce((n, op) => n + utf8(stableJSON(op)).length + 1, 0), s = this.settings;
    if (this.bytes - old.bytes + bytes > s.maxBatchBytes - s.batchEnvelopeReserveBytes || this.ops - old.ops.length + ops.length + 2 > s.maxOps || this.assets - old.balances.size + balances.size > s.maxAssets) return false;
    this.bytes += bytes - old.bytes; this.ops += ops.length - old.ops.length; this.assets += balances.size - old.balances.size;
    this.owners.set(winner.winner, { balances, bytes, ops }); return true;
  }
}

test('incremental credit amounts preserve exact packing across byte, operation and asset limits', () => {
  let seed = 42;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (const settings of [{}, { maxBatchBytes: 4500 }, { maxOps: 5 }, { maxAssets: 19 }, { creditAssetsPerOperation: 1 }]) {
    const prior = [{ op: 'ac', to: 'prior', assets: [['p0', '1']] }];
    const actual = new CreditBudget(settings, prior), expected = new RemeasuredBudget(settings, prior);
    for (let i = 0; i < 1500; i++) {
      const winner = { winner: 'owner/' + random(7), asset: 'p' + random(40), count: String(1 + random(100000)) };
      const retained = actual.operations(), before = stableJSON(retained);
      assert.equal(actual.add(winner), expected.add(winner));
      assert.equal(stableJSON(actual.operations()), stableJSON(expected.operations()));
      assert.deepEqual([actual.bytes, actual.ops, actual.assets], [expected.bytes, expected.ops, expected.assets]);
      assert.equal(stableJSON(retained), before, 'later additions must not mutate returned operations');
    }
  }
});

test('a decimal carry at the exact byte cap refuses the row without changing credits', () => {
  const owner = 'a'.repeat(64), winner = { winner: owner, asset: 'p0', count: '9' };
  const sample = new CreditBudget(); assert.equal(sample.add(winner), true);
  const settings = { maxBatchBytes: sample.bytes + sample.settings.batchEnvelopeReserveBytes };
  const actual = new CreditBudget(settings), expected = new RemeasuredBudget(settings);
  for (const count of ['9', '1', '0', '999999999999999999999999999999999999']) {
    assert.equal(actual.add({ ...winner, count }), expected.add({ ...winner, count }));
    assert.equal(stableJSON(actual.operations()), stableJSON(expected.operations()));
    assert.equal(actual.bytes, expected.bytes);
  }
  assert.deepEqual(actual.operations()[0].assets, [['p0', '9']]);
});
