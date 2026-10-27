import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/store.mjs';
import { Files } from '../../src/files.mjs';
import { Payouts } from '../../src/payouts.mjs';
import { liveHold, holdKey } from '../../local/trac.mjs';
import { rules } from '../../src/rules.mjs';
import { MintOperations } from '../../src/operations.mjs';
import { temp } from '../helpers.mjs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
test('authoritative acceptance retires request crash leftovers before replay', async () => {
  const store = await Store.open(await temp('accepted-inputs-'));
  try {
    await store.transact([{ space: 'mints', id: 'rq', value: { id: 'rq', request: {}, state: 'awaiting_payment' } }, { space: 'mintInputs', id: 'rq/rq', value: { id: 'rq', op: 'rq' } }]);
    const operations = new MintOperations({ store, network: 'dmw-regtest', reads: { pendingAcceptance: async () => ({ created: 100 }) } });
    assert.deepEqual(await operations.inputs({ counted: 101, last: {}, files: [], view: {}, limit: 8 }), []);
    assert.equal(store.count('mintInputs'), 0); assert.equal(store.count('mintApplied'), 1);
    assert.equal(store.get('mints', 'rq').state, 'awaiting_payment');
  } finally { await store.close(); }
});
test('commission obligations accrue once and operator TAP payments reduce published balances', async () => {
  const store = await Store.open(await temp('ledger-')), files = new Files(join(store.directory, 'static')), ledger = new Payouts({ store, files });
  try {
    const split = rules.splitFee('101', { discovered: true }), commissions = rules.commissionOwed('ab'.repeat(32), split, { discoverer: 'discoverer' });
    assert.equal(rules.treasuryPayment(split), '36');
    const draft = { proposal: { batch: { n: 1 } }, items: [{ output: { file: { observation: 1, commissions } } }] };
    await store.transact(ledger.accruals(draft)); assert.deepEqual(ledger.accruals(draft), []);
    await ledger.record({ beneficiary: 'discoverer', amount: '3', txid: 'cd'.repeat(32), reference: 'transfer-1' });
    await ledger.record({ beneficiary: 'discoverer', amount: '3', txid: 'cd'.repeat(32), reference: 'transfer-1' });
    await assert.rejects(ledger.record({ beneficiary: 'discoverer', amount: '3', txid: 'de'.repeat(32), reference: 'transfer-2' }), /payout_exceeds_owed/);
    const published = JSON.parse(await readFile(files.path('records/payouts/beneficiaries/0.json'), 'utf8'));
    assert.equal(published.rows.find(r => r.beneficiary === 'discoverer').owed, '2');
    assert.equal(store.count('payoutPaid'), 1);
  } finally { await store.close(); }
});
test('live block holds remain visible after more than 4096 cold requests', async () => {
  const store = await Store.open(await temp('holds-'));
  try {
    for (let i = 0; i < 4100; i += 100) await store.transact(Array.from({ length: 100 }, (_, j) => ({ space: 'originalPending', id: String(i + j).padStart(64, '0'), value: { asset: 'p0', block: 1, e: 50, s: 1 } })));
    const id = 'ff'.repeat(32); await store.put('liveHolds', holdKey('p0', 1), { id });
    const api = { dmwMint: async key => key === id ? { asset: 'p0', block: 1, e: 532, s: 0 } : null, dmwHead: async () => ({ counted: 100 }) };
    assert.deepEqual(await liveHold(store, api, 'p0', 1), { id, expiry: 532 });
    api.dmwHead = async () => ({ counted: 533 }); assert.equal(await liveHold(store, api, 'p0', 1), null);
  } finally { await store.close(); }
});
