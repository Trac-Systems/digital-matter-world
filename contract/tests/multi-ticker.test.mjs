import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFinancialLifecycle } from '../financial-lifecycle.js';
import { MULTI_TICKER_HEIGHT } from '../../rules/src/multi-ticker-activation.js';
import { hashObject } from '../../rules/src/core.js';
const asset = 'p2:0', first = 'a'.repeat(64), second = 'b'.repeat(64), request = 'c'.repeat(64), other = 'd'.repeat(64);
const id = n => n.repeat(64) + 'i0';
function fixture() {
  const records = new Map([['fd/asset/' + asset, first], ['fd/' + first, { asset, deployment: id('1'), generation: '0', maximum: '100', minted: '0', reserved: '0', limit: '0' }]]);
  const store = { get: async k => records.get(k), put: (k, v) => records.set(k, v) };
  const apply = (action, height = MULTI_TICKER_HEIGHT) => applyFinancialLifecycle(store, { op: 'fp', v: 2, type: 'lifecycle', id: action.id, action, evidence: 'e'.repeat(64) }, { network: 'test', height, limits: {} });
  return { records, apply };
}
const addition = { type: 'deployment-add', id: second, asset, deployment: id('2'), official: first, maximum: '100', limit: '0' };
test('additional registration is gated, requires official, and leaves official records unchanged', async () => {
  const f = fixture(), before = structuredClone(f.records.get('fd/' + first));
  await assert.rejects(f.apply(addition, String(BigInt(MULTI_TICKER_HEIGHT) - 1n)), /multi_ticker_inactive/);
  await assert.rejects(f.apply({ ...addition, official: 'f'.repeat(64) }), /deployment_identity/);
  await f.apply(addition);
  assert.equal(f.records.get('fd/asset/' + asset), first);
  assert.deepEqual(f.records.get('fd/' + first), before);
  assert.equal(f.records.get('fd/external/' + hashObject(id('2'))), second);
});
test('asset occurrence stays spent when a second ticker is selected, including outstanding permits', async () => {
  const f = fixture(); await f.apply(addition);
  for (const key of [request, other]) f.records.set('ao/' + key, { state: 'reserved', asset, amount: '3', terms: 'f'.repeat(64) });
  await f.apply({ type: 'capacity-reserve', id: request, deployment: first, plot: '12' });
  await assert.rejects(f.apply({ type: 'capacity-reserve', id: other, deployment: second, plot: '12' }), /capacity_plot/);
  const obligation = f.records.get('ao/' + request); obligation.state = 'consumed'; obligation.permitHash = '9'.repeat(64);
  await f.apply({ type: 'capacity-issue', id: request, permitHash: obligation.permitHash });
  await f.apply({ type: 'capacity-finish', id: request, permitHash: obligation.permitHash });
  await assert.rejects(f.apply({ type: 'capacity-reserve', id: other, deployment: second, plot: '12' }), /capacity_plot/);
  await f.apply({ type: 'capacity-reserve', id: other, deployment: second, plot: '13' });
  assert.equal(f.records.get('fd/' + first).minted, '3'); assert.equal(f.records.get('fd/' + second).reserved, '3');
});
