import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, b, r, address, digest, sharedFixture } from './bulk-helpers.mjs';
const { verifyBulkRequest, checkBulkRecoveryBytes } = await import('../src/bulk-mint-sources.mjs');

test('bulk shared fixture validates and exact reserve signature pins all quoted fields', async t => {
  b.validateBulkFees(sharedFixture.terms, sharedFixture.feeManifest);
  const f = await fixture(t), quote = await f.bulk.quote(f.input(2)), body = f.sign(quote);
  assert.equal(await verifyBulkRequest(body, f.network, f.bitcoinNetwork), quote.orderId);
  assert.equal(quote.terms.totalAmount, '6');
  assert.equal(quote.payable, false);
  for (const field of ['payer', 'receiver']) {
    const changed = structuredClone(body); changed.terms[field] = address(10);
    await assert.rejects(verifyBulkRequest(changed, f.network, f.bitcoinNetwork), /bulk_signature/);
  }
  const changed = structuredClone(body); changed.reserve.extra = true;
  await assert.rejects(verifyBulkRequest(changed, f.network, f.bitcoinNetwork), /bulk_signature/);
  const unknown = structuredClone(body); unknown.terms.extra = true;
  await assert.rejects(verifyBulkRequest(unknown, f.network, f.bitcoinNetwork), /bulk_terms/);
});

test('bulk computes rounding and self exemption per member before grouping', async t => {
  const f = await fixture(t, { self: true }), quote = await f.bulk.quote(f.input(3));
  const one = quote.feeManifest[0];
  assert.equal(quote.terms.grossFeeAtoms, '303');
  assert.equal(one.shares.find(s => s.role === 'finder').payable, '0');
  assert.equal(one.shares.find(s => s.role === 'finder').group, null);
  assert.equal(quote.terms.payableFeeAtoms, String(3n * one.shares.reduce((n, s) => n + BigInt(s.payable), 0n)));
  b.validateBulkFees(quote.terms, quote.feeManifest);
  assert.equal(quote.terms.custody.length, 0);
});

test('bulk aggregation retains distinct suspense beneficiaries at the same destination', async t => {
  const f = await fixture(t, { suspense: true });
  const first = await f.bulk.quote(f.input(2));
  assert.equal(first.terms.custody.length, 2);
  assert.equal(first.terms.custody[0].group, first.terms.custody[1].group);
  assert.equal(first.terms.custody[0].owner, f.owner);
  assert.notEqual(b.bulkCustodyFeeKey(first.orderId, first.terms.custody[0]), b.bulkCustodyFeeKey(first.orderId, first.terms.custody[1]));
  b.validateBulkFees(first.terms, first.feeManifest);
});

test('bulk quotes sort, skip minted plots, and defer only the eligible funding tail', async t => {
  const f = await fixture(t, { maxMembers: 2 }); f.skipped.add('900001');
  const input = f.input(4); input.blocks.reverse();
  const quote = await f.bulk.quote(input);
  assert.deepEqual(quote.terms.members.map(m => m.block), ['900000', '900002']);
  assert.deepEqual(quote.skipped, [{ block: '900001', reason: 'already_minted' }]);
  assert.deepEqual(quote.deferred, [{ block: '900003', reason: 'bulk_funding_limit' }]);
  await assert.rejects(f.bulk.quote({ ...input, blocks: ['900000', '900000'] }), /bulk_quote_input/);
  await assert.rejects(f.bulk.quote(f.input(65)), /bulk_quote_input/);
});

test('bulk no-member quote has no signable identity or terms', async t => {
  const f = await fixture(t); f.skipped.add('900000');
  const quote = await f.bulk.quote(f.input());
  assert.equal(quote.terms, null); assert.equal(quote.orderId, null); assert.equal(quote.quoteId, null);
  assert.deepEqual(quote.feeManifest, []);
});

test('bulk quote clones shared contexts and rejects an accepted-state change', async t => {
  const f = await fixture(t), input = f.input(2), context = await f.reads.assetContext(input.asset, '900000', { bulkMint: true });
  f.contexts.set('900000', context); const before = structuredClone(context);
  await Promise.all([f.bulk.quote(input), f.bulk.quote({ ...input, nonce: digest('other') })]);
  assert.deepEqual(context, before);
  f.bulk.resources.bulkQuoteAttempts = 1;
  let calls = 0;
  f.stampHook(() => { if (++calls === 4) f.height('974138'); });
  await assert.rejects(f.bulk.quote({ ...input, nonce: digest('stale') }), /financial_snapshot_changed/);
});

