import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixture, network } from '../../committee/test/fixture.mjs';
import { attachPermit } from '../../committee/signer/adapter.mjs';
import { rules as r } from '../src/rules.mjs';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
const { secp256k1 } = createRequire(new URL('../../committee/package.json', import.meta.url))('@noble/curves/secp256k1');

function saved({ consumed = true, issued = true, terminal = false } = {}) {
  const f = fixture('dmt'), plan = f.reprice({ consumed });
  if (!consumed) { delete f.data.pending.permitHash; delete f.data.pending.paymentHash; delete f.data.pending.payments; }
  const { request, signature, receiver } = f.proposal;
  const allocations = r.paymentProgress(f.data.payment.fees, f.data.payment.receipts).allocations;
  const records = new Map([['a/' + request.owner, 1], ['an/1', request.owner], ['v/1/p0', '97'],
    ['m/' + f.id, f.data.pending], ['rq/n/1/' + request.nonce, 1]]);
  if (!consumed) records.set('e/1/p0', [[Number.MAX_SAFE_INTEGER, '3']]);
  if (consumed) for (const item of allocations) records.set('pay/' + item.key, { total: item.total, used: item.amount });
  const signed = secp256k1.sign(plan.digest, new Uint8Array(32).fill(2), { prehash: false, lowS: true });
  const row = { request, signature, receiver, deployment: { ...f.data.context.deployment, asset: request.asset },
    payment: { rail: 'tap', payer: f.data.payer, ids: ['test-payment'], allocations },
    ...(consumed && issued ? { permit: attachPermit(plan, { r: String(signed.r), s: String(signed.s), v: signed.recovery }) } : {}),
    ...(terminal ? { terminal: { id: f.id, deployment: f.data.context.deployment.id, permitHash: plan.digest, state: 'minted', evidence: r.hash('independently reconciled receipt') } } : {}) };
  return { f, row, records, snapshot: { version: 2, height: 100, requests: new Map([[f.id, row]]), links: new Map(), custody: new Map() } };
}

test('pending-work activation refuses unresolved notary financial obligations even if the gateway omitted them', () => {
  const commitment = { network, anchor: { height: '100' } };
  const pendingWork = { commitment, root: r.hashObject(['dmw-pending-work-v1', commitment]) };
  for (const state of [{ consumed: false, issued: false }, { consumed: true, issued: false }, { consumed: true, issued: true }]) {
    const f = saved(state);
    assert.throws(() => prepareTerminalImport({ network, records: f.records, height: 100, financialSnapshot: f.snapshot, pendingWork }), /pending_financial_adapter_required/);
  }
  const completed = saved({ terminal: true });
  assert(prepareTerminalImport({ network, records: completed.records, height: 100, financialSnapshot: completed.snapshot, pendingWork }).pendingWork);
});

