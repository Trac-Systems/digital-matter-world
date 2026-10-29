import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { advanceClaimWindow, ClosureBudget } from '../src/claim-closure.js';
import { accountSettings } from '../src/account-settings.js';
import { assetSettings } from '../../contract/asset-settings.js';

import { first, previous, active, hashAt, pattern, agent, payment, fixture, replayFixture, withSignedClaim } from './claims-never-close-fixture.mjs';
import { claimsPolicyReplay } from './claims-policy-replay-fixture.mjs';
import { applyPublicScan } from '../../contract/public-mint.js';
import { freezeLegacyClaimWindow } from '../src/legacy-claims.js';

function publicScan(f, payments = [payment(1)]) {
  const operation = { op: 'fp', v: 2, type: 'public-scan', id: r.publicPlotId(f.asset, f.block), asset: f.asset, block: f.block,
    payments, claim: r.publicScanClaim(f) };
  r.applyPublicClaimScan({ ...f, operation }); return operation;
}

test('permanent claims require an immutable settings successor and preserve account settings', () => {
  assert.equal(r.settingsSuccessor(previous, active), active);
  assert.equal(r.claimsNeverCloseActive(previous, '999999999999999999999'), false);
  assert.equal(r.claimsNeverCloseActive(active, '1199'), false);
  assert.equal(r.claimsNeverCloseActive(active, '1200'), true);
  for (const values of [{ ...active.values, claimsNeverCloseHeight: 1200 }, { ...active.values, claimsNeverCloseHeight: '01200' },
    { ...first.values, claimsNeverCloseHeight: '1200' }, { ...active.values, claimsNeverCloseHeight: '99' }]) assert.throws(() => r.validateSettings(values));
  const successor = values => r.settingsRevision({ network: first.network, previous: active, effectiveBatch: '4', effectiveBitcoinWindow: '1201', values });
  assert.throws(() => r.settingsSuccessor(active, successor(previous.values)), /settings_claims_never_close_boundary/);
  assert.throws(() => r.settingsSuccessor(active, successor({ ...active.values, claimsNeverCloseHeight: '1201' })), /settings_claims_never_close_boundary/);
  const retroactive = { ...active, values: { ...active.values, claimsNeverCloseHeight: '1199' } };
  assert.throws(() => r.settingsSuccessor(previous, retroactive), /settings_claims_never_close_boundary/);
  assert.equal(assetSettings(accountSettings(active)).claimsNeverCloseHeight, '1200');
  assert.deepEqual(accountSettings(previous), Object.fromEntries(Object.entries(accountSettings(active)).filter(([k]) => k !== 'claimsNeverCloseHeight')));
});

test('old blocks stay claimable forever only after activation; 100-pair budget and finder ladder stay intact', () => {
  for (const [document, height] of [[previous, '1200'], [active, '1199']]) {
    const f = fixture(document, '12', height), before = r.stableJSON(f.state);
    assert.throws(() => r.enterClaims(f), /claim_deadline/); assert.equal(r.stableJSON(f.state), before);
  }
  for (const height of ['1200', '999999999999999999999']) assert.doesNotThrow(() => r.enterClaims(fixture(active, '12', height)));
  const f = fixture(); r.enterClaims(f);
  r.freezeClaimWindow({ ...f, counted: '1202', decidingHash: hashAt('1202') });
  while (BigInt(f.event.cursor) < BigInt(f.event.pages)) r.takeSettlementPage({ ...f, height: '1210', budget: new r.CreditBudget(f.settings) });
  const find = r.recordGet(f.state.finds, r.findIdV2('12', '7'));
  assert.equal(find.findHeight, '1210'); assert.equal(find.finderUntil, '2218'); assert.equal(find.count, 2);
  assert.equal(r.mintRight({ find, owner: agent, counted: '1210' }).allowed, true);
  assert.equal(r.mintRight({ find, owner: r.hash('other'), counted: '2217' }).allowed, false);
  assert.equal(r.mintRight({ find, owner: r.hash('other'), counted: '2218' }).allowed, true);
  const over = fixture(); over.plots = Array.from({ length: 101 }, (_, n) => ({ block: String(n), patterns: ['7'] }));
  assert.equal(r.enterClaims(over).exceeded, true);
  assert.equal(r.freezeClaimWindow({ ...over, counted: '1202', decidingHash: hashAt('1202') }).winners, '0');
});

