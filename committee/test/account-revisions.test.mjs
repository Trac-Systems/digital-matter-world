import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccountRevisions } from '../signer/account-revisions.mjs';

const owner = 'ab'.repeat(32), other = 'cd'.repeat(32);
const entry = { move: { t: 'transfer-v2', a: owner } };
const context = inputs => ({ inputs, counted: '100', last: { n: '7', to: '100' } });
const input = revision => ({ entries: [entry], accountRevisions: [[owner, revision]] });

test('account rejection evidence is checked against independent records and cannot invent or omit owners', async () => {
  const reads = { financialRecord: async (key, at) => {
    assert.equal(key, 'ar/' + owner); assert.deepEqual(at, { counted: '100', last: { n: '7', to: '100' } });
    return { revision: '3' };
  } };
  await verifyAccountRevisions(context([input('3')]), reads);
  await assert.rejects(verifyAccountRevisions(context([input('4')]), reads), /account_revision_read/);
  for (const rows of [[], [[other, '3']], [[owner, '3'], [owner, '3']]])
    await assert.rejects(verifyAccountRevisions(context([{ ...input('3'), accountRevisions: rows }]), reads), /account_revision_evidence/);
  await assert.rejects(verifyAccountRevisions(context([input('3')]), {}), /account_revision_reader/);
  await assert.rejects(verifyAccountRevisions(context([input('3')]), { financialRecord: async () => { throw Error('source_unavailable'); } }), /source_unavailable/);
});

test('account revisions project earlier credit and financial operations, with legacy contexts still supported', async () => {
  const first = { entries: [], accountOperations: [{ op: 'ar', accounts: [{ owner, revision: '3' }] }],
    financialOperations: [{ operations: [{ op: 'ar', accounts: [{ owner, revision: '4' }] }] }] };
  await verifyAccountRevisions(context([first, input('5')]), { financialRecord: async () => { throw Error('unnecessary_read'); } });
  await assert.rejects(verifyAccountRevisions(context([first, input('3')]), { financialRecord: async () => null }), /account_revision_read/);
  await verifyAccountRevisions(context([{ entries: [entry] }]), {});
  await verifyAccountRevisions(context([input('0')]), { financialRecord: async () => null });
});
