import test from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.mjs';
import { rules } from '../src/rules.mjs';

const fakeStore = (rows, state) => {
  const spaces = new Map([['observations', new Map(rows.map(r => [r.id, r.value]))], ['meta', new Map([['ruleState', state]])]]);
  const space = name => spaces.get(name) ?? spaces.set(name, new Map()).get(name);
  return { spaces,
    get: (name, id) => space(name).get(id) ?? null,
    list: name => [...space(name)].sort(([a], [b]) => a < b ? -1 : 1).map(([id, value]) => ({ id, value })),
    hasRows: name => space(name).size > 0,
    put: async (name, id, value) => { space(name).set(id, value); },
    transact: async ops => { for (const op of ops) op.value === undefined ? space(op.space).delete(op.id) : space(op.space).set(op.id, op.value); } };
};
const obs = (id, counted, count = 0) => ({ id, value: { tip: counted, counted, receiptRoot: { count } } });

test('empty observations behind the counted tip are retired; anything else stops the sweep', async () => {
  const store = fakeStore([obs('01', '974277'), obs('02', '974277'), obs('03', '974278'), obs('04', '974277')], { counted: '974278' });
  const pipeline = Object.assign(Object.create(Pipeline.prototype), { store });
  await pipeline.retireStaleEmpty(rules.ordinalCodec(true));
  assert.deepEqual([...store.spaces.get('observations').keys()], ['03', '04'], 'only the leading stale empty entries go');
  assert.deepEqual([...store.spaces.get('observationRecovery').keys()], ['01', '02']);
  assert.equal(store.spaces.get('observationRecovery').get('01').reason, 'stale_empty_observation');
});

test('a stale observation that carries moves is never retired', async () => {
  const store = fakeStore([obs('01', '974277', 1)], { counted: '974278' });
  const pipeline = Object.assign(Object.create(Pipeline.prototype), { store });
  await pipeline.retireStaleEmpty(rules.ordinalCodec(true));
  assert.deepEqual([...store.spaces.get('observations').keys()], ['01']);
  const withIntake = fakeStore([obs('01', '974277')], { counted: '974278' }); withIntake.spaces.set('intake/01', new Map([['x', {}]]));
  await Object.assign(Object.create(Pipeline.prototype), { store: withIntake }).retireStaleEmpty(rules.ordinalCodec(true));
  assert.deepEqual([...withIntake.spaces.get('observations').keys()], ['01']);
});

test('a stale empty numbered segment moves to the counted height instead of leaving a gap', async () => {
  const seg = (id, counted, segment) => ({ id, value: { tip: '974755', counted, confirmed: counted, receiptRoot: { count: 0, segment } } });
  const store = fakeStore([seg('16', '974755', '16'), seg('17', '974756', '17')], { counted: '974756' });
  await Object.assign(Object.create(Pipeline.prototype), { store }).retireStaleEmpty(rules.ordinalCodec(true));
  assert.deepEqual([...store.spaces.get('observations').keys()], ['16', '17'], 'segment 16 stays ahead of 17');
  assert.deepEqual(store.get('observations', '16'), { tip: '974755', counted: '974756', confirmed: '974755', receiptRoot: { count: 0, segment: '16' } });
  assert.equal(store.spaces.get('observationRecovery')?.size ?? 0, 0);
});
