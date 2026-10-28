import test from 'node:test';
import assert from 'node:assert/strict';
import { financialInventoryPage, acceptedFinancialRecord } from '../src/financial-inventory.mjs';
import { installRecoverySources } from '../src/financial-recovery-sources.mjs';
import { applyFinancialLifecycle, recoveryEnd } from '../../contract/financial-lifecycle.js';
import { assetSettings } from '../../contract/asset-settings.js';
import { rules as r } from '../src/rules.mjs';

const view = db => ({ async *createReadStream({ gte, gt, lt, limit }) {
  let count = 0;
  for (const [key, value] of [...db].sort(([a], [b]) => a < b ? -1 : 1)) if (key >= gte && (!gt || key > gt) && key < lt && count++ < limit) yield { key, value };
} });

test('financial inventory pages include auxiliary and migration keys without scanning unrelated state', async () => {
  const db = new Map([['ar/' + r.hash('owner'), { root: r.hash('root'), revision: '0' }], ['fp/chain', { bitcoin: 'anchor' }],
    ['fm/capacity/' + r.hash('deployment'), '3'], ['fi/deployment/legacy', '2'], ['dc/plot/c1/9007199254740992', r.hash('mint')],
    ['fd/asset/c1', r.hash('generation')], ['k/link/16', '{"block":"42"}'], ['unrelated/private', 'not returned']]);
  const actual = []; let after = '';
  for (;;) {
    const page = await financialInventoryPage(view(db), { after, limit: 2 }); if (!page.length) break;
    assert.ok(page.length <= 2); actual.push(...page.map(row => row.key)); after = page.at(-1).key;
  }
  assert.deepEqual(actual, [...db.keys()].filter(k => !k.startsWith('unrelated/')).sort());
  await assert.rejects(financialInventoryPage(view(db), { after: 'unrelated/', limit: 2 }), /financial_inventory_range/);
});

test('native recovery inventory refuses omitted records and pages before sealing its accepted manifest', async () => {
  const id = r.hash('recovery'), previous = r.hash('previous'), tip = r.hash('tip'), at = { tipHash: previous, counted: '20', last: { n: '2' } };
  const db = new Map([['ar/' + r.hash('owner'), { root: r.hash('accounts'), revision: '0' }],
    ['fc/' + r.hash('credit'), { owner: r.hash('owner'), fees: [], revision: '0' }], ['fm/capacity/' + r.hash('deployment'), '3'],
    ['br/' + id + '/meta', { state: 'building', previous: { hash: previous } }]]);
  const reads = { financialRecord: async key => db.get(key) ?? null,
    financialInventoryPage: range => financialInventoryPage(view(db), range),
    financialRecordProvenance: async key => ({ anchor: { canonical: key.startsWith('fm/') } }),
    financialAnchorCanonical: async anchor => anchor.canonical,
    financialCanonicalBitcoinHash: async () => tip };
  installRecoverySources(reads);
  reads.financialRecoveryStage = async () => ({ meta: db.get('br/' + id + '/meta'), tip: { height: '21', hash: tip } });
  const apply = async action => {
    const evidence = await reads.financialRecoveryEvidence(action, at);
    await applyFinancialLifecycle({ get: async key => db.get(key), put: (key, value) => value === null ? db.delete(key) : db.set(key, value) },
      { op: 'fp', v: 2, type: 'lifecycle', id, action, evidence: r.hashObject(evidence) }, { network: 'dmw-regtest', height: '20', limits: assetSettings() });
  };
  await apply({ type: 'recovery-inventory', id, previous, tip });
  await assert.rejects(apply({ type: 'recovery-inventory-seal', id }), /financial_inventory_incomplete/);
  const items = await reads.financialRecoveryItems({ after: '', limit: 2 }, at);
  await assert.rejects(apply({ type: 'recovery-inventory-page', id, cursor: '', limit: 2, items: items.slice(1) }), /financial_inventory_complete_range/);
  await apply({ type: 'recovery-inventory-page', id, cursor: '', limit: 2, items });
  const cursor = db.get('fr/' + id).cursor, tail = await reads.financialRecoveryItems({ after: cursor, limit: 2 }, at);
  await apply({ type: 'recovery-inventory-page', id, cursor, limit: 2, items: tail });
  await apply({ type: 'recovery-inventory-seal', id });
  assert.equal(db.get('fr/' + id).count, '3');
  while (db.get('fr/' + id).next !== recoveryEnd) {
    const row = db.get('fr/' + id), page = db.get('fr/' + id + '/page/' + row.next);
    await assert.rejects(apply({ type: 'recovery-page', id, sequence: row.sequence, items: [], next: page.next }), /financial_recovery_inventory_page/);
    await apply({ type: 'recovery-page', id, sequence: row.sequence, ...page });
  }
  assert.equal(db.get('fr/' + id).processed, '3');
  assert.equal(db.get('fq/fc/' + r.hash('credit')).recovery, id);
  assert.equal(db.has('fq/fm/capacity/' + r.hash('deployment')), false);
});

test('record provenance binds the exact accepted record hash and financial input', async () => {
  const key = 'fc/' + r.hash('credit'), value = { revision: '0' }, anchor = { bitcoin: { height: '1', hash: r.hash('block') }, ethereum: null };
  const store = { get: async () => ({ n: '3', file: 0, index: 0 }) }, input = { recordCommitments: [[key, r.hashObject(value)]], chainAnchor: anchor, transition: { type: 'refund' } };
  const args = { store, audits: async () => [{ financialOperations: [input] }], key, value };
  assert.deepEqual((await acceptedFinancialRecord(args)).anchor, anchor);
  await assert.rejects(acceptedFinancialRecord({ ...args, value: { revision: '1' } }), /financial_record_provenance_binding/);
  input.recordCommitments[0][0] = 'fc/' + r.hash('other');
  await assert.rejects(acceptedFinancialRecord(args), /financial_record_provenance_binding/);
});
