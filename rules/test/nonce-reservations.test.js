import test from 'node:test';
import assert from 'node:assert/strict';
import { financialPlan, financialBatchOperations, financialReserveGroups, mergedReservePlans } from '../src/financial-execution.js';
import { hashObject } from '../src/core.js';
import { SETTINGS_PROFILE, settingsRevision } from '../src/settings-v2.js';

const document = settingsRevision({ network: 'nonce-reserve-test', effectiveBatch: '1', effectiveBitcoinWindow: '10', values: SETTINGS_PROFILE });
const hex = n => n.toString(16).padStart(64, '0');
const input = n => {
  const evidence = { owner: hex(1), asset: 'p0', amount: '3', fees: [{ key: hex(2), amount: '1' }] };
  return { transition: { type: 'reserve', id: hex(n), fees: evidence.fees,
    action: { type: 'reserve-n', owner: hex(1), id: hex(n), asset: 'p0', amount: '3', terms: hashObject(evidence), nonce: hex(100 + n), until: '20', sig: 'a'.repeat(128) } }, evidence };
};
for (const count of [2, 5]) test(`rules bind ${count} nonce reserves to one account operation and individual funding effects`, async () => {
  const inputs = Array.from({ length: count }, (_, i) => input(i + 10));
  const plans = await Promise.all(inputs.map(i => financialPlan(i, { read: async () => null, height: '10', document })));
  const merged = mergedReservePlans(plans);
  assert.equal(merged.flat().filter(op => op.op === 'ar').length, 1);
  assert.deepEqual(merged[0][0].actions, inputs.map(i => i.transition.action));
  assert.deepEqual(merged.flat().filter(op => op.type === 'open').map(op => op.id), inputs.map(i => i.transition.id));
  inputs.forEach((i, n) => { i.operations = merged[n].map(op => ({ ...op, v: 2 })); });
  inputs[0].reserveGroup = count;
  assert.deepEqual(financialBatchOperations(inputs, document), inputs.flatMap(i => i.operations));
  for (const change of [
    g => { g[0].reserveGroup = count + 1; },
    g => { g[0].reserveGroup = 0; },
    g => { g[0].reserveGroup = null; },
    g => { g[1].reserveGroup = 1; },
    g => { g[1].transition.action.owner = hex(8); },
    g => { g[1].transition.action.type = 'reserve'; },
  ]) {
    const group = structuredClone(inputs); change(group);
    assert.throws(() => financialReserveGroups(group), /financial_reserve_group/);
  }
  const altered = input(99); altered.evidence.amount = '4';
  await assert.rejects(financialPlan(altered, { read: async () => null, height: '10', document }), /financial_reservation/);
});