test('active public reads open an untaken block after its first week; claimed and minted states have no deadline', () => {
  const base = fixture(active, '1200'), from = r.claimDeadline(base.pattern, base.block, active);
  // A brand-new untaken block waits one finder window before public minting; claims stay open throughout.
  const fresh = { ...base, block: '1200', height: '1200' }, freshFrom = r.claimDeadline(base.pattern, '1200', active);
  assert.deepEqual(r.publicBlockRight(fresh), { state: 'not_yet_public', publicFrom: freshFrom });
  assert.deepEqual(r.publicBlockRight({ ...fresh, height: String(BigInt(freshFrom) - 1n) }), { state: 'not_yet_public', publicFrom: freshFrom });
  assert.deepEqual(r.publicBlockRight({ ...fresh, height: freshFrom }), { state: 'public' });
  const f = { ...base, height: BigInt(from) > 1200n ? from : base.height };
  assert.deepEqual(r.publicBlockRight(f), { state: 'public' });
  for (const key of ['find', 'reserved', 'headerAward']) assert.deepEqual(r.publicBlockRight({ ...f, [key]: true }), { state: 'claimed' });
  assert.deepEqual(r.publicBlockRight({ ...f, minted: true }), { state: 'already_minted' });
  assert.deepEqual(r.publicBlockRight({ ...f, reserved: { publicMint: true } }), { state: 'already_minted' });
  assert.equal(r.publicBlockRight({ ...fresh, settings: previous }).state, 'claim_window_open');
});

for (const [name, release, publicFrom] of [
  ['block after release', { releaseHeight: '1000', releaseFinderWindow: 1008 }, '2208'],
  ['release after block', { releaseHeight: '1400', releaseFinderWindow: 1008 }, '2408'],
  ['legacy release after block', { legacy: { releaseHeight: '1400' } }, '2408'],
  ['activation fallback', {}, '2208'],
]) test(`the public week starts at the later block or pattern release: ${name}`, () => {
  const f = fixture(active, '1200'); f.pattern = { ...f.pattern, ...release };
  assert.equal(r.claimDeadline(f.pattern, f.block, active), publicFrom);
  for (const height of ['1200', String(BigInt(publicFrom) - 1n)]) {
    const fresh = { ...f, height };
    assert.deepEqual(r.publicBlockRight(fresh), { state: 'not_yet_public', publicFrom });
    assert.doesNotThrow(() => r.assertClaimOpen(fresh));
    for (const key of ['find', 'reserved', 'headerAward']) assert.deepEqual(r.publicBlockRight({ ...fresh, [key]: true }), { state: 'claimed' });
    assert.deepEqual(r.publicBlockRight({ ...fresh, minted: true }), { state: 'already_minted' });
    assert.deepEqual(r.publicBlockRight({ ...fresh, reserved: { publicMint: true } }), { state: 'already_minted' });
  }
  for (const height of [publicFrom, String(BigInt(publicFrom) + 1n)]) {
    assert.deepEqual(r.publicBlockRight({ ...f, height }), { state: 'public' });
    assert.doesNotThrow(() => r.assertClaimOpen({ ...f, height }));
  }
});

