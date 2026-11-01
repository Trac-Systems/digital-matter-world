// Explicit packing measurement; uses the real account planner and independent
// bulk evidence replay with disposable source fixtures, without chain broadcasts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, r, b } from './bulk-helpers.mjs';

test('measure 64-member lifecycle packing with the capacity successor', { timeout: 240000 }, async t => {
  const f = await fixture(t, { values: b.BULK_CAPACITY_VALUES, baseFee: '1000000000000000000' });
  f.financial.resources.bulkOrdersPerAgent = 64;
  f.financial.resources.pendingMintsPerAgent = 64;
  f.bulk.resources.bulkOrdersPerAgent = 64;
  const orders = [], stages = {};
  const drain = async stage => {
    const batches = [];
    while (f.store.count('financialQueue')) {
      // Measure a full ready page, independent of the production fairness
      // cursor left by the preceding lifecycle stage.
      await f.store.put('meta', 'financialCursor', '');
      const packed = await f.financial.build({ height: f.stamp().counted, at: f.stamp() });
      assert.ok(packed.inputs.length, JSON.stringify(packed.deferred));
      f.financial.prepared = packed.inputs.map(input => ({ id: r.hashObject(['dmw-financial-transition-v2', input.transition]), value: input.transition }));
      const accepted = await f.execute();
      assert.ok(r.encodeBinary(accepted.inputs).length < f.document.values.auditTotalBytes);
      batches.push({ orders: accepted.inputs.length, operations: accepted.operations.length,
        operationBytes: Buffer.byteLength(r.stableJSON(accepted.operations)), auditInputBytes: r.encodeBinary(accepted.inputs).length,
        deferredReasons: [...new Set(packed.deferred.map(d => d.reason))] });
    }
    stages[stage] = batches;
  };
  for (let n = 0; n < 33; n++) {
    const input = f.input(64, 'capacity-' + n); input.blocks = input.blocks.map(block => String(BigInt(block) + BigInt(n * 64)));
    const quote = await f.bulk.quote(input); assert.equal(quote.terms.members.length, 64);
    await f.bulk.request(f.sign(quote)); orders.push(quote);
  }
  await drain('reserve-many');
  for (const [i, q] of orders.entries()) await f.bulk.payment({ orderId: q.orderId, paymentId: f.payment(q, 'capacity-pay-' + i), commitTxid: null, revealTxid: null });
  await drain('bulk-fund'); await f.bulk.tick(); await drain('bulk-consume'); await f.bulk.tick();
  for (const [i, q] of orders.entries()) {
    const members = await f.reveal(q.orderId);
    // The base fixture uses one reveal identity. Give each measured order its
    // own transaction, preserving every permit and independently checked field.
    const old = members[0].inscription.slice(0, 64), txid = r.hash('capacity-reveal-' + i), tx = structuredClone(f.transactions.get(old));
    tx.txid = txid;
    for (const row of tx.inscriptions) row.id = txid + row.id.slice(64);
    for (const row of tx.mints) row.value.ins = txid + row.value.ins.slice(64);
    f.transactions.set(txid, tx);
    await f.bulk.finish({ orderId: q.orderId, members: members.map(m => ({ ...m, inscription: txid + m.inscription.slice(64) })) });
  }
  await drain('bulk-finish');
  assert.ok((await Promise.all(orders.map(q => f.bulk.status(q.orderId)))).every(s => s.state === 'minted'));
  const values = f.document.values, funding = stages['bulk-fund'][0];
  assert.equal(funding.operations, funding.orders * 2);
  const fundingOrderBytes = (funding.operationBytes - 1) / funding.orders;
  assert.ok(Number.isSafeInteger(fundingOrderBytes));
  const capacity = Object.fromEntries(Object.entries(stages).map(([stage, batches]) => [stage,
    stage === 'bulk-fund' ? Math.min(values.mintOperationBudget, Math.floor((values.batchOps - 2) / 2),
      Math.floor((values.batchBytes - values.batchEnvelopeReserveBytes - 1) / fundingOrderBytes),
      Math.floor(b.BULK_LIMITS.groupWork / orders[0].terms.groups.length)) : Math.max(...batches.map(b => b.orders))]));
  const orderCount = Math.ceil(974000 / 64), blockoutBatches = Object.values(capacity).reduce((sum, n) => sum + Math.ceil(orderCount / n), 0);
  t.diagnostic(JSON.stringify({ orderMembers: 64, orders: orders.length, settings: b.BULK_CAPACITY_VALUES,
    sameOwner: true, feeGroups: orders[0].terms.groups.length, baseFee: orders[0].terms.feeQuote.baseFee, stages,
    capacity, fundingOrderBytes, mintsPerBitcoinBlock: 128 / Object.values(capacity).reduce((sum, n) => sum + 1 / n, 0),
    blockoutBatches, blockoutDays: blockoutBatches / 288, fits14Days: blockoutBatches <= 4032,
    method: 'reservation/consumption/completion measured to their binding limit; funding extrapolated from fixed-size operations' }));
});
