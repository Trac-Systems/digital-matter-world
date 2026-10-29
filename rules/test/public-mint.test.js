import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { requestInput, network, hashAt } from './observation-fixture.mjs';
import { paidInput } from './pay-first-fixture.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { accountSettings } from '../src/account-settings.js';
import { financialSplit } from '../src/financial-fees.js';
import { historicalPublicPolicyReplay } from './public-policy-replay-fixture.mjs';
const old = r.settingsRevision({ network: 'dmw-regtest', effectiveBatch: '1', effectiveBitcoinWindow: '1', values: { ...r.SETTINGS_PROFILE } });
const document = r.settingsRevision({ network: old.network, effectiveBatch: '2', effectiveBitcoinWindow: '100', previous: old,
  values: { ...old.values, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100' } });
const finder = '11'.repeat(32), other = '22'.repeat(32), find = { block: '1', count: '2', finder, findHeight: '10', finderUntil: '1018', settingsHash: r.hashObject(old) };

test('public mint is explicitly activated without changing old settings documents', () => {
  assert.equal(r.validateSettingsDocument(old), old);
  assert.equal(r.publicMintActive(old, '999999'), false);
  assert.equal(r.publicMintActive(document, '99'), false);
  assert.equal(r.publicMintActive(document, '100'), true);
  assert.equal(r.settingsSuccessor(old, document), document);
  const successor = values => r.settingsRevision({ network: old.network, effectiveBatch: '3', effectiveBitcoinWindow: '101', previous: document, values });
  assert.throws(() => r.settingsSuccessor(document, successor({ ...old.values })), /settings_public_mint_boundary/);
  assert.throws(() => r.settingsSuccessor(document, successor({ ...document.values, publicMintActivationHeight: '101' })), /settings_public_mint_boundary/);
  const incomplete = { ...document.values }; delete incomplete.publicMintScanBlocks;
  assert.throws(() => r.validateSettings(incomplete), /settings_keys/);
});
test('legacy finder ladder replays unchanged before activation and for old documents', () => {
  assert.deepEqual(r.mintRight({ find, owner: other, counted: '99', settings: document }), { allowed: false, role: 'finder', until: '1018' });
  assert.deepEqual(r.mintRight({ find, owner: other, counted: '1018', settings: old }), { allowed: true, role: 'public', until: null });
  assert.deepEqual(r.mintRight({ find, owner: other, counted: '1018', settings: old, link: { block: '1', linkHeight: '2' }, currentHolder: other }), { allowed: true, role: 'bitmap', until: null });
});
test('activation preserves the finder week and subsequent Bitmap or unit-holder ladder', () => {
  for (const settings of [old, document]) {
    assert.deepEqual(r.mintRight({ find, owner: finder, counted: '100', settings }), { allowed: true, role: 'finder', until: '1018' });
    assert.deepEqual(r.mintRight({ find, owner: other, counted: '100', settings }), { allowed: false, role: 'finder', until: '1018' });
    for (const counted of ['1018', '100000000000000000000']) {
      assert.deepEqual(r.mintRight({ find, owner: other, counted, settings }), { allowed: true, role: 'public', until: null });
      const link = { block: '1', linkHeight: '2' };
      assert.deepEqual(r.mintRight({ find, owner: other, counted, settings, link, currentHolder: other }), { allowed: true, role: 'bitmap', until: null });
      assert.deepEqual(r.mintRight({ find, owner: finder, counted, settings, link, currentHolder: other }), { allowed: false, role: 'bitmap', until: null });
      assert.deepEqual(r.mintRight({ find, owner: other, counted, settings, link: { ...link, linkHeight: '11' } }), { allowed: true, role: 'public', until: null });
    }
  }
});
test('claim deadline starts at immutable release or block, and rejects the exact boundary', () => {
  const pattern = { releaseHeight: '200' };
  assert.equal(r.claimDeadline(pattern, '1', document), '1208');
  assert.equal(r.claimDeadline(pattern, '300', document), '1308');
  assert.equal(r.claimDeadline({}, '1', document), '1108');
  assert.doesNotThrow(() => r.assertClaimOpen({ pattern, block: '1', height: '1207', settings: document }));
  assert.throws(() => r.assertClaimOpen({ pattern, block: '1', height: '1208', settings: document }), /claim_deadline/);
  assert.doesNotThrow(() => r.assertClaimOpen({ pattern, block: '1', height: '999999', settings: old }));
});
test('public eligibility excludes explicit finds, reservations, lazy header awards and mints', () => {
  const input = { pattern: {}, block: '1', height: '1108', settings: document };
  assert.equal(r.publicBlockRight(input).state, 'public');
  assert.equal(r.publicBlockRight({ ...input, height: '1107' }).state, 'claim_window_open');
  for (const key of ['find', 'reserved', 'headerAward']) assert.equal(r.publicBlockRight({ ...input, [key]: true }).state, 'claimed');
  assert.equal(r.publicBlockRight({ ...input, minted: true }).state, 'already_minted');
});
test('Bitcoin order selects one winner independent of report order and refunds late/partial payments', () => {
  const a = { id: r.hash('a'), reference: r.hash('a') + 'i0', height: '1108', transactionIndex: '2', inscriptionIndex: '0', complete: true };
  const b = { ...a, id: r.hash('b'), reference: r.hash('b') + 'i0', transactionIndex: '1' };
  const partial = { ...a, id: r.hash('p'), reference: r.hash('p') + 'i0', transactionIndex: '0', complete: false };
  for (const payments of [[a, b, partial], [partial, b, a]]) {
    const result = r.settlePublicPayments(null, payments);
    assert.deepEqual(result.winner, b); assert.equal(result.refunds.length, 2);
    assert.equal(result.refunds.find(p => p.id === a.id).reason, 'someone_paid_first');
  }
  assert.deepEqual(r.settlePublicPayments(b, [a]).winner, b);
});
test('public finder share moves to treasury with the other shares unchanged', () => {
  const options = { kind: 'find', linked: true, discovered: true }, normal = financialSplit('10000', options, document), pub = financialSplit('10000', { ...options, publicMint: true }, document);
  assert.equal(pub.finder, '0'); assert.equal(BigInt(pub.treasury), BigInt(normal.treasury) + BigInt(normal.finder));
  for (const key of ['discoverer', 'landowner', 'burn']) assert.equal(pub[key], normal[key]);
});
test('activated legacy payment path cannot overwrite another hold or issue a second permit', () => {
  const key = r.bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(2))), rq = requestInput(key), mp = paidInput(rq, { op: 'mp' });
  const id = r.pendingId(network, rq.request), plot = rq.request.asset + '/' + rq.request.block;
  const settings = { ...document.values, publicMintActivationHeight: '1' };
  const apply = (input, state) => r.applyMintInput({ input, state, network, counted: 101, tip: 106, hashAt, settings });
  assert.throws(() => apply(mp, { mints: { holds: { [plot]: { id: r.hash('other'), expiry: 200 } } } }), /block_pending/);
  const state = { mints: { holds: { [plot]: { id, expiry: 200 } } } };
  assert.equal(apply(paidInput(rq), state).op, 'mc');
  assert.throws(() => apply(paidInput(rq), state), /mint_replay|already_minted/);
});

function claimFixture(document, height) {
  const settings = r.batchSettings({ document }), state = {};
  const event = { ...r.claimRound(height, r.hash(height), height, { root: r.hash('catalog'), nextNumber: '1', revision: '0' }),
    policy: { settingsHash: r.hashObject(document), finderWindow: document.values.finderWindow, claimWindowBlocks: document.values.claimWindowTips, claimsPerWindow: document.values.claimsPerWindow } };
  const patterns = { '0': { number: '0', pat: '[0-9]', fld: 4, dt: 'n' } };
  const history = { get: height => ({ height: Number(height), hash: r.hash(height) }) };
  return { state, event, settings, patterns, history, agent: finder, plots: [{ block: '1', patterns: ['0'] }], height };
}
test('timely claims settle after the deadline with a full settlement-based finder week', () => {
  const f = claimFixture(document, '1107');
  r.enterClaims(f);
  const before = r.stableJSON(f.state);
  assert.throws(() => r.enterClaims({ ...f, height: '1108', agent: other }), /claim_deadline/);
  assert.equal(r.stableJSON(f.state), before, 'late admission changes no claim state');
  r.freezeClaimWindow({ ...f, decidingHash: r.hash('1109'), counted: '1109' });
  while (BigInt(f.event.cursor) < BigInt(f.event.pages)) r.takeSettlementPage({ ...f, height: '1500', budget: new r.CreditBudget(f.settings) });
  const found = r.recordGet(f.state.finds, r.findIdV2('1', '0'));
  assert.equal(found.findHeight, '1500'); assert.equal(found.finderUntil, '2508');
  assert.equal(r.mintRight({ find: found, owner: finder, counted: '1500' }).allowed, true);
  assert.equal(r.mintRight({ find: found, owner: other, counted: '2507' }).allowed, false);
  assert.equal(r.mintRight({ find: found, owner: other, counted: '2508' }).allowed, true);
  assert.equal(r.recordGet(f.state.balances, finder)[found.asset], String(found.count));
});
test('old documents still admit claims at heights past the new deadline', () => {
  const f = claimFixture(old, '9000');
  assert.doesNotThrow(() => r.enterClaims(f));
  assert.equal(f.event.inputPages, '1');
});

test('pre-activation discovery, claim and settlement bytes match the retained baseline', () => {
  assert.deepEqual(historicalPublicPolicyReplay(r), {
    document: '2edef4e4fcb31ab3158fcfae6a09ee5cad8e61d5728839e03092c207556d90d3',
    discovery: 'a981915518a4d9cb3e35a89e714eb0a428099576d3cebff2037b1a49c47e4668',
    closure: 'c5607c270d7d5cad30e2b5e1b2feee841c6367cca472cff9cb9012ba5aae2845',
    settlement: '392561341391850b370209e4fb73aecb4ddf62709fa69962dfbcf7526a22577a',
    state: '024728280640d00624020a60839531fab13e9d06af81cdba81fa746b1eb4aaa2',
    finder: { allowed: true, role: 'finder', until: '1123' }, holder: { allowed: true, role: 'public', until: null }
  });
});

test('open Bitmap mint settings are optional, exact, immutable and cannot retroactivate', () => {
  const make = (previous, values, window = '110') => r.settingsRevision({ network: previous.network, previous,
    effectiveBatch: r.nextUint(previous.effectiveBatch), effectiveBitcoinWindow: window, values });
  const next = make(document, { ...document.values, bitmapMintOpenHeight: '120' });
  assert.equal(r.settingsSuccessor(document, next), next);
  assert.equal(r.bitmapMintOpenActive(document, '999999'), false);
  assert.equal(r.bitmapMintOpenActive(next, '119'), false);
  assert.equal(r.bitmapMintOpenActive(next, '120'), true);
  assert.equal(accountSettings(next).bitmapMintOpenHeight, '120');
  assert.throws(() => r.settingsSuccessor(document, make(document, { ...document.values, bitmapMintOpenHeight: '109' })), /settings_bitmap_mint_open_boundary/);
  for (const height of [undefined, '121']) {
    const values = { ...next.values }; if (height === undefined) delete values.bitmapMintOpenHeight; else values.bitmapMintOpenHeight = height;
    assert.throws(() => r.settingsSuccessor(next, make(next, values)), /settings_bitmap_mint_open_boundary/);
  }
  for (const height of [120, '0120', '-1', '99']) assert.throws(() => r.validateSettings({ ...document.values, bitmapMintOpenHeight: height }));
  assert.throws(() => r.validateSettings({ ...old.values, bitmapMintOpenHeight: '120' }), /settings_bitmap_mint_open/);
  const huge = '9007199254740993123456789';
  assert.equal(r.bitmapMintOpenActive({ bitmapMintOpenHeight: huge }, (BigInt(huge) - 1n).toString()), false);
  assert.equal(r.bitmapMintOpenActive({ bitmapMintOpenHeight: huge }, huge), true);
});
