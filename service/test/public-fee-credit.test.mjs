import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFinancialOperations } from '../src/public-financial.mjs';
import { FinancialMints } from '../src/financial-mints.mjs';
import { surplusCreditId } from '../../contract/payment-pages.js';

const id = '12'.repeat(32), owner = '23'.repeat(32), fee = '34'.repeat(32);
function fixture() {
  const rows = new Map(), key = (s, id) => s + '/' + id;
  const store = { get: (s, id) => rows.get(key(s, id)) ?? null,
    list: (s, { limit }) => [...rows].filter(([k]) => k.startsWith(s + '/')).slice(0, limit).map(([k, value]) => ({ id: k.slice(s.length + 1), value })) };
  const put = (space, id, value) => rows.set(key(space, id), value);
  const project = (input, writes) => {
    for (const w of writes) put(w.space, w.id, w.value);
    const draft = { proposal: { batch: { n: '1' } }, items: [{ output: { file: { observation: '1', financialOperations: [input] } } }] };
    for (const w of publicFinancialOperations(store, draft, writes)) put(w.space, w.id, w.value);
  };
  put('publicFinancialTerms', id, { id, owner, kind: 'tap', fees: [] });
  put('mints', id, { id, state: 'expired', reason: 'credited', kind: 'tap', request: { asset: 'p2:1', amount: '3', owner, expires: '106' }, quote: { fees: [] } });
  const mints = Object.create(FinancialMints.prototype); Object.assign(mints, { store, document: { values: { paymentPage: 1 } } });
  return { store, put, project, mints };
}

test('public credit origin and original credited total survive spending and transfer without double counting', () => {
  const f = fixture(), row = { owner, fees: [{ key: fee, amount: '10' }], revision: '0' };
  const input = { transition: { type: 'refund', id, reason: 'credit' }, evidence: { state: 'credit', owner } };
  const writes = [{ space: 'accountRecords', id: 'fc/' + id, value: row }];
  f.project(input, writes); f.project(input, writes);
  assert.deepEqual(f.store.get('financialCreditTotals', id), { amount: '10', count: 1, firstCreditId: id });
  let status = f.mints.public(id);
  assert.equal(status.state, 'expired'); assert.equal(status.reason, 'credited'); assert.equal(status.creditedAmount, '10'); assert.equal(status.creditId, id);
  const used = { ...row, revision: '1', fees: [{ key: fee, amount: '0' }] };
  f.project({ transition: { type: 'lifecycle', id: '45'.repeat(32), action: { type: 'credit-use', operation: { credit: id } } }, evidence: { owner } },
    [{ space: 'accountRecords', id: 'fc/' + id, value: used }]);
  const credit = f.store.get('publicResults/credits', id);
  assert.equal(credit.amount, '0'); assert.equal(credit.state, 'spent'); assert.equal(credit.creditedAmount, '10');
  assert.deepEqual(credit.origin, { requestId: id, orderId: null });
  assert.equal(f.mints.public(id).creditedAmount, '10');
  f.project({ transition: { type: 'lifecycle', id, action: { type: 'credit-transfer', operation: { credit: id, to: fee } } }, evidence: {} },
    [{ space: 'accountRecords', id: 'fc/' + id, value: { ...used, owner: fee, revision: '2' } }]);
  assert.deepEqual(f.store.get('publicResults/credits', id).origin, credit.origin);
  assert.equal(f.store.get('financialCreditTotals', id).count, 1);
});

test('surplus credits keep the original request and total even when the status credit list is bounded', () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) {
    const credit = surplusCreditId(id, String(n));
    f.project({ transition: { type: 'surplus', id, items: [] }, evidence: {}, operations: [{ op: 'fp', type: 'surplus', sequence: String(n) }] },
      [{ space: 'accountRecords', id: 'fc/' + credit, value: { owner, revision: '0', fees: [{ key: fee, amount: '4' }] } }]);
    assert.deepEqual(f.store.get('publicResults/credits', credit).origin, { requestId: id, orderId: null });
  }
  const status = f.mints.public(id); assert.equal(status.creditedAmount, '12'); assert.equal(status.creditsCount, 3); assert.equal(status.credits.length, 1);
});

test('updating a historical credit never mislabels its remaining balance as the original credited amount', () => {
  const f = fixture();
  f.put('publicResults/credits', id, { id, owner, revision: '0', amount: '7', fees: [{ key: fee, amount: '7' }] });
  f.project({ transition: { type: 'lifecycle', id, action: { type: 'credit-use', operation: { credit: id } } }, evidence: { owner } },
    [{ space: 'accountRecords', id: 'fc/' + id, value: { owner, revision: '1', fees: [{ key: fee, amount: '2' }] } }]);
  const credit = f.store.get('publicResults/credits', id);
  assert.equal(credit.amount, '2'); assert.equal(credit.creditedAmount, null);
  assert.equal(f.store.get('financialCreditTotals', id), null);
});