test('bulk request is reserving until accepted, exact retry is stable and changed terms conflict', async t => {
  const f = await fixture(t), quote = await f.bulk.quote(f.input(2)), body = f.sign(quote);
  const initial = await f.bulk.request(body);
  assert.equal(initial.state, 'reserving'); assert.equal(initial.payable, false);
  assert.equal(f.store.get('financialAdmissionHeld', f.owner + '/' + body.terms.asset), '6');
  assert.equal((await f.bulk.request(body)).orderId, initial.orderId);
  assert.equal(f.store.count('financialQueue'), 1);
  const alternate = structuredClone(quote); alternate.terms.receiver = address(8);
  await assert.rejects(f.bulk.request(f.sign(alternate)), /bulk_request_conflict/);
  await f.execute();
  assert.equal((await f.bulk.status(initial.orderId)).state, 'awaiting_payment');
  assert.equal((await f.bulk.status(initial.orderId)).payable, true);
});

test('bulk request rejects a stale signed quote and never reserves a smaller set', async t => {
  const f = await fixture(t), quote = await f.bulk.quote(f.input(3));
  f.skipped.add('900002');
  await assert.rejects(f.bulk.request(f.sign(quote)), /bulk_member_conflict/);
  assert.equal(f.store.count('financialQueue'), 0); assert.equal(f.store.count('activeBulkOrders'), 0);
  f.height('974140');
  await assert.rejects(f.bulk.request(f.sign(quote)), /bulk_request_expired/);
});

test('bulk permit pagination uses requested windows even while one signature is withheld', async t => {
  const f = await fixture(t, { withhold: 0 }), quote = await f.bulk.quote(f.input(17)), id = quote.orderId;
  await f.bulk.request(f.sign(quote)); await f.execute();
  await f.bulk.payment({ orderId: id, paymentId: f.payment(quote), commitTxid: null, revealTxid: null }); await f.execute();
  await f.bulk.tick(); await f.execute(); await f.bulk.tick();
  const page = await f.bulk.permit(id);
  assert.equal(page.complete, false); assert.equal(page.readyCount, 16); assert.equal(page.members.length, 15); assert.equal(page.next, 16);
  const last = await f.bulk.permit(id, { offset: 16, limit: 16 }); assert.equal(last.members.length, 1); assert.equal(last.next, null);
  assert.ok(f.maxActive() <= 4);
  f.height('999999'); await f.bulk.tick();
  assert.equal(f.store.get('accountRecords', 'fp/' + id).releasedMask, '0');
  assert.equal(f.store.count('activeBulkOrders'), 1);
});

test('bulk shared schemas enforce the 64 member and 131 group ceilings', () => {
  assert.equal(b.BULK_LIMITS.members, 64); assert.equal(b.BULK_LIMITS.groups, 131);
  const t = structuredClone(sharedFixture.terms); t.groups = Array.from({ length: 132 }, () => t.groups[0]);
  assert.throws(() => b.validateBulkTerms(t), /bulk_groups/);
});

test('bulk exact retry repairs a crash after admission while ingress is disabled', async t => {
  const f = await fixture(t), q = await f.bulk.quote(f.input()), body = f.sign(q);
  await f.bulk.request(body);
  const row = { ...f.bulk.row(q.orderId) }; delete row.work;
  await f.store.put('bulkOrders', q.orderId, row); await f.restart();
  assert.equal((await f.bulk.request(body)).state, 'reserving');
  assert.equal(f.store.count('financialQueue'), 1);
  assert.ok(f.bulk.row(q.orderId).work);
  const changed = structuredClone(body); changed.reserve.sig = '0'.repeat(128);
  await assert.rejects(f.bulk.request(changed), /bulk_request_conflict/);
});

test('bulk quote honors internal capacity and rejects a single unfundable member', async t => {
  const f = await fixture(t, { maximum: '3' }), q = await f.bulk.quote(f.input(2));
  assert.equal(q.terms.members.length, 1);
  assert.deepEqual(q.skipped, [{ block: '900001', reason: 'insufficient_units' }]);
  const unfundable = await fixture(t, { maxMembers: 0 });
  await assert.rejects(unfundable.bulk.quote(unfundable.input()), e => e.status === 422 && e.message === 'bulk_funding_limit');
  await assert.rejects(f.bulk.request({ version: 1, terms: null }), e => e.status === 422);
});

test('bulk quote defers a byte-heavy eligible tail before anything is signed', async t => {
  const f = await fixture(t), input = f.input();
  // Canonical integer strings have no lifetime digit cap. The ordinary mint
  // payload still has its explicit byte cap, independent of quote input bytes.
  input.blocks.push('9'.repeat(2000));
  const q = await f.bulk.quote(input);
  assert.equal(q.terms.members.length, 1);
  assert.deepEqual(q.deferred, [{ block: input.blocks[1], reason: 'bulk_byte_limit' }]);
  assert.ok(Buffer.byteLength(r.stableJSON(f.sign(q))) <= b.BULK_LIMITS.requestBytes);
});

