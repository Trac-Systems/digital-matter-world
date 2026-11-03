import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, b, r, digest, address } from './bulk-helpers.mjs';
const { accountKey, readAccountLeaf } = await import('../../contract/account-tree.js');
const { AccountAvailability } = await import('../src/account-availability.mjs');
const { capacityKey, plotKey } = await import('../../contract/financial-capacity.js');
const { Payouts } = await import('../src/payouts.mjs');
const { publicFinancialOperations } = await import('../src/public-financial.mjs');
const { acceptedFinancialReservation } = await import('../src/financial-sources.mjs');
const balance = f => {
  const key = accountKey('balance', 'p2:123'), head = f.store.get('accountRecords', 'ar/' + f.owner);
  return readAccountLeaf(head.root, new AccountAvailability(f.store).prove(head.root, [key]), key);
};

test('bulk 64-member full lifecycle uses one owner proof and conserves official units', async t => {
  const f = await fixture(t), quote = await f.bulk.quote(f.input(64)), id = quote.orderId;
  await f.bulk.request(f.sign(quote)); const reserved = await f.execute();
  const account = reserved.operations.find(op => op.op === 'ar'); assert.equal(account.accounts.length, 1);
  assert.equal(account.actions.filter(a => a.type === 'reserve-n').length, 1);
  assert.equal(balance(f).held, '192');
  assert.equal(f.store.get('accountRecords', capacityKey(quote.terms.deployment)), '192');
  await f.bulk.payment({ orderId: id, paymentId: f.payment(quote), commitTxid: null, revealTxid: null }); const paid = await f.execute();
  await f.bulk.tick(); const consumed = await f.execute(); await f.bulk.tick();
  assert.equal(balance(f).held, '0'); assert.equal((await f.bulk.permit(id)).complete, true);
  let bytes = r.stableJSON([reserved.inputs, paid.inputs, consumed.inputs]).length;
  for (let start = 0; start < 64; start += 16) {
    const members = await f.reveal(id, Array.from({ length: 16 }, (_, i) => start + i));
    await f.bulk.finish({ orderId: id, members }); const result = await f.execute(); bytes += r.stableJSON(result.inputs).length;
    assert.equal((await f.bulk.finish({ orderId: id, members })).progress.minted, start + 16);
  }
  const status = await f.bulk.status(id); assert.equal(status.state, 'minted'); assert.equal(status.progress.unresolved, 0);
  assert.equal(f.store.count('activeBulkOrders'), 0); assert.equal(f.store.get('accountRecords', capacityKey(quote.terms.deployment)), '0');
  assert.equal(f.store.get('accountRecords', 'fd/' + f.generation).minted, '192');
  assert.ok(bytes < 1500000, 'whole lifecycle evidence fits audit bound');
  assert.ok(f.count() < 30, 'reads coalesce transactions, not one read per member');
});

test('bulk extra ticker units remain held until each verified finish page', async t => {
  const f = await fixture(t, { extra: true }), quote = await f.bulk.quote(f.input(2)), id = quote.orderId;
  await f.bulk.request(f.sign(quote)); await f.execute();
  await f.bulk.payment({ orderId: id, paymentId: f.payment(quote), commitTxid: null, revealTxid: null }); await f.execute();
  await f.bulk.tick(); await f.execute(); await f.bulk.tick(); assert.equal(balance(f).held, '6');
  await f.bulk.finish({ orderId: id, members: await f.reveal(id, [0]) }); await f.execute(); assert.equal(balance(f).held, '3');
  await f.bulk.finish({ orderId: id, members: await f.reveal(id, [1]) }); await f.execute(); assert.equal(balance(f).held, '0'); assert.equal(balance(f).available, '100000');
});

