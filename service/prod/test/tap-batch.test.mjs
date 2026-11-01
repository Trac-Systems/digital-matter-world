import test from 'node:test';
import assert from 'node:assert/strict';
import { TapReader } from '../tap.mjs';
import { TapLookupIndex, installTapLookups } from '../tap-index.mjs';
import { bulkFixture } from '../../test/helpers/bulk-sender.mjs';
import { buildBulkInscriptionPlan, signBulkCommit } from '../../../kit/lib/inscription-batch-core.mjs';
import { btc } from '../../src/mint-sender-keys.mjs';
import { unhex } from '../../../kit/lib/inscription-core.mjs';

async function fixture(t, n = 16) {
  const f = await bulkFixture(n), plan = await signBulkCommit(await buildBulkInscriptionPlan({ ...f, publicKey: f.key.publicKey, feeRate: 1 }), f.key.privateKey);
  f.key.privateKey.fill(0);
  const calls = [], transactions = new Map(plan.reveals.map(r => [r.txid, r])), rows = new Map(); let hash = '77'.repeat(32), height = '974140';
  for (const reveal of plan.reveals) rows.set('Minted/' + reveal.txid, reveal.members.map(m => ({ ins: m.inscription, fail: false, addr: f.terms.receiver, tick: 'dmt-' + f.terms.ticker, amt: f.terms.members[m.index].amount, dta: f.manifest.members[m.index].mintContent.dta })));
  const source = { request: async path => {
    calls.push(path);
    if (path === '/r/tap/getCurrentBlock') return { result: height };
    if (path.startsWith('/r/blockhash/')) return hash;
    const match = /^\/r\/tap\/get(Minted|Transferred)List(Length)?\/([0-9a-f]{64})(?:\?offset=(\d+)&max=(\d+))?$/.exec(path);
    if (match) {
      const values = rows.get(match[1] + '/' + match[3]) ?? [];
      return { result: match[2] ? values === null ? null : values.length : values?.slice(Number(match[4]), Number(match[4]) + Number(match[5])) };
    }
    if (path.includes('getDmtMintHolderByBlock/')) {
      const block = path.split('/').at(-1), member = f.terms.members.findIndex(m => m.block === block);
      return { result: plan.reveals.flatMap(r => r.members).find(m => m.index === member) ? { ins: plan.reveals.flatMap(r => r.members).find(m => m.index === member).inscription } : null };
    }
    throw Error('unexpected: ' + path);
  } };
  const indexer = new TapReader({ sources: [source], agreement: 1, bitcoin: { blockHash: async () => hash } });
  const index = new TapLookupIndex({ indexer }); t.after(() => index.close());
  let inclusionCalls = 0, rawCalls = 0;
  const reads = installTapLookups({
    included: async (id, at) => {
      inclusionCalls++; assert.equal(at.tipHash, hash);
      const r = transactions.get(id.slice(0, 64));
      return r ? { height, blockHash: hash, confirmations: 1, tx: { txid: r.txid, hex: r.hex } } : null;
    },
    bitcoinTransaction: async txid => { rawCalls++; const r = transactions.get(txid); return r && { txid, hex: r.hex }; },
  }, index);
  return { f, plan, calls, rows, reads, transactions, index, indexer, get inclusionCalls() { return inclusionCalls; }, get rawCalls() { return rawCalls; },
    reorg: () => { hash = '88'.repeat(32); }, get at() { return { tip: height, tipHash: hash }; } };
}

test('bulk known 64 reveals use four transaction reads and one outer before/after stamp pair', async t => {
  const f = await fixture(t, 64), ids = f.plan.reveals.map(r => r.txid);
  const evidence = await f.reads.withBulkSnapshot(f.at, view => f.reads.bulkTransactions(ids, { kinds: ['mints'], view }));
  assert.equal(evidence.length, 4); assert.equal(f.inclusionCalls, 4); assert.equal(f.rawCalls, 0);
  assert.equal(f.calls.filter(p => p.endsWith('getCurrentBlock')).length, 2);
  assert.equal(f.calls.filter(p => p.includes('ListLength/')).length, 4);
  assert.equal(f.calls.filter(p => p.includes('?offset=')).length, 4); assert.ok(f.calls.every(p => !p.includes('max=1')));
  assert.ok(evidence.every(e => e.inscriptions.length === 16 && e.mints.length === 16 && e.complete.mints && !e.complete.transfers));
  await f.reads.withBulkSnapshot(f.at, async view => {
    const [a, b] = await Promise.all([f.reads.bulkTransactions(ids, { kinds: ['mints'], view }), f.reads.bulkTransactions(ids, { kinds: ['mints'], view })]);
    a[0].mints.length = 0; assert.equal(b[0].mints.length, 16);
  });
  assert.equal(f.inclusionCalls, 4); assert.equal(f.calls.filter(p => p.includes('?offset=')).length, 4);
});