test('signed agent claims are accepted while fresh blocks are not yet public', () => {
  for (const block of ['1199', '1200']) {
    const f = fixture(active, block);
    assert.deepEqual(r.publicBlockRight(f), { state: 'not_yet_public', publicFrom: r.claimDeadline(pattern, block, active) });
    const input = withSignedClaim(replayFixture(active, { block }).input, { block });
    const output = r.processBlockV2(input);
    assert.equal(output.file.moves[0].reason, 'accepted');
    assert.equal(output.file.occurrences[0].block, block);
  }
});

test('catalog mapping is bidirectional for native and legacy assets without a duplicate ledger slot', () => {
  const legacy = { ...pattern, number: '35', legacy: { asset: 'pz' } }, catalog = { '7': pattern, '35': legacy };
  assert.equal(r.patternCatalogId('pz'), 'p2:35');
  for (const [asset, number, ledger] of [['p2:7', '7', 'p2:7'], ['pz', '35', 'pz'], ['p2:35', '35', 'pz']]) {
    const mapped = r.publicPatternForAsset(catalog, asset);
    assert.equal(mapped.pattern.number, number); assert.equal(mapped.asset, ledger);
    assert.equal(r.patternLedgerAsset(mapped.pattern), ledger);
  }
  for (const asset of ['p7', 'p0z', 'p2:035', 'p2:8', 'c2:7']) assert.throws(() => r.publicPatternForAsset(catalog, asset), /public_claim_asset/);
  assert.throws(() => r.publicScanClaim({ ...fixture(), pattern: legacy, asset: 'p2:35' }), /public_claim_asset/);
});

test('agent find, reservation or header award first makes every public payment refundable', () => {
  for (const kind of ['finds', 'claimReservations', 'headerAwards']) {
    const f = fixture(), id = r.findIdV2(f.block, pattern.number);
    f.state[kind] = r.recordSet(f.state[kind], kind === 'headerAwards' ? f.block : id,
      kind === 'headerAwards' ? { senderCount: '1', catalog: { nextNumber: '8' } } : { winner: agent });
    const op = publicScan(f, [payment(1), { ...payment(2), complete: false }]);
    assert.equal(op.claim.claimed, true);
    assert.deepEqual(r.settlePublicPayments(null, op.payments, op.claim).refunds.map(p => p.reason), ['claimed_first', 'claimed_first']);
    assert.equal(r.recordGet(f.state.claimReservations, id)?.publicMint, undefined);
  }
});

test('public winner first refuses direct claims and skips pending lottery and lazy header awards', () => {
  for (const pending of [false, true]) {
    const f = fixture(); if (pending) r.enterClaims(f);
    publicScan(f);
    assert.throws(() => r.enterClaims({ ...f, agent: r.hash('second') }), /public_minted/);
    assert.equal(r.freezeClaimWindow({ ...f, counted: '1202', decidingHash: hashAt('1202') }).winners, '0');
    if (pending) assert.equal(r.recordGet(f.state.settlementPages, '1200/0').claims[0].reason, 'public_minted');
  }
  const f = fixture(active, '1200'); publicScan(f); f.event.headerSenders = [agent];
  r.freezeClaimWindow({ ...f, counted: '1202', decidingHash: hashAt('1202') });
  const slot = { id: r.findIdV2(f.block, '7'), block: f.block, asset: f.asset, pattern: '7', count: 4 };
  assert.equal(r.implicitHeaderFind({ ...f, slot, materializedAt: '1203' }), null);
  r.queueHeaderFind({ ...f, slot, height: '1203' });
  assert.equal(f.state.rounds.length, 1);
  assert.equal(r.recordGet(f.state.claimReservations, slot.id).winner, payment(1).id);
});