test('bulk pending admission races reserve every member plot and exact aggregate balance', async t => {
  const f = await fixture(t, { units: '6', remaining: '6' });
  const q1 = await f.bulk.quote(f.input(2)), q2 = await f.bulk.quote(f.input(2, 'competitor'));
  const results = await Promise.allSettled([f.bulk.request(f.sign(q1)), f.bulk.request(f.sign(q2))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.store.count('financialQueue'), 1); assert.equal(f.store.get('financialAdmissionHeld', f.owner + '/p2:123'), '6');
  assert.equal(f.store.count('financialAdmissionPlot'), 2);
  assert.ok(f.store.get('financialAdmissionPlot', plotKey('p2:123', '900001')));
  await f.execute(); assert.equal(f.store.count('financialAdmissionPlot'), 0); assert.equal(f.store.get('financialAdmissionHeld', f.owner + '/p2:123'), '0');
});

test('bulk two disjoint reserves merge into one current owner proof', async t => {
  const f = await fixture(t), one = f.input(), two = f.input(1, 'second'); two.blocks = ['900001'];
  const quotes = await Promise.all([f.bulk.quote(one), f.bulk.quote(two)]);
  await Promise.all(quotes.map(q => f.bulk.request(f.sign(q)))); const result = await f.execute();
  assert.equal(result.inputs[0].reserveGroup, 2);
  assert.equal(result.operations.filter(op => op.op === 'ar').length, 1);
  assert.equal(result.operations.find(op => op.op === 'ar').accounts.length, 1);
});

test('bulk partial primary cannot combine another redeem; expiry creates receipt-backed liabilities', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input(2)), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute();
  const partial = f.payment(q, 'partial', [0]);
  await f.bulk.payment({ orderId: id, paymentId: partial, commitTxid: null, revealTxid: null }); await f.execute();
  assert.equal((await f.bulk.status(id)).state, 'partly_paid');
  const extra = f.payment(q, 'duplicate');
  await f.bulk.payment({ orderId: id, paymentId: extra, commitTxid: null, revealTxid: null }); await f.execute();
  assert.equal(f.store.get('accountRecords', 'fp/' + id).reference, partial);
  assert.equal(f.store.get('accountRecords', 'fp/bulk-credit/' + b.bulkReceiptKey(f.bitcoinNetwork, extra)).state, 'credited');
  f.height(String(BigInt(q.terms.expires) + 1n)); await f.bulk.tick(); await f.execute();
  const liability = f.store.get('accountRecords', 'fp/bulk-credit/' + b.bulkReceiptKey(f.bitcoinNetwork, partial));
  assert.equal(liability.groups.length, q.terms.groups.length - 1);
  assert.equal(balance(f).held, '0'); assert.equal(balance(f).available, '100000');
  assert.equal((await f.bulk.status(id)).state, 'credited');
});

test('bulk missing transfer row stays unknown; wrong payer, domain and amount reject', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input()), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute(); const reference = f.payment(q), tx = f.transactions.get(reference.slice(0, 64));
  const saved = structuredClone(tx.transfers); tx.transfers.pop();
  await assert.rejects(f.reads.bulkReceipt(id, reference, f.stamp()), /bulk_payment_unknown/);
  tx.transfers = saved;
  for (const [key, value] of [['addr', 'attacker'], ['amt', '1'], ['dta', 'dmw-pay-v2|' + id + '|finder']]) {
    const old = tx.transfers[0].value[key]; tx.transfers[0].value[key] = value;
    await assert.rejects(f.reads.bulkReceipt(id, reference, f.stamp()), /bulk_payment_(binding|unknown)/); tx.transfers[0].value[key] = old;
  }
  assert.equal((await f.bulk.status(id)).payable, true);
});

test('bulk restart recovers accepted provenance and drains with ingress disabled', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input(2)), id = q.orderId;
  const body = f.sign(q); await f.bulk.request(body); const reserved = await f.execute();
  await f.store.put('financialAdmissions', id, { n: '1', file: 0, index: 0 });
  assert.deepEqual(await acceptedFinancialReservation({ store: f.store, audits: async () => [{ financialOperations: reserved.inputs }], id }), f.accepted.get(id));
  await f.restart(); assert.equal((await f.bulk.request(body)).state, 'awaiting_payment');
  await assert.rejects(f.bulk.quote(f.input(1, 'disabled')), /bulk_disabled/);
  await f.bulk.payment({ orderId: id, paymentId: f.payment(q), commitTxid: null, revealTxid: null }); await f.execute();
  await f.bulk.tick(); await f.execute(); await f.bulk.tick(); assert.equal((await f.bulk.permit(id)).complete, true);
});

