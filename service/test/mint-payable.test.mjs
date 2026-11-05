import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMint, Mints } from '../src/mints.mjs';
import { FinancialMints } from '../src/financial-mints.mjs';

const id = '11'.repeat(32);
function fixture() {
  const row = { id, kind: 'tap', state: 'awaiting_payment', created: '100', expiry: '106',
    request: { owner: id, asset: 'p2:0', amount: '1', expires: '106' }, quote: { fees: [], price: '10' } };
  const data = new Map([['mints/' + id, row], ['meta/ruleState', { counted: '106' }],
    ['accountRecords/fp/' + id, { state: 'open', paid: ['0'] }]]);
  const store = { get: (s, k) => data.get(s + '/' + k), list: () => [] };
  const legacy = Object.assign(Object.create(Mints.prototype), { store });
  const financial = Object.assign(Object.create(FinancialMints.prototype), { store, document: { values: { paymentPage: 32 } } });
  return { row, data, statuses: () => [publicMint(row, data.get('meta/ruleState').counted), legacy.public(id), financial.public(id)] };
}

test('mint payment display closes after pay-by even while expiry is deferred', () => {
  const f = fixture();
  assert.ok(f.statuses().every(s => s.payable));
  f.data.set('meta/ruleState', { counted: '107' });
  for (const status of f.statuses()) {
    assert.equal(status.payable, false);
    assert.equal(status.state, 'awaiting_payment');
  }
  assert.equal(f.row.state, 'awaiting_payment');
  delete f.row.expiry;
  assert.ok(f.statuses().every(s => !s.payable), 'retained rows use the signed request deadline');
});

test('only an on-time report within its confirmation hold keeps the payment display open', () => {
  const f = fixture();
  f.row.paymentSeen = { firstSeenBlock: '106', confirmByBlock: '109' };
  f.data.set('meta/ruleState', { counted: '109' });
  assert.ok(f.statuses().every(s => s.payable));
  f.data.set('meta/ruleState', { counted: '110' });
  assert.ok(f.statuses().every(s => !s.payable));
  f.data.set('meta/ruleState', { counted: '107' });
  f.row.paymentSeen.firstSeenBlock = '107';
  assert.ok(f.statuses().every(s => !s.payable));
  f.row.paymentSeen = true;
  assert.ok(f.statuses().every(s => !s.payable));
});

test('a confirmation hold does not reopen terminal or fenced financial requests', () => {
  const f = fixture();
  f.row.paymentSeen = { firstSeenBlock: '106', confirmByBlock: '109' };
  f.data.set('meta/ruleState', { counted: '107' });
  f.row.state = 'expired';
  assert.ok(f.statuses().every(s => !s.payable));
  f.row.state = 'awaiting_payment';
  f.data.set('meta/financialRecoveryActive', true);
  assert.equal(f.statuses()[2].payable, false);
});