test('bounded closure cannot overwrite a public winner taken between validation and reservation', () => {
  const f = fixture(); r.enterClaims(f);
  const settings = { ...f.settings, closureWorkBudget: 1 }; // one resumable unit per observation
  const step = () => advanceClaimWindow({ ...f, settings, counted: '1202', decidingHash: hashAt('1202'), budget: new ClosureBudget(settings) });
  let steps = 0; while (f.event.closing?.phase !== 'winners') { step(); assert.ok(++steps < 100); }
  publicScan(f);
  while (!f.event.closed) { step(); assert.ok(++steps < 100); }
  assert.equal(f.event.total, '0');
  assert.equal(r.recordGet(f.state.claimReservations, r.findIdV2(f.block, '7')).winner, payment(1).id);
});

test('notary point evidence protects pre-activation public plots and never treats missing reads as absence', () => {
  const f = fixture(), id = payment(1).id, rows = [{ asset: f.asset, block: f.block, id }];
  const evidence = r.publicMintEvidenceReader(rows, null, 1000); f.state.publicMintGet = evidence.get;
  assert.throws(() => r.enterClaims(f), /public_minted/); assert.deepEqual(evidence.rows(), rows);
  assert.equal(r.publicScanClaim(f).publicWinner, id);
  assert.throws(() => r.publicMintEvidenceReader([], null, 1000).get(f.asset, f.block), /public_mint_evidence_missing/);
  assert.throws(() => r.publicMintEvidenceReader([...rows, ...rows], null, 1000), /public_mint_evidence/);
  assert.throws(() => r.publicMintEvidenceReader([], () => { throw Error('unavailable'); }, 1000).get(f.asset, f.block), /public_mint_evidence_missing/);
});

test('signed claims use the execution activation even when a receipt pins the predecessor document', () => {
  for (const document of [active, previous]) {
    const input = withSignedClaim(replayFixture().input, { document });
    const output = r.processBlockV2(input);
    assert.equal(output.file.moves[0].reason, 'accepted');
    assert.equal(output.file.occurrences[0].block, '12');
  }
  const before = withSignedClaim(replayFixture(previous).input);
  assert.equal(r.processBlockV2(before).file.moves[0].reason, 'claim_deadline');
});

test('signed claims refuse pre-activation public mints and unavailable notary reads abort the batch', () => {
  const input = withSignedClaim(replayFixture().input);
  input.publicMintEvidence[0].id = payment(1).id;
  const output = r.processBlockV2(input);
  assert.equal(output.file.moves[0].reason, 'public_minted');
  assert.deepEqual(output.file.publicMintEvidence, input.publicMintEvidence);
  assert.equal(output.file.occurrences.length, 0);
  assert.throws(() => r.processBlockV2({ ...input, publicMintEvidence: [] }), /public_mint_evidence_missing/);
});

test('imported legacy rounds skip previously public-minted slots without rewriting their lottery domain', () => {
  const f = fixture(), id = r.findIdV2('12', '7'); r.enterClaims(f);
  f.event.legacy = { claimsPerWindow: 100, tipSlots: [], commitment: r.hash('legacy-input') }; f.event.headerCount = '0';
  f.state.publicMintGet = () => payment(1).id;
  assert.equal(freezeLegacyClaimWindow({ ...f, counted: '1202', decidingHash: hashAt('1202') }).winners, '0');
  assert.equal(r.recordGet(f.state.claimReservations, id), undefined);
});


test('same-observation agent closure precedes a public scan and finalization preserves earlier find deltas', () => {
  const { input, block } = replayFixture(active, { block: '1197', priorClaim: true }), output = r.processBlockV2(input);
  const view = r.publicClaimProjection(output, input), operation = { op: 'fp', v: 2, type: 'public-scan', asset: 'p2:7', block, payments: [payment(1)],
    claim: r.publicScanClaim({ ...view, pattern, asset: 'p2:7', block }) };
  assert.equal(operation.claim.claimed, true);
  const finalized = r.finalizePublicClaims(output, { ...input, financialOperations: [{ operations: [operation] }] });
  const id = r.findIdV2(block, '7');
  assert.ok(r.recordGet(finalized.state.finds, id)); assert.equal(r.recordGet(finalized.state.claimReservations, id).winner, agent);
  assert.equal(finalized.file.claimRoot, output.file.claimRoot);
  assert.throws(() => r.finalizePublicClaims(output, { ...input, financialOperations: [{ operations: [{ ...operation, claim: { ...operation.claim, claimed: false } }] }] }), /public_claim_binding/);
});