test('bulk custody and deferred commissions project once from accepted deltas', async t => {
  const f = await fixture(t, { suspense: true }), q = await f.bulk.quote(f.input(2)), id = q.orderId;
  await f.bulk.request(f.sign(q)); const reserve = await f.execute();
  await f.bulk.payment({ orderId: id, paymentId: f.payment(q), commitTxid: null, revealTxid: null }); const paid = await f.execute();
  await f.bulk.tick(); const consume = await f.execute();
  const claims = consume.writes.filter(w => w.id.startsWith('bc/')); assert.equal(claims.length, 2);
  for (const claim of claims) assert.equal((await f.reads.bulkCustodyOriginal(claim.value, f.stamp())).fee.amount, claim.value.amount);
  for (const result of [reserve, paid, consume]) await f.store.transact(publicFinancialOperations(f.store, result.draft, result.writes));
  const burned = q.feeManifest.reduce((n, m) => n + BigInt(m.shares.find(s => s.role === 'burn')?.payable ?? '0'), 0n).toString();
  assert.equal(f.store.get('publicSummaries', 'burn').tap, burned);
  await f.store.transact(publicFinancialOperations(f.store, paid.draft, paid.writes));
  assert.equal(f.store.get('publicSummaries', 'burn').tap, burned);
  const totals = f.store.get('payoutTotals', 'custody/' + f.owner + '/tap');
  assert.equal(totals.accrued, q.terms.custody.reduce((n, c) => n + BigInt(c.amount), 0n).toString());
  await f.store.transact(publicFinancialOperations(f.store, consume.draft, consume.writes));
  assert.equal(f.store.get('payoutTotals', 'custody/' + f.owner + '/tap').accrued, totals.accrued);
  const memberId = b.bulkMemberId(id, 0), commission = { id: memberId, role: 'deployer', deployment: q.terms.deployment,
    to: q.terms.payer, amount: '7', payoutMinAtoms: '100' };
  const draft = { proposal: { batch: { n: '5' } }, items: [{ output: { file: { observation: '2', financialOperations: [
    { transition: { type: 'bulk-finish', id }, evidence: { members: [{ index: 0, memberId, inscription: digest('mint') + 'i0', commissions: [commission] }] } }] } } }] };
  const payouts = new Payouts({ store: f.store }); await f.store.transact(payouts.accruals(draft));
  assert.deepEqual(payouts.accruals(draft), []);
});

test('bulk and a signed single share last-unit and plot admission holds', async t => {
  const { ed25519 } = await import('../../contract/node_modules/@noble/curves/ed25519.js');
  const { reserveNonceDigest } = await import('../../contract/root-accounts.js');
  for (const conflict of ['balance', 'plot']) {
    const f = await fixture(t, conflict === 'balance' ? { units: '3', remaining: '3' } : {});
    const q = await f.bulk.quote(f.input()), id = digest('single-' + conflict);
    const evidence = { owner: f.owner, asset: 'p2:123', amount: '3', fees: [{ key: digest('fee'), amount: '1' }],
      capacity: { deployment: f.deployment.id, asset: 'p2:123', amount: '3', block: conflict === 'plot' ? '900000' : '900001', remaining: f.deployment.remaining, limit: '0', supplyScope: null } };
    const action = { type: 'reserve-n', id, owner: f.owner, asset: 'p2:123', amount: '3', terms: r.hashObject(evidence), nonce: digest('single-nonce'), until: q.terms.until };
    action.sig = Buffer.from(ed25519.sign(reserveNonceDigest(f.network, action), f.secret)).toString('hex');
    const transition = { type: 'reserve', id, action, fees: evidence.fees };
    const original = f.reads.financialEvidence;
    f.reads.financialEvidence = (input, at) => input.id === id ? structuredClone(evidence) : original(input, at);
    const settled = await Promise.allSettled([f.financial.admit(transition, f.stamp()), f.bulk.request(f.sign(q))]);
    assert.equal(settled.filter(v => v.status === 'fulfilled').length, 1);
    assert.equal(f.store.count('financialQueue'), 1);
    assert.equal(f.store.get('financialAdmissionHeld', f.owner + '/p2:123'), '3');
    assert.equal(f.store.count('financialAdmissionPlot'), 1);
  }
});

