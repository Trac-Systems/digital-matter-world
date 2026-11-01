import test from 'node:test';
import assert from 'node:assert/strict';
import { FinancialMints } from '../src/financial-mints.mjs';
import { KeyedWork } from '../src/keyed-work.mjs';

// The mint tick alone, over a small in-memory store: no request page is open.
function tickOnly(rows, inflight) {
  const spaces = { mints: new Map(rows.map(r => [r.id, r])), financialActiveMints: new Map(rows.map(r => [r.id, true])), financialIssuedMints: new Map(),
    financialLegacyCredits: new Map(), inflight: new Map(Object.entries(inflight)) };
  const store = {
    get: (space, id) => spaces[space]?.get(id) ?? null,
    list: (space, { after = '', limit }) => [...(spaces[space] ?? new Map()).keys()].sort().filter(id => id > after).slice(0, limit).map(id => ({ id, value: spaces[space].get(id) })),
    put: async (space, id, value) => { spaces[space].set(id, value); },
  };
  const mints = Object.create(FinancialMints.prototype);
  Object.assign(mints, { store, resources: { workPage: 32 }, publicMints: { tick: async () => {} }, mintWork: new KeyedWork(), advanced: [], paid: [] });
  mints.advance = async row => { mints.advanced.push(row.id); };
  mints.payment = async input => { mints.paid.push(input); return mints.mintWork.run(input.id, async () => null); };
  return mints;
}

test('a sent TAP fee payment is reported by the server itself, at most every 30 seconds, and only while the request waits for it', async t => {
  const waiting = 'aa'.repeat(32), paid = 'bb'.repeat(32), unsent = 'cc'.repeat(32), wallet = 'dd'.repeat(32);
  const sent = txid => ({ kind: 'mint', phase: 'payment', revealTxid: txid, inscriptionId: txid + 'i0' });
  const mints = tickOnly([{ id: waiting, state: 'awaiting_payment' }, { id: paid, state: 'paid' }, { id: unsent, state: 'partly_paid' }, { id: wallet, state: 'awaiting_payment', publicMint: true }],
    { [`mint/${waiting}/payment`]: sent('11'.repeat(32)), [`mint/${paid}/payment`]: sent('22'.repeat(32)), [`mint/${wallet}/payment`]: sent('33'.repeat(32)) });
  await mints.tick();
  assert.deepEqual(mints.paid, [{ id: waiting, paymentIds: ['11'.repeat(32) + 'i0'] }]);
  assert.deepEqual(mints.advanced.sort(), [waiting, paid, unsent, wallet].sort(), 'every request still advances');
  await mints.tick();
  assert.equal(mints.paid.length, 1, 'the next pass within 30 seconds does not ask again');
  mints.sentPaymentChecks.set(waiting, Date.now() - 30000);
  mints.payment = async input => { mints.paid.push(input); throw Error('payment_unseen'); };
  await mints.tick();
  assert.equal(mints.paid.length, 2, 'asked again after 30 seconds');
  mints.sentPaymentChecks.set(waiting, Date.now() - 30000);
  await assert.doesNotReject(mints.tick(), 'a payment not yet confirmed waits for the next pass');
});