test('full batch replay and later financial attachment produce identical public claim roots and bytes', () => {
  const { input, block } = replayFixture(), output = r.processBlockV2(input), view = r.publicClaimProjection(output, input);
  const operation = { op: 'fp', v: 2, type: 'public-scan', id: r.publicPlotId('p2:7', block), asset: 'p2:7', block, payments: [payment(1)],
    claim: r.publicScanClaim({ ...view, pattern, asset: 'p2:7', block }) };
  const complete = { ...input, financialPlanning: false, accountOperations: [], financialOperations: [{ transition: { type: 'public-scan' }, evidence: {}, operations: [operation] }] };
  const attached = r.finalizeBlockV2Accounts(output, complete), replayed = r.processBlockV2(complete);
  assert.equal(r.stableJSON(attached.file), r.stableJSON(replayed.file)); assert.deepEqual(attached.auditBytes, replayed.auditBytes);
  assert.notEqual(attached.file.claimRoot, output.file.claimRoot);
  const nodes = new Map([...input.claimEvidence.nodes, ...attached.claimWrites.map(row => [row.id, row.value])]);
  const restored = new r.ClaimStorage({ get: id => nodes.get(id), cacheSize: 1 }).load(attached.state);
  assert.equal(r.recordGet(restored.claimReservations, r.findIdV2(block, '7')).winner, payment(1).id);
  assert.equal(r.publicTaken(restored, { id: r.findIdV2(block, '7'), asset: 'p2:7', block }), payment(1).id);
  const follow = withSignedClaim({ ...input, state: attached.state, financialPlanning: true,
    claimEvidence: { nodes: [...nodes] }, publicMintEvidence: [] },
  { segment: '1', previousSegment: r.receiptSegmentHash(input.receiptRoot) });
  const later = r.processBlockV2(follow);
  assert.equal(later.file.moves[0].reason, 'public_minted');
  assert.deepEqual(later.file.publicMintEvidence, [], 'the authenticated marker avoids a notary lookup in later observations');
});

test('revision-one claims, deadline refusal, closure and public settlement match the retained baseline bytes', async () => {
  assert.deepEqual(await claimsPolicyReplay(r, applyPublicScan), {
    document: '7450616099a370cc684553c28d46320a2bb17a688198c7f4822a97b347ebbc66',
    files: ['4d25632ed7872ba3eadbb14b3a524188271caff3c718a0ab8489486f57c10755', '1f089c12d3154886cebf60c4020610ce9bae1cf6d372c901d1a63484dfae8ea0',
      '6aaaca82fb44bd6c6520037c78ab5896d57f12e82b5ab163eb4843ffb49faab7', '306643d87eea562e81121cb6b268b76ab9c65f9c517b9e191d75cd4e12311308'],
    outcomes: ['accepted', 'claim_deadline'],
    roots: ['0ca9122cf9a64edd2b3a41d771a33db55e5a00946f0228042285bd002a20d0ac', 'fe1fb2e440156afc3b609869aff42ffc866e5ceab26940e3c80bf83092d93c88',
      '9e6703ab4b5cab6a71b7a0f39a0b040857b2ae8957074a7752a98e92fe14c366', '1a8e025055169d3b0199d6b23c58b90dc2ce4db8096f5003ce462fb3f48eed7f'],
    publicRecords: '64765f4af6cedb70e76f46e711a1c4289ec7fbc35f246c457a85f74aa07af0f0',
    rightBefore: { state: 'claim_window_open', claimDeadline: '1108' }, rightAfter: { state: 'public', claimDeadline: '1108' }
  });
});