test('bulk pending holds also protect the smaller internal capacity', async t => {
  const f = await fixture(t, { maximum: '3' }), a = f.input(), z = f.input(1, 'another'); z.blocks = ['900001'];
  const quotes = await Promise.all([f.bulk.quote(a), f.bulk.quote(z)]);
  const results = await Promise.allSettled(quotes.map(q => f.bulk.request(f.sign(q))));
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
  assert.match(results.find(v => v.status === 'rejected').reason.message, /financial_generation_capacity_reserved/);
  assert.equal(f.store.count('financialQueue'), 1);
});

test('bulk four-order backpressure retains issued unresolved slots', async t => {
  const f = await fixture(t, { withhold: 0 }); let first;
  f.financial.resources.bulkOrdersPerAgent = f.bulk.resources.bulkOrdersPerAgent = 4;
  for (let i = 0; i < 4; i++) {
    const input = f.input(1, 'slot-' + i); input.blocks = [String(900000 + i)];
    const q = await f.bulk.quote(input); first ??= q; await f.bulk.request(f.sign(q));
  }
  await f.execute();
  await f.bulk.payment({ orderId: first.orderId, paymentId: f.payment(first), commitTxid: null, revealTxid: null }); await f.execute();
  await f.bulk.tick(); await f.execute(); await f.bulk.tick();
  const input = f.input(1, 'fifth'); input.blocks = ['900004'];
  await assert.rejects(f.bulk.request(f.sign(await f.bulk.quote(input))), /bulk_order_capacity/);
  assert.equal(f.store.count('activeBulkOrders'), 4);
});

test('bulk source and delivered permits fail closed after quarantine at the same tip', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input()), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute();
  await f.bulk.payment({ orderId: id, paymentId: f.payment(q), commitTxid: null, revealTxid: null }); await f.execute();
  await f.bulk.tick(); await f.execute(); await f.bulk.tick();
  await f.reads.bulkPermit(id, 0, f.stamp());
  const receipt = b.bulkReceiptKey(f.bitcoinNetwork, f.store.get('accountRecords', 'fp/' + id).reference);
  await f.store.put('accountRecords', 'fq/fp/bulk-receipt/' + receipt, { reason: 'reorg' });
  await assert.rejects(f.reads.bulkPermit(id, 0, f.stamp()), /financial_quarantined/);
  await assert.rejects(f.bulk.permit(id), /financial_quarantined/);
  assert.equal((await f.bulk.status(id)).state, 'needs_attention');
  assert.equal((await f.bulk.status(id)).payable, false);
});

test('bulk background discovery and detached reveals finish with the page closed', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input(2)), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute();
  const reference = f.payment(q), tx = f.transactions.get(reference.slice(0, 64)); tx.complete.transfers = false;
  let discovered = false;
  f.reads.bulkDiscoverPayments = async () => ({ references: discovered ? [] : (discovered = true, [reference]), next: 1 });
  await f.bulk.tick(); assert.equal((await f.bulk.status(id)).payable, true);
  assert.deepEqual(f.bulk.row(id).discoveryPending, [reference]);
  tx.complete.transfers = true;
  await f.bulk.tick(); await f.execute(); await f.bulk.tick(); await f.execute(); await f.bulk.tick();
  const members = await f.reveal(id);
  f.reads.bulkMintMatches = async ({ expected }) => { assert.equal(expected.length, 2); return members; };
  await f.bulk.tick(); await f.execute();
  assert.equal((await f.bulk.status(id)).state, 'minted');
});

