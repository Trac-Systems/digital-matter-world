import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import * as r from '../src/index.js';
import { creditActions, verifyCreditOperations } from '../src/account-batch.js';
import { accountActionDigest } from '../../contract/root-accounts.js';

const key = r.hashBytes('transfer-rule-test'), owner = r.bytesToHex(ed25519.getPublicKey(key)), to = r.hash('recipient');
const old = r.settingsRevision({ network: 'transfer-rule-test', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
const settings = r.settingsRevision({ network: old.network, previous: old, effectiveBatch: '2', effectiveBitcoinWindow: '90',
  values: { ...old.values, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100' } });
const hashAt = h => r.hash('header-' + h);
function signed({ height = '100', document = settings, actions, changes = {} } = {}) {
  if (!actions) {
    const a = { type: 'transfer', owner, to, asset: 'p2:1', amount: '2', revision: '1', nonce: r.hash('nonce'), until: '120', ...changes };
    assert.deepEqual(r.transferActionDigest(document.network, a), accountActionDigest(document.network, a));
    a.sig = r.bytesToHex(ed25519.sign(accountActionDigest(document.network, a), key)); actions = [a];
  }
  const move = { v: 2, ruleset: 'dmw-v2', settingsHash: r.hashObject(document), settingsRevision: document.revision, network: document.network,
    a: owner, t: 'transfer-v2', b: height, h: hashAt(height), p: { actions }, w: '0' };
  move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), key)); return move;
}
const execute = (state, move, document = settings, counted = move.b) => r.executeNamedMove(state, { move, settings: document, tip: move.b, counted,
  receiptPosition: '1', hashAt });

test('transfers require the complete public-mint successor and both receipt and execution activation heights', () => {
  const state = r.emptyNamedDiscovery(), root = r.namedStateRoot(state);
  assert.throws(() => execute(state, signed({ document: old, height: '999999' }), old), /move_type/);
  assert.throws(() => execute(state, signed({ height: '99' }), settings, '100'), /transfer_v2_unavailable/);
  assert.throws(() => execute(state, signed(), settings, '99'), /transfer_v2_unavailable/);
  assert.equal(execute(state, signed()).transfers[0].action.amount, '2');
  assert.equal(r.namedStateRoot(state), root);
  assert.equal(Object.hasOwn(old.values, 'publicMintActivationHeight'), false);
});

test('transfer payloads preserve literal ledger identities and reject excess, ambiguous or malformed actions', () => {
  for (const asset of ['p0', 'p2:1', 'c2:' + r.hash('compound')]) assert.equal(execute(r.emptyNamedDiscovery(), signed({ changes: { asset } })).transfers[0].action.asset, asset);
  for (const changes of [{ amount: '0' }, { amount: '01' }, { amount: '1'.repeat(79) }, { asset: 'p2:01' }, { revision: 1 }, { until: 120 }, { extra: true }]) {
    assert.throws(() => execute(r.emptyNamedDiscovery(), signed({ changes })));
  }
  const a = signed().p.actions[0];
  for (const actions of [[], [a, a], [a, { ...a, asset: 'p0' }], [a, { ...a, asset: 'p0', nonce: r.hash('two'), to: owner }], Array(17).fill(a)]) {
    assert.throws(() => r.validateNamedPayload('transfer-v2', { actions }, settings), /transfer_/);
  }
});

test('inner signature, owner, expiry and replay are independently enforced without mutating the prior catalog', () => {
  const state = r.emptyNamedDiscovery(), root = r.namedStateRoot(state), good = signed(), a = good.p.actions[0];
  for (const move of [signed({ actions: [{ ...a, amount: '3' }] }), signed({ actions: [{ ...a, owner: to }] }), signed({ changes: { until: '99' } })]) {
    assert.throws(() => execute(state, move), /transfer_authorization/);
    assert.equal(r.namedStateRoot(state), root);
  }
  const next = execute(state, good).state;
  assert.throws(() => execute(next, good), /move_already_executed/);
  assert.throws(() => execute(next, signed({ changes: { revision: '2' } })), /account_replay/);
});

test('account operation derivation allows exactly the receipt-derived transfers alongside credits and crafts', () => {
  const action = signed().p.actions[0], transfers = [{ action }], operations = [{ op: 'ar', v: 2, actions: [action] }];
  assert.deepEqual(verifyCreditOperations([], operations, [], transfers), operations);
  assert.throws(() => verifyCreditOperations([], operations), /account_credit_derivation/);
  assert.throws(() => verifyCreditOperations([], [], [], transfers), /account_credit_derivation/);
  assert.throws(() => verifyCreditOperations([], [{ ...operations[0], actions: [{ ...action, to: owner }] }], [], transfers), /account_credit_derivation/);
  const craft = { action: { type: 'craft' } }, credits = [{ op: 'ac', to: owner, assets: [['p0', '1']] }];
  const expected = [{ op: 'ar', v: 2, actions: [...creditActions(credits), craft.action, action] }];
  assert.deepEqual(verifyCreditOperations(credits, expected, [craft], transfers), expected);
});


test('old settings replay a witnessed unsupported transfer with the original rejection and unchanged root', () => {
  const state = r.emptyNamedDiscovery(), move = signed({ document: old }), gatewayKey = r.hashBytes('old-transfer-gateway');
  const receipt = r.signReceiptV2(move, { tip: '100', hash: hashAt('100'), sequence: '1', batch: '1' }, gatewayKey);
  const replay = r.replayNamedEntries(state, { entries: [{ move, receipt }], settings: old, batch: '1', gateway: receipt.gateway,
    hashAt, counted: '100', lastSequence: '0' });
  assert.deepEqual(replay.outcomes, [{ id: receipt.move, reason: 'move_type' }]);
  assert.equal(replay.root, r.namedStateRoot(state));
  assert.equal(replay.lastSequence, '1');
});


test('a transfer that expires while its receipt waits is rejected at the batch execution height', () => {
  const state = r.emptyNamedDiscovery(), move = signed(), gatewayKey = r.hashBytes('delayed-transfer-gateway');
  const receipt = r.signReceiptV2(move, { tip: '100', hash: hashAt('100'), sequence: '1', batch: '2' }, gatewayKey);
  const replay = r.replayNamedEntries(state, { entries: [{ move, receipt }], settings, batch: '2', gateway: receipt.gateway,
    hashAt, counted: '100', executionHeight: '121', lastSequence: '0' });
  assert.deepEqual(replay.outcomes, [{ id: receipt.move, reason: 'transfer_authorization' }]);
  assert.equal(replay.root, r.namedStateRoot(state));
});

test('a later transfer receipt keeps inclusion but rejects an account revision changed by its predecessor', () => {
  const state = r.emptyNamedDiscovery(), move = signed(), gatewayKey = r.hashBytes('later-transfer-gateway');
  const receipt = r.signReceiptV2(move, { tip: '100', hash: hashAt('100'), sequence: '2', batch: '3' }, gatewayKey);
  const options = { entries: [{ move, receipt }], settings, batch: '3', gateway: receipt.gateway,
    hashAt, counted: '100', lastSequence: '1' };
  const accepted = r.replayNamedEntries(state, { ...options, accountRevisions: new Map([[owner, '1']]) });
  assert.equal(accepted.outcomes[0].reason, 'accepted');
  const rejected = r.replayNamedEntries(state, { ...options, accountRevisions: new Map([[owner, '2']]) });
  assert.deepEqual(rejected.outcomes, [{ id: receipt.move, reason: 'account_revision_changed' }]);
  assert.equal(rejected.lastSequence, '2'); assert.equal(rejected.root, r.namedStateRoot(state));
  assert.ok(r.verifyReceiptV2(receipt, move, { network: settings.network, gateway: receipt.gateway, hashAt, batch: '3' }));
});