for (const state of [{ consumed: false, issued: false }, { consumed: true, issued: false }, { consumed: true, issued: true }, { consumed: true, issued: true, terminal: true }]) {
  test(`financial terminal import retains request, permit and capacity identities: ${JSON.stringify(state)}`, () => {
    const { f, row, records, snapshot } = saved(state), before = r.hashObject([...records]);
    const result = prepareTerminalImport({ network, records, height: 100, financialSnapshot: snapshot, pageBytes: 9000 });
    const imported = new Map(result.pages.flatMap(p => p.records)), identity = imported.get('fi/request/' + f.id);
    assert.deepEqual(identity.request, row.request); assert.equal(identity.signature, row.signature);
    assert.deepEqual(identity.payment, row.payment); assert.deepEqual(identity.permit, row.permit ?? null);
    assert.equal(identity.authorization?.digest ?? null, state.consumed ? f.data.pending.permitHash : null);
    assert.equal(imported.get('fi/deployment/' + row.deployment.id) ?? '0', state.terminal ? '0' : '3');
    assert.equal(imported.get('fi/plot/p0/10').state, state.terminal ? 'minted' : 'reserved');
    for (const [key, value] of records) assert.deepEqual(imported.get(key), value);
    assert.equal(r.hashObject([...records]), before);
    const balance = result.publicWrites.find(w => w.space === 'publicBalances').value;
    assert.equal(balance.amount, '97'); assert.equal(balance.held, state.consumed ? '0' : '3');
    assert.equal(balance.root, imported.get('ar/' + row.request.owner).root);
    const supply = result.publicWrites.find(w => w.space === 'publicSummaries').value;
    assert.equal(supply.matter, state.consumed ? '97' : '100');
    const publicMint = result.publicWrites.find(w => w.space === 'publicResults/mints').value;
    assert.equal(publicMint.id, f.id); assert.equal(publicMint.amount, row.request.amount);
    assert.equal(publicMint.state, state.terminal ? 'minted' : state.consumed ? 'permit_issued' : 'awaiting_payment');
    assert.equal(result.publicWrites.filter(w => w.space === 'publicResults/payments').length,
      state.consumed ? row.payment.allocations.length : 0);
    assert.equal(result.publicWrites.find(w => w.space === 'publicSummaries' && w.id === 'burn').value.legacyAllocations,
      String(state.consumed ? row.payment.allocations.length : 0));
    assert.doesNotMatch(JSON.stringify(publicMint), /"(?:sig|signature|authorization|permit)":/);
    assert.equal(result.financialIdentities.find(w => w.space === 'financialRequests').value.authorization?.digest ?? null,
      state.consumed ? f.data.pending.permitHash : null);
  });
}

test('unconsumed legacy payment candidates stay pending without publishing paid receipts', () => {
  for (const retainedUsage of [false, true]) {
    const { f, row, records, snapshot } = saved({ consumed: false, issued: false });
    if (!retainedUsage) for (const item of row.payment.allocations) records.delete('pay/' + item.key);
    const imported = prepareTerminalImport({ network, records, height: 100, financialSnapshot: snapshot });
    assert.deepEqual(imported.financialIdentities.find(w => w.space === 'financialRequests').value.payment, row.payment);
    assert.equal(imported.publicWrites.find(w => w.space === 'publicResults/mints' && w.id === f.id).value.state, 'awaiting_payment');
    assert.equal(imported.publicWrites.filter(w => w.space === 'publicResults/payments').length, 0);
  }
});

test('financial import refuses omissions, altered receipts, signatures and deployment replacements', () => {
  const f = saved();
  const prepare = snapshot => prepareTerminalImport({ network, records: f.records, height: 100, financialSnapshot: snapshot });
  assert.throws(() => prepare(), /financial_snapshot_required/);
  const missing = structuredClone(f.snapshot); missing.requests.clear(); assert.throws(() => prepare(missing), /financial_request_coverage/);
  for (const change of [
    row => { row.deployment.id = r.hash('different deployment') + 'i0'; },
    row => { row.payment.allocations[0].amount = '1'; },
    row => { row.signature = '00'.repeat(64); },
    row => { row.permit.prv.sig.r = '1'; },
    row => { row.request.nonce = r.hash('different nonce'); },
  ]) {
    const changed = structuredClone(f.snapshot); change(changed.requests.get(f.f.id));
    assert.throws(() => prepare(changed), /financial_|signature/);
  }
  const noUsage = new Map(f.records); noUsage.delete('pay/' + f.row.payment.allocations[0].key);
  assert.throws(() => prepareTerminalImport({ network, records: noUsage, height: 100, financialSnapshot: f.snapshot }), /financial_payment_usage/);
  assert.throws(() => prepare({ ...f.snapshot, height: 101 }), /financial_snapshot_height/);
});

test('external identities participate in the terminal root even when all account balances match', () => {
  const f = saved({ consumed: false, issued: false });
  const a = prepareTerminalImport({ network, records: f.records, height: 100, financialSnapshot: f.snapshot });
  const changed = structuredClone(f.snapshot); changed.requests.get(f.f.id).payment.ids.push('another known payment');
  const b = prepareTerminalImport({ network, records: f.records, height: 100, financialSnapshot: changed });
  assert.notEqual(a.financialRoot, b.financialRoot); assert.notEqual(a.importRoot, b.importRoot);
  assert.deepEqual(a.accountRecords, b.accountRecords);
});
