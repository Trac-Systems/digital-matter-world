import test from 'node:test';
import assert from 'node:assert/strict';
import { financialReadCheckout } from '../financial-read-checkout.mjs';

function fixture(admissionPolicy) {
  let revision = 1, hash = 'a', stamps = 0, opens = 0, closes = 0;
  const rows = new Map([['key', { value: 'old' }]]);
  const at = () => ({ counted: '10', tip: '11', tipHash: hash, last: { n: '1', root: 'r' }, revision,
    ...(admissionPolicy ? { admissionPolicy } : {}) });
  const scope = financialReadCheckout({ stamp: async () => { stamps++; return at(); }, open: async version => {
    assert.equal(version, revision); opens++; const frozen = new Map(rows);
    return { get: async key => frozen.get(key), close: async () => { closes++; } };
  } });
  return { scope, at, rows, stats: () => ({ stamps, opens, closes }), advance: () => revision++, reorg: () => { hash = 'b'; } };
}

test('financial point reads share one immutable checkout and close it after success', async () => {
  const f = fixture();
  await f.scope.run(f.at(), async () => {
    f.rows.set('key', { value: 'new' });
    const values = await f.scope.run(f.at(), () => Promise.all(Array.from({ length: 20 }, () => f.scope.read('key', f.at()))));
    assert.deepEqual(values, Array(20).fill('old'));
    assert.equal(await f.scope.read('absent', f.at()), null);
    assert.equal(await f.scope.read('key', { ...f.at(), counted: 10, tip: 11 }), 'old');
  });
  assert.deepEqual(f.stats(), { stamps: 2, opens: 1, closes: 1 });
  assert.equal(f.scope.active(), false);
});

test('revision changes, reorgs and mismatched nested views fail closed and release the checkout', async () => {
  for (const change of ['advance', 'reorg']) {
    const f = fixture();
    await assert.rejects(f.scope.run(f.at(), async () => { await f.scope.read('key'); f[change](); }), /trac_snapshot_changed/);
    assert.deepEqual(f.stats(), { stamps: 2, opens: 1, closes: 1 });
  }
  const f = fixture();
  await assert.rejects(f.scope.run(f.at(), () => f.scope.read('key', { ...f.at(), last: { n: '2' } })), /trac_snapshot_changed/);
  assert.equal(f.stats().closes, 1);
  await assert.rejects(f.scope.run({ ...f.at(), revision: 0 }, () => null), /trac_snapshot_changed/);
  assert.equal(f.stats().opens, 1);
});

test('a detached read cannot use a closed checkout', async () => {
  const f = fixture(); let release, pending;
  const gate = new Promise(resolve => { release = resolve; });
  await f.scope.run(f.at(), async () => { pending = gate.then(() => f.scope.read('key')); });
  release(); await assert.rejects(pending, /trac_snapshot_changed/);
});

test('admission previews preserve their semantic fence across unrelated appends', async () => {
  const f = fixture({ ready: true }), { revision, ...at } = f.at();
  await f.scope.run(at, async () => {
    f.advance(); f.rows.set('key', { value: 'new' });
    assert.equal(await f.scope.read('key', at), 'old');
  });
  await assert.rejects(f.scope.run(at, async () => { f.reorg(); }), /trac_snapshot_changed/);
  assert.deepEqual(f.stats(), { stamps: 4, opens: 2, closes: 2 });
});
