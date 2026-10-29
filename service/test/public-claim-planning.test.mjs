import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { readPublicWinner, publicClaimReaders } from '../src/public-claim-readers.mjs';
import { buildFinancialExecution } from '../src/financial-execution.mjs';
import { AccountBatchOverlay } from '../src/account-batch.mjs';
import { patternCatalogId } from '../src/mint-assets.mjs';
import { publicRefundKey } from '../../contract/public-mint.js';

test('public winner reads require funding evidence and honor staged records', async () => {
  const id = r.hash('public winner'), records = new Map(), calls = [];
  const store = new AccountBatchOverlay({ get: () => null });
  const context = { store, at: { counted: '110', last: { n: '1', to: '110' } },
    reads: { financialRecord: async (key, at) => { assert.equal(at, context.at); calls.push(key); return records.get(key); } } };
  assert.equal(await readPublicWinner(context, 'p0', '12'), null);
  records.set('dc/plot/p0/12', id);
  await assert.rejects(readPublicWinner(context, 'p0', '12'), /public_mint_evidence_missing/);
  for (const funding of [{ publicMint: false, owner: null }, { publicMint: true, owner: r.hash('agent') }, { publicMint: true }]) {
    records.set('fp/' + id, funding); assert.equal(await readPublicWinner(context, 'p0', '12'), null);
  }
  records.set('fp/' + id, { publicMint: true, owner: null });
  assert.equal(await readPublicWinner(context, 'p0', '12'), id);
  store.apply([{ space: 'accountRecords', id: 'dc/plot/p0/13', value: id },
    { space: 'accountRecords', id: 'fp/' + id, value: { publicMint: true, owner: null } }]);
  const before = calls.length; assert.equal(await readPublicWinner(context, 'p0', '13'), id); assert.equal(calls.length, before);
  await assert.rejects(readPublicWinner({ ...context, reads: {} }, 'p0', '12'), /public_mint_evidence_missing/);
  await assert.rejects(readPublicWinner({ ...context, reads: { financialRecord() { throw Error('source_unavailable'); } } }, 'p0', '12'), /source_unavailable/);
});