test('bulk data-domain discovery indexes bounded history once and invalidates forked locations', async t => {
  const { TapLookupIndex } = await import('../prod/tap-index.mjs');
  const f = await fixture(t), q = await f.bulk.quote(f.input()), id = q.orderId;
  const reference = digest('located') + 'i2', legacy = digest('legacy') + 'i0';
  let hash = digest('canonical'), calls = 0;
  let values = [{ ins: legacy, rdm: { items: [{ dta: 'dmw-pay-v2|' + id + '|0' }] } },
    { ins: reference, rdm: { items: [{ dta: b.bulkPaymentData(id, 0) }] } }];
  const index = new TapLookupIndex({ indexer: { bitcoin: { blockHash: async () => hash }, stamp: async () => ({ height: 100, hash }),
    tap: async path => { calls++; if (path.includes('Length/')) return values.length;
      const url = new URL(path, 'http://localhost');
      assert.equal(Number(url.searchParams.get('max')), Math.min(500, values.length - Number(url.searchParams.get('offset'))));
      return values.slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + Number(url.searchParams.get('max'))); } } });
  t.after(() => index.close()); f.reads.lookups = index;
  const first = await f.reads.bulkDiscoverPayments(id, q.terms); assert.deepEqual(first.references, [reference]);
  assert.equal(first.next, 2);
  assert.deepEqual((await f.reads.bulkDiscoverPayments(id, q.terms, { after: first.next })).references, []);
  assert.ok(calls <= 3);
  hash = digest('replacement'); values = [{ ins: digest('replacement') + 'i0', rdm: { items: [{ dta: b.bulkPaymentData(id, 0) }] } }];
  const fork = await f.reads.bulkDiscoverPayments(id, q.terms, { after: first.next, epoch: first.epoch });
  assert.deepEqual(fork.references, [values[0].ins]);
  const otherCursor = await f.reads.bulkDiscoverPayments(id, q.terms, { after: first.next, epoch: first.epoch });
  assert.deepEqual(otherCursor.references, fork.references, 'every order notices a shared payer cursor reset');
});

test('bulk late-only receipt remains available for verified set-aside recovery after release', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input()), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute();
  f.height(String(BigInt(q.terms.expires) + 1n)); await f.bulk.tick(); await f.execute();
  assert.equal(f.store.count('activeBulkOrders'), 0);
  const reference = f.payment(q, 'late-only');
  await f.bulk.payment({ orderId: id, paymentId: reference, commitTxid: null, revealTxid: null }); await f.execute();
  const status = await f.bulk.status(id); assert.equal(status.state, 'credited');
  assert.equal(status.payment.reference, null); assert.equal(status.progress.issued, 0);
  assert.equal((await f.bulk.senderItem(id)).item.paymentId, reference);
  assert.equal((await f.bulk.senderPage()).rows[0].orderId, id);
  const reads = f.count();
  f.reads.bulkDiscoverPayments = async () => ({ references: [reference], next: 1, epoch: '1' });
  await f.bulk.tick(); assert.equal(f.count(), reads, 'a reset discovery cursor does not reload an already allocated receipt');
  assert.deepEqual(f.bulk.row(id).references, []);
  await f.store.put('accountRecords', 'fq/fp/bulk-credit/' + b.bulkReceiptKey(f.bitcoinNetwork, reference), { reason: 'reorg' });
  await assert.rejects(f.bulk.senderItem(id), /financial_quarantined/);
  assert.equal((await f.bulk.status(id)).state, 'needs_attention');
});

test('bulk member funding remains compatible with public-winner point reads', async t => {
  const { bulkPublicReads } = await import('../../committee/signer/bulk-mint.mjs');
  const { readPublicWinner, readPublicWinnerBatch } = await import('../src/public-claim-readers.mjs');
  const f = await fixture(t), q = await f.bulk.quote(f.input());
  await f.bulk.request(f.sign(q)); await f.execute();
  const reads = bulkPublicReads(f.reads, f.store), context = { store: f.store, reads, at: f.stamp() };
  assert.equal(await readPublicWinner(context, q.terms.asset, q.terms.members[0].block), null);
  assert.deepEqual(await readPublicWinnerBatch(context, [[q.terms.asset, q.terms.members[0].block]]), [{ value: null }]);
  assert.equal(await f.reads.financialRecord('fp/' + b.bulkMemberId(q.orderId, 0)), null, 'canonical records never synthesize member funding');
});