test('bulk transaction evidence normalizes decimal-reader confirmations to the numeric wire field', async t => {
  const f = await fixture(t, 1), included = f.reads.included;
  f.reads.included = async (...args) => ({ ...await included(...args), confirmations: '1' });
  const [tx] = await f.reads.bulkTransactions([f.plan.reveals[0].txid]);
  assert.equal(tx.inclusion.confirmations, 1);
  assert.equal(tx.inclusion.height, f.at.tip);
  f.reorg(); f.reads.included = async (...args) => ({ ...await included(...args), confirmations: '9007199254740992' });
  await assert.rejects(f.reads.bulkTransactions([f.plan.reveals[0].txid]), /bulk_source_count/);
});

test('bulk 1101 transfers read one length and three 500-row pages; kinds join one raw decode', async t => {
  const f = await fixture(t, 1), id = f.plan.reveals[0].txid;
  f.rows.set('Transferred/' + id, Array.from({ length: 1101 }, (_, i) => ({ ins: id + 'i0', fail: i === 10, int: true, addr: f.f.terms.payer, taddr: f.f.terms.receiver, tick: 'tap', amt: '1', dta: String(i) })));
  const results = await f.reads.withBulkSnapshot(f.at, view => Promise.all([
    f.reads.bulkTransactions([id], { kinds: ['transfers'], view }), f.reads.bulkTransactions([id], { kinds: ['mints'], view }),
  ]));
  assert.equal(f.inclusionCalls, 1); assert.equal(results[0][0].transfers.length, 1101); assert.equal(results[0][0].transfers[10].value.fail, true);
  assert.equal(f.calls.filter(p => p.includes('TransferredListLength')).length, 1); assert.equal(f.calls.filter(p => p.includes('TransferredList/') && p.includes('?')).length, 3);
  assert.equal(f.calls.filter(p => p.endsWith('getCurrentBlock')).length, 2);
});

test('bulk missing source rows stay incomplete and recover; hard page caps reject', async t => {
  const f = await fixture(t, 1), id = f.plan.reveals[0].txid;
  const sourceTap = f.indexer.tap.bind(f.indexer); let missing = true;
  f.indexer.tap = async path => missing && path.startsWith('getTransferredListLength/') ? null : sourceTap(path);
  let [e] = await f.reads.bulkTransactions([id], { kinds: ['transfers'] }); assert.equal(e.complete.transfers, false);
  missing = false; [e] = await f.reads.bulkTransactions([id], { kinds: ['transfers'] }); assert.equal(e.complete.transfers, true);
  f.reorg(); f.rows.set('Transferred/' + id, Array(2001).fill({ ins: id + 'i0' }));
  await assert.rejects(f.reads.bulkTransactions([id], { kinds: ['transfers'] }), /bulk_source_page_limit/);
  await assert.rejects(f.reads.bulkTransactions([id, id]), /bulk_transaction_ids/);
  await assert.rejects(f.reads.bulkTransactions([id], { kinds: ['mints'], view: { stamp: f.at } }), /bulk_snapshot_required/);
});

test('bulk reorg invalidates cached evidence and a changing outer fence returns no evidence', async t => {
  const f = await fixture(t, 1), id = f.plan.reveals[0].txid;
  await f.reads.bulkTransactions([id], { kinds: ['mints'] }); f.reorg();
  await f.reads.bulkTransactions([id], { kinds: ['mints'] }); assert.equal(f.inclusionCalls, 2);
  let escaped;
  const original = f.indexer.stamp.bind(f.indexer); let stamps = 0;
  f.indexer.stamp = async () => { const value = await original(); if (++stamps === 2) value.hash = '99'.repeat(32); return value; };
  await assert.rejects(f.reads.withBulkSnapshot(f.at, async view => { escaped = view; return f.reads.bulkTransactions([id], { kinds: ['mints'], view }); }), /tap_snapshot_changed/);
  await assert.rejects(f.reads.bulkTransactions([id], { kinds: ['mints'], view: escaped }), /bulk_snapshot_required/);
});