test('bulk admission reserves enough of the existing operation byte limit for its full recovery credit', () => {
  const wire = structuredClone(sharedFixture.max64), terms = wire.terms, manifest = wire.feeManifest;
  const scale = value => String(BigInt(value) * 10n ** 17n);
  terms.grossFeeAtoms = scale(terms.grossFeeAtoms); terms.payableFeeAtoms = scale(terms.payableFeeAtoms);
  terms.groups = terms.groups.slice(0, 2).map(group => ({ ...group, amount: '0' }));
  terms.custody = [];
  for (const member of manifest) {
    member.grossFeeAtoms = scale(member.grossFeeAtoms);
    for (const share of member.shares) {
      share.gross = scale(share.gross); share.payable = scale(share.payable);
      share.group = share.role === 'burn' ? 0 : 1;
      terms.groups[share.group].amount = String(BigInt(terms.groups[share.group].amount) + BigInt(share.payable));
      if (['finder', 'landowner', 'discoverer'].includes(share.role)) {
        share.beneficiary = terms.owner;
        terms.custody.push({ member: member.member, role: share.role, group: share.group, owner: terms.owner, amount: share.payable });
      }
    }
  }
  terms.feeRoot = b.bulkFeeRoot(manifest);
  b.validateBulkFees(terms, manifest);
  assert.ok(Buffer.byteLength(r.stableJSON({ terms, feeManifest: manifest })) < b.BULK_LIMITS.requestBytes);
  assert.throws(() => checkBulkRecoveryBytes(b, terms, manifest), /bulk_byte_limit/);
  assert.doesNotThrow(() => checkBulkRecoveryBytes(b, sharedFixture.max64.terms, sharedFixture.max64.feeManifest));
});

test('bulk quote batches member lock reads and reads shared generation capacity once', async t => {
  const f = await fixture(t), record = f.reads.financialRecord, records = f.reads.financialRecords;
  let generations = 0; const pages = [];
  f.reads.financialRecord = async (key, at) => { if (key === 'fd/' + f.generation) generations++; return record(key, at); };
  f.reads.financialRecords = async (keys, at) => { pages.push(keys); return records(keys, at); };
  const q = await f.bulk.quote(f.input(64));
  assert.equal(q.terms.members.length, 64); assert.equal(generations, 1);
  assert.equal(pages.length, 3); assert.ok(pages.every(keys => keys.length === 64));
});

test('six-block bulk expiry releases slots while reported payment is still unconfirmed', async t => {
  const f = await fixture(t, { values: { pendingBlocks: 6 } });
  const quote = await f.bulk.quote(f.input(2)); await f.bulk.request(f.sign(quote)); await f.execute();
  const id = quote.orderId, row = f.store.get('bulkOrders', id), reference = 'ee'.repeat(32) + 'i0';
  await f.store.put('bulkOrders', id, { ...row, references: [reference] });
  f.height(String(BigInt(quote.terms.expires) + 1n));
  await f.bulk.tick(); await f.execute();
  assert.equal((await f.bulk.status(id)).state, 'expired');
  assert.equal(f.store.count('activeBulkOrders'), 0);
  assert.deepEqual(f.store.get('bulkOrders', id).references, [reference]);
  assert.equal(f.store.get('bulkPaymentRecovery', id), true);
});

for (const stage of ['bulk-fund', 'bulk-consume']) test(`six-block expiry retires an unsigned queued ${stage} and releases the order`, async t => {
  const f = await fixture(t, { values: { pendingBlocks: 6 } }), q = await f.bulk.quote(f.input(2)), id = q.orderId;
  await f.bulk.request(f.sign(q)); await f.execute();
  await f.bulk.payment({ orderId: id, paymentId: f.payment(q), commitTxid: null, revealTxid: null });
  if (stage === 'bulk-consume') { await f.execute(); await f.bulk.tick(); }
  assert.equal(f.store.list('financialQueue', { limit: 1 })[0].value.type, stage);
  f.height(String(BigInt(q.terms.expires) + 1n)); await f.bulk.tick();
  assert.equal(f.store.list('financialQueue', { limit: 1 })[0].value.type, 'bulk-release');
  await f.execute();
  assert.ok(['expired', 'credited'].includes((await f.bulk.status(id)).state)); assert.equal(f.store.count('activeBulkOrders'), 0);
  await f.bulk.tick();
  if (f.store.count('financialQueue')) await f.execute();
  assert.ok(f.store.get('accountRecords', 'fp/bulk-credit/' + b.bulkReceiptKey(f.bitcoinNetwork, digest('payment') + 'i0')));
});

test('six-block bulk reservation keeps until strictly before expiry with a long freshness setting', async t => {
  const f = await fixture(t, { values: { pendingBlocks: 6, moveFreshnessTips: 12 } }), q = await f.bulk.quote(f.input());
  assert.equal(BigInt(q.terms.expires) - BigInt(q.terms.until), 1n); b.validateBulkTerms(q.terms);
});
