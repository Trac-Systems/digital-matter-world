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

test('a mint the player inscribed with their own wallet is taken up by the server once, while its permit waits for it', async t => {
  const issued = 'aa'.repeat(32), recorded = 'bb'.repeat(32), sending = 'cc'.repeat(32);
  const sent = txid => ({ kind: 'mint', phase: 'mint', revealTxid: txid, inscriptionId: txid + 'i0' });
  const mints = tickOnly([{ id: issued, state: 'permit_issued', permit: {} }, { id: recorded, state: 'permit_issued', permit: {}, mintInscription: '22'.repeat(32) + 'i0' },
    { id: sending, state: 'awaiting_payment' }], { [`mint/${issued}/mint`]: sent('11'.repeat(32)), [`mint/${recorded}/mint`]: sent('22'.repeat(32)), [`mint/${sending}/mint`]: sent('33'.repeat(32)) });
  await mints.tick();
  assert.deepEqual(mints.paid, [{ id: issued, inscription: '11'.repeat(32) + 'i0' }], 'only the issued mint without a recorded inscription; a mint report never counts as a payment');
});

test('a Bitmap link fee payment its page reported as sent is counted by the server, at most every 30 seconds', async t => {
  const { FinancialLinks } = await import('../src/financial-links.mjs');
  const { serial } = await import('../src/util.mjs');
  const id = 'ee'.repeat(32), sentId = '44'.repeat(32) + 'i0';
  const spaces = { financialPendingLinks: new Map([[id, true]]), financialLinks: new Map([[id, { id, request: { until: '999', owner: 'ff'.repeat(32) } }]]),
    accountRecords: new Map([['fp/' + id, { state: 'open' }]]), inflight: new Map([[`link/${id}/payment`, { inscriptionId: sentId }]]) };
  const store = { get: (space, key) => spaces[space]?.get(key) ?? null, put: async () => {}, transact: async () => {},
    list: (space, { after = '', limit }) => [...spaces[space].keys()].filter(k => k > after).slice(0, limit).map(k => ({ id: k })) };
  const links = Object.create(FinancialLinks.prototype), pages = [];
  Object.assign(links, { store, resources: { workPage: 32 }, gate: serial(), reads: { batchStamp: async () => ({ counted: '10' }) }, paymentPage: async (row, refs) => { pages.push(refs); } });
  await links.tick(); await links.tick();
  assert.deepEqual(pages, [[sentId]]);
});