test('bulk maximum 64-member 131-group lifecycle fits audits and accrues pinned holder shares at finish', async t => {
  const f = await fixture(t, { baseFee: '1000000000000000000', values: {
    legacyDeployShareBps: 0, legacyDeployPayoutMinAtoms: '100', deployerShareBps: 500 } });
  for (let i = 0; i < 64; i++) {
    const block = String(900000 + i), c = await f.reads.assetContext('p2:123', block, { bulkMint: true });
    c.link = { owner: f.owner, block, linkHeight: '974137' }; c.holder = { address: address(80 + i), agent: f.owner };
    c.finderAddress = address(16 + i); c.discoverer = address(150); c.beneficiaries.discoverer = digest('discoverer');
    f.contexts.set(block, c);
  }
  const q = await f.bulk.quote(f.input(64)), id = q.orderId;
  assert.equal(q.terms.members.length, 64); assert.equal(q.terms.groups.length, 131);
  assert.equal(q.feeManifest[0].deferred.deployer, '50000000000000000');
  const sizes = [], record = result => { sizes.push(Buffer.byteLength(r.stableJSON(result.inputs))); return result; };
  await f.bulk.request(f.sign(q)); record(await f.execute());
  await f.bulk.payment({ orderId: id, paymentId: f.payment(q), commitTxid: null, revealTxid: null }); record(await f.execute());
  await f.bulk.tick(); record(await f.execute()); await f.bulk.tick();
  const payouts = new Payouts({ store: f.store }); f.holderAddress(address(151));
  for (let start = 0; start < 64; start += 16) {
    await f.bulk.finish({ orderId: id, members: await f.reveal(id, Array.from({ length: 16 }, (_, i) => start + i)) });
    const result = record(await f.execute());
    assert.ok(result.inputs[0].evidence.members.every(m => m.commissions[0].to === address(151) && m.commissions[0].id === m.memberId));
    await f.store.transact(payouts.accruals(result.draft)); assert.deepEqual(payouts.accruals(result.draft), []);
  }
  assert.equal(f.store.count('commissionOwed'), 64);
  assert.equal((await f.bulk.status(id)).state, 'minted');
  assert.ok(sizes.reduce((a, n) => a + n, 0) < 1500000); assert.ok(f.count() < 30);
  t.diagnostic(JSON.stringify({ members: 64, groups: 131, signedRequestBytes: Buffer.byteLength(r.stableJSON(f.sign(q))),
    financialAuditBytes: sizes, totalAuditBytes: sizes.reduce((a, n) => a + n, 0), transactionReads: f.count() }));
});

test('bulk terminal pages reject reordered and duplicate members without queue writes', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input(2)), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute();
  await f.bulk.payment({ orderId: id, paymentId: f.payment(q), commitTxid: null, revealTxid: null }); await f.execute();
  await f.bulk.tick(); await f.execute(); await f.bulk.tick();
  const members = await f.reveal(id);
  for (const invalid of [[...members].reverse(), [members[0], members[0]]]) {
    await assert.rejects(f.bulk.finish({ orderId: id, members: invalid }), /bulk_member_page/);
    assert.equal(f.store.count('financialQueue'), 0); assert.equal(f.store.get('accountRecords', 'fp/' + id).finishedMask, '0');
  }
  await f.bulk.finish({ orderId: id, members }); await f.execute();
  assert.equal((await f.bulk.finish({ orderId: id, members })).progress.minted, 2);
  assert.equal(f.store.count('financialQueue'), 0);
});

test('bulk byte deferral preserves the complete pending reservation unchanged', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input(64)), body = f.sign(q);
  await f.bulk.request(body);
  f.financial.document = r.settingsRevision({ network: f.network, effectiveBatch: '1', effectiveBitcoinWindow: '974137',
    values: { ...f.document.values, batchBytes: 8192 } });
  const result = await f.financial.build({ height: '974137', at: f.stamp() });
  assert.equal(result.inputs.length, 0); assert.equal(result.operations.length, 0);
  assert.equal(result.deferred[0].reason, 'financial_batch_bytes');
  assert.equal(f.store.count('financialQueue'), 1); assert.deepEqual(f.bulk.row(q.orderId).body, body);
  assert.equal(f.store.get('financialAdmissionHeld', f.owner + '/p2:123'), '192');
  f.financial.document = f.document; await f.execute();
  assert.equal((await f.bulk.status(q.orderId)).progress.reserved, 64);
});