function fixture({ legacy = false, claimed = false } = {}) {
  const asset = legacy ? 'p7' : 'p2:7', block = '12', deployment = r.hash('deployment') + 'i0', generation = r.hash('generation');
  const pattern = { number: '7', ...(legacy ? { legacy: { asset } } : {}) };
  const document = r.settingsRevision({ network: 'test', effectiveBatch: '1', effectiveBitcoinWindow: '100',
    values: { ...r.SETTINGS_PROFILE, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100', claimsNeverCloseHeight: '110' } });
  const records = new Map([['fd/asset/' + asset, generation], ['fd/' + generation, { asset, deployment, minted: '0', reserved: '0', maximum: '20' }]]);
  const store = { get: (space, id) => space === 'accountRecords' ? records.get(id) ?? null : null };
  const input = { settings: { document }, claimEvidence: { nodes: [] }, namedEvidence: { nodes: [] }, publicMintEvidence: [] };
  const readers = publicClaimReaders({ input, store, claimNodes: new Map(), publicMintRead: async () => null });
  const state = { finds: claimed ? { [r.findIdV2(block, '7')]: { finder: r.hash('agent') } } : {}, claimReservations: {}, headerAwards: {}, publicMintGet: readers.readers.publicMintGet };
  const publicClaims = { state, patterns: new Map([['7', pattern]]), settings: document, height: '110' };
  const payment = (n, height = '100') => {
    const id = r.hash('request/' + n), tapAddress = 'wallet', amount = '2';
    return { id, asset, block, tapAddress, reference: r.hash('payment/' + n) + 'i0', height, transactionIndex: '0', inscriptionIndex: '0', complete: true,
      fees: [{ amount: '10' }], paymentHash: r.hash('paid/' + n), permitHash: r.hash('permit/' + n),
      source: { publicMint: true, requestId: id, asset, amount, request: { asset, block, amount }, payer: tapAddress, receiver: tapAddress,
        deployment: { id: deployment }, generation, fees: [{ key: r.hash('fee'), amount: '10' }],
        capacity: { deployment, asset, block, amount, remaining: '20', limit: '0' } } };
  };
  const scan = (payments, previous = null) => {
    const id = r.publicPlotId(asset, block), from = previous?.next ?? { height: '100', transactionIndex: '0', inscriptionIndex: '0' };
    const evidence = { requestId: id, asset, block, previous: r.hashObject(previous), start: from.height, from,
      next: { height: r.addUint(from.height, '1'), transactionIndex: '0', inscriptionIndex: '0' }, blockHash: r.hash('block/' + from.height), payments };
    const transition = { type: 'public-scan', id, asset, block, previous: evidence.previous };
    const accepted = { asset, block, next: evidence.next, blockHash: evidence.blockHash, scannedHeight: from.height,
      winner: claimed ? null : previous?.winner ?? payments[0] };
    return { transition, evidence, accepted };
  };
  const build = (scans, extra = {}) => buildFinancialExecution({ store, document, height: '110', transitions: scans.map(s => s.transition), publicClaims,
    preparePublicMint: readers.prepare, reads: { financialRecord: async id => records.get(id),
      financialEvidence: async transition => structuredClone(scans.find(s => r.hashObject(s.transition) === r.hashObject(transition)).evidence) }, ...extra });
  return { asset, block, pattern, document, publicClaims, payment, scan, build };
}

for (const legacy of [false, true]) test(`sequential public scans share one catalog slot and accepted refund outcome; legacy=${legacy}`, async () => {
  const f = fixture({ legacy }), a = f.payment(1), b = f.payment(2, '101');
  const first = f.scan([a]), second = f.scan([b], first.accepted), result = await f.build([first, second]);
  const [one, two] = result.inputs;
  assert.deepEqual(one.evidence.claim, { pattern: '7', claimed: false, publicWinner: null });
  assert.deepEqual(two.evidence.claim, { pattern: '7', claimed: false, publicWinner: a.id });
  assert.deepEqual(one.operations[0].claim, one.evidence.claim);
  assert.equal(r.recordGet(f.publicClaims.state.claimReservations, r.findIdV2(f.block, '7')).winner, a.id);
  assert.equal(result.writes.find(w => w.id === publicRefundKey(b)).value.reason, 'someone_paid_first');
  for (const alias of new Set([f.asset, 'p2:7'])) {
    assert.equal(patternCatalogId(alias), 'p2:7');
    assert.equal(r.publicPatternForAsset(f.publicClaims.patterns, alias).asset, f.asset);
  }
  if (!legacy) assert.throws(() => r.publicPatternForAsset(f.publicClaims.patterns, 'p7'), /public_claim_asset/);
});

test('claimed scans refund complete payments and never add public reservations', async () => {
  const f = fixture({ claimed: true }), payment = f.payment(1), result = await f.build([f.scan([payment])]);
  assert.equal(result.inputs[0].evidence.claim.claimed, true);
  assert.equal(result.writes.find(w => w.id === publicRefundKey(payment)).value.reason, 'claimed_first');
  assert.equal(result.writes.some(w => w.id.startsWith('dc/')), false);
  assert.equal(r.recordGet(f.publicClaims.state.claimReservations, r.findIdV2(f.block, '7')), undefined);
});

test('deferred contract failures do not leak a public take into the next planning attempt', async () => {
  const f = fixture(), payment = f.payment(1); payment.source.capacity.remaining = '1';
  const bad = await f.build([f.scan([payment])], { defer: true });
  assert.equal(bad.inputs.length, 0); assert.equal(bad.deferred[0].reason, 'financial_capacity_reserved');
  assert.equal(r.recordGet(f.publicClaims.state.claimReservations, r.findIdV2(f.block, '7')), undefined);
  assert.equal(bad.writes.length, 0);
  const valid = await f.build([f.scan([f.payment(2)])]);
  assert.equal(valid.inputs[0].evidence.claim.publicWinner, null);
});