test('bulk detached DMT recovery checks successful exact transaction rows and payload hashes', async t => {
  const f = await fixture(t, 16), expected = f.f.manifest.members.map(m => ({ index: m.index, block: m.block, amount: m.amount, dta: m.mintContent.dta, permitHash: m.permitHash }));
  const found = await f.reads.withBulkSnapshot(f.at, view => f.reads.bulkMintMatches({ receiver: f.f.terms.receiver, ticker: 'dmt-example', expected, view }));
  assert.equal(found.length, 16); assert.equal(f.inclusionCalls, 1); assert.ok(f.calls.every(p => !p.includes('max=1')));
  f.reorg(); f.rows.get('Minted/' + f.plan.reveals[0].txid)[0].fail = true;
  const next = await f.reads.bulkMintMatches({ receiver: f.f.terms.receiver, ticker: 'dmt-example', expected }); assert.equal(next.length, 15);
});

function transactionVariant(f, lockTime) {
  const original = btc.Transaction.fromRaw(unhex(f.plan.reveals[0].hex), { allowUnknownInputs: true });
  const tx = new btc.Transaction({ lockTime, allowUnknownInputs: true });
  for (let i = 0; i < original.outputsLength; i++) tx.addOutput(original.getOutput(i));
  for (let i = 0; i < original.inputsLength; i++) tx.addInput(original.getInput(i), true);
  // Signatures are immaterial to these cache-unit fixtures: the injected
  // Bitcoin inclusion reader is the trust boundary tested separately in ord.
  f.transactions.set(tx.id, { txid: tx.id, hex: tx.hex }); return tx.id;
}

test('bulk source cache obeys both 128 transaction and 16 MiB ceilings with four concurrent reads', async t => {
  const f = await fixture(t, 1), ids = Array.from({ length: 129 }, (_, i) => transactionVariant(f, i + 1));
  let active = 0, maximum = 0; const included = f.reads.included;
  f.reads.included = async (...args) => { active++; maximum = Math.max(active, maximum); try { await new Promise(r => setTimeout(r, 1)); return await included(...args); } finally { active--; } };
  for (let i = 0; i < ids.length; i += 64) await f.reads.bulkTransactions(ids.slice(i, i + 64), { kinds: ['mints'] });
  assert.equal(maximum, 4); assert.equal(f.inclusionCalls, 129);
  await f.reads.bulkTransactions([ids[0]], { kinds: ['mints'] }); assert.equal(f.inclusionCalls, 130, 'oldest transaction was evicted');
  f.reorg();
  const large = ids.slice(0, 10);
  for (const id of large) f.rows.set('Transferred/' + id, Array.from({ length: 2000 }, () => ({ ins: id + 'i0', fail: false, int: true, addr: 'payer', taddr: 'recipient', tick: 'tap', amt: '1', dta: 'x'.repeat(1000) })));
  await f.reads.bulkTransactions(large, { kinds: ['transfers'] }); const before = f.inclusionCalls;
  await f.reads.bulkTransactions([large[0]], { kinds: ['transfers'] }); assert.equal(f.inclusionCalls, before + 1, 'byte ceiling evicts before 128 entries');
});

test('bulk raw transaction and source page byte bounds reject oversized evidence before decoding', async t => {
  const f = await fixture(t, 1), id = f.plan.reveals[0].txid, included = f.reads.included;
  f.reads.included = async (...args) => { const value = await included(...args); return { ...value, tx: { ...value.tx, hex: '00'.repeat(400001) } }; };
  await assert.rejects(f.reads.bulkTransactions([id]), /bulk_transaction_bytes/);
  f.reads.included = included;
  f.rows.set('Transferred/' + id, Array.from({ length: 500 }, () => ({ ins: id + 'i0', dta: 'x'.repeat(5000) })));
  await assert.rejects(f.reads.bulkTransactions([id], { kinds: ['transfers'] }), /bulk_source_page/);
});