test('late bulk receipt is recovered automatically once and projects a spendable fee credit', async t => {
  const f = await fixture(t, { values: { pendingBlocks: 6 }, suspense: true });
  const quote = await f.bulk.quote(f.input(2)), id = quote.orderId;
  await f.bulk.request(f.sign(quote)); const reserve = await f.execute();
  await f.store.transact(publicFinancialOperations(f.store, reserve.draft, reserve.writes));
  const reference = f.payment(quote, 'delayed'), tx = f.transactions.get(reference.slice(0, 64));
  f.transactions.delete(reference.slice(0, 64));
  await f.bulk.payment({ orderId: id, paymentId: reference, commitTxid: null, revealTxid: null });
  f.height(String(BigInt(quote.terms.expires) + 1n)); await f.bulk.tick(); await f.execute();
  assert.equal((await f.bulk.status(id)).state, 'expired'); assert.equal(balance(f).held, '0');
  tx.inclusion.height = String(BigInt(quote.terms.expires) + 2n); f.height(tx.inclusion.height);
  f.payment(quote, 'delayed', [], tx.inclusion.height); await f.bulk.tick();
  assert.equal(f.store.get('bulkFailures', id), null);
  const recovered = await f.execute();
  await f.store.transact(publicFinancialOperations(f.store, recovered.draft, recovered.writes));
  const creditId = b.bulkReceiptKey(f.bitcoinNetwork, reference), credit = f.store.get('accountRecords', 'fc/' + creditId);
  assert.deepEqual(credit.fees, b.bulkRecoveryFees(quote.terms, quote.feeManifest, quote.terms.groups.map(g => g.amount)));
  assert.equal(credit.owner, f.owner); assert.equal(credit.revision, '0');
  const status = await f.bulk.status(id);
  assert.equal(status.creditId, creditId); assert.equal(status.creditedAmount, quote.terms.payableFeeAtoms);
  const projected = f.store.get('publicResults/credits', creditId);
  assert.equal(projected.state, 'available'); assert.deepEqual(projected.origin, { requestId: null, orderId: id });
  await f.bulk.tick();
  assert.equal(f.store.count('financialQueue'), 0);
  assert.deepEqual(f.store.get('accountRecords', 'fc/' + creditId), credit, 'repeated recovery never duplicates value');
});

for (const pending of ['bulk-fund', 'bulk-consume']) test(`expired ${pending} preserves a signed draft and recovers payment after unsigned work retires`, async t => {
  const f = await fixture(t, { values: { pendingBlocks: 6 } }), q = await f.bulk.quote(f.input(2)), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute();
  const reference = f.payment(q, 'queued-' + pending);
  await f.bulk.payment({ orderId: id, paymentId: reference, commitTxid: null, revealTxid: null });
  if (pending === 'bulk-consume') { await f.execute(); await f.bulk.tick(); }
  const work = f.bulk.row(id).work;
  assert.equal(f.store.get('financialQueue', work).type, pending);
  await f.store.put('meta', 'draft', { proposal: { batch: { ops: [{ op: 'fp', id }] } } });
  f.height(String(BigInt(q.terms.expires) + 1n)); await f.bulk.tick();
  assert.equal(f.bulk.row(id).work, work); assert.equal(f.store.get('financialRejected', work), null);
  assert.equal(balance(f).held, '6');
  await f.store.transact([{ space: 'meta', id: 'draft' }]); await f.bulk.tick();
  assert.equal(f.store.get('financialRejected', work).reason, 'reservation_expired');
  await f.execute(); await f.bulk.tick();
  if (pending === 'bulk-fund') await f.execute();
  const credit = f.store.get('accountRecords', 'fc/' + b.bulkReceiptKey(f.bitcoinNetwork, reference));
  assert.equal(credit.fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString(), q.terms.payableFeeAtoms);
  assert.equal(balance(f).held, '0'); assert.equal(balance(f).available, '100000');
});
