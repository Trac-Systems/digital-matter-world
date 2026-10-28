import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import { join } from 'node:path';
import { rules as r, initialState } from '../src/rules.mjs';
import { NamedAdmission } from '../src/named-admission.mjs';
import { NamedStorage } from '../src/named-storage.mjs';
import { SegmentedIntake } from '../src/segmented-intake.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Files } from '../src/files.mjs';
import { Store } from '../src/store.mjs';
import { AccountAvailability } from '../src/account-availability.mjs';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { harness, deployment, committeeSecret } from '../../contract/tests/helpers/harness.mjs';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import { batchDigest } from '../../contract/signing.js';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
import { Outbox } from '../src/transport.mjs';
import { rebuildBatch } from '../../committee/signer/adapter.mjs';
import { temp, network, secret, fixtureHistory, attestRoot, receiptSigners } from './helpers.mjs';

test('named discovery is accepted by witnessed segments, independent batch replay and durable publication', async () => {
  const path = await temp(), history = fixtureHistory(30), files = new Files(join(path, 'static'));
  const legacy = harness({ ...deployment, network }); await legacy.advance(9); assert.equal(await legacy.batch([]), null); await legacy.advance(1);
  const imported = prepareTerminalImport({ records: legacy.db, height: 10 });
  const document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '10', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
  const settingsHistory = new r.SettingsHistory(); settingsHistory.append(document, r.hashObject(document));
  const empty = r.emptyNamedDiscovery(), previousRoot = legacy.db.get('bt/1');
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2', previousBatchRoot: previousRoot,
    bitcoinAnchor: { height: '10', hash: history.hashAt(10) }, settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(empty), accountsRoot: imported.financialRoot,
    receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const settings = r.activatedBatchSettings({ manifest, manifestHash: r.hashObject(manifest), document, receiptSigners });
  const resources = r.resourceRevision({ operator: 'integration fixture', values: { ...r.RESOURCE_PROFILE } });
  const contract = harness({ ...deployment, network, v2: { manifest, manifestHash: r.hashObject(manifest), document, importRoot: imported.importRoot, importRows: imported.importRows } });
  for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
  let store = await Store.open(path), last = await contract.state().batchLast(), tip = 10, pipeline, intake, signed = 0;
  const roots = new Map(), wallet = r.hashBytes('disposable integration player'), agent = r.bytesToHex(ed25519.getPublicKey(wallet));
  await store.put('meta', 'ruleState', { ...initialState(10, history.hashAt(10), 9), catalogRoot: manifest.catalogRoot, accountRoot: manifest.accountsRoot, batchVersion: 2 });
  const claimSnapshot = r.initialClaimSnapshot(manifest, 9);
  await store.put('meta', 'ruleState', { ...store.get('meta', 'ruleState'), ...claimSnapshot.hot, claimSnapshot, claimRoot: r.claimStateRoot(claimSnapshot) });
  await store.transact([...imported.availability, ...imported.accountRecords]);
  const context = () => {
    const state = store.get('meta', 'ruleState'), storage = new NamedStorage({ get: id => store.get('namedNodes', id), cacheSize: 64 });
    return { ready: true, segmented: true, ruleset: 'dmw-v2', settings: document, settingsHistory, batch: r.nextUint(last.n), tip: String(tip), counted: String(tip),
      observation: intake.head.id, sealed: store.count('observations') > 0, state: state.namedSnapshot ? storage.load(state.namedSnapshot) : empty,
      acceptedRoot: state.catalogRoot };
  };
  const create = () => {
    intake = new SegmentedIntake({ store, network, secret, hashAt: history.hashAt, settings, rulesContext: context });
    intake.namedAdmission = new NamedAdmission({ store, secret, context, history: { get: h => history.get(Number(h)) }, hashAt: h => history.hashAt(Number(h)), resources });
    const reads = { batchLast: async () => last, committeeEpoch: async () => 0, counted: async () => tip, batchRoot: async n => contract.db.get('bt/' + n) ?? null };
    const committee = { attestRoot, signature: async (_, proposal) => {
      const draft = await pipeline.loadDraft();
      const rebuilt = rebuildBatch(network, proposal, { authority: { epoch: 0 }, counted: tip, gateway: intake.gateway, state: draft.startState, patterns: draft.startPatterns,
        inputs: draft.items.map(i => i.input), history, hashAt: history.hashAt, settings: draft.settings, limits: draft.limits, last, activation: settings.activation, previousRoot: draft.previousRoot });
      assert.equal(rebuilt.batch.root, proposal.batch.root); signed++;
      return { signature: { compact: secp256k1.sign(batchDigest(network, rebuilt.batch), committeeSecret, { lowS: true, prehash: false }).toCompactHex() } };
    } };
    const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => { assert.equal(await contract.run(m.op, m.value), null, 'contract acceptance'); last = await contract.state().batchLast(); roots.set(last.n, m.value.root); },
      status: async job => ({ state: roots.get(job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
    pipeline = new Pipeline({ store, files, history, intake, reads, committee, outbox: new Outbox({ store, transport, fallbackMs: 100000, retryMs: 0 }), settings });
  };
  const packet = (t, p) => {
    const move = { v: 2, ruleset: 'dmw-v2', settingsRevision: document.revision, settingsHash: r.hashObject(document), network, a: agent, t, b: String(tip), h: history.hashAt(tip), p, w: '0', sig: '00'.repeat(64) };
    move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), wallet)); return r.stableJSON(move);
  };
  create();
  try {
    await intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip });
    const proposal = { name: 'dmwintegration', pat: '[0-9]', fld: 4, dt: 'n' }, salt = r.hash('disposable salt'), anchor = { height: '10', hash: history.hashAt(10) };
    const matches = [1, 2, 3].map(h => ({ height: String(h), hash: history.hashAt(h), count: '1' }));
    const commitment = r.namedCommitment({ proposal, salt, agent, anchor, matches, settings: document });
    const commitText = packet('discovery-commit-v2', { commitment });
    const receipt = await intake.accept(commitText); assert.equal(receipt.batch, '2');
    await pipeline.tick().catch(e => { throw Error('commit: ' + e.message); }); await pipeline.tick(); assert.equal(last.n, '2');
    assert.deepEqual(await intake.accept(commitText), receipt);
    await pipeline.close(); await store.close(); store = await Store.open(path); create();
    for (tip = 11; tip <= 12; tip++) { await contract.advance(1); await intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip }); await pipeline.tick().catch(e => { throw Error(`advance ${tip}: ${e.message}`); }); await pipeline.tick(); }
    tip = 12;
    const text = packet('discovery-reveal-v2', { proposal, salt, commitmentId: commitment, anchor, matches, witnessRoot: r.witnessRoot(matches) });
    await intake.accept(text); await pipeline.tick().catch(e => { throw Error('reveal: ' + e.message); }); await pipeline.tick();
    const record = store.get('patternsByAsset', 'p2:0'); assert.equal(record.knownMatchCount, '3');
    assert.equal(record.discoverer, agent); assert.equal(store.get('meta', 'namedReservedBatch'), null);
    await intake.accept(packet('claim-v2', { window: '12', plots: [{ block: '5', patterns: ['0'] }] }));
    await pipeline.tick(); await pipeline.tick();
    for (tip = 13; tip <= 14; tip++) { await contract.advance(1); await intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip }); while (store.count('observations')) { await pipeline.tick(); } }
    tip = 14; await intake.seal(); while (store.count('observations')) await pipeline.tick();
    const account = store.get('accountRecords', 'ar/' + agent), balanceKey = accountKey('balance', 'p2:0');
    assert.ok(account, 'claim settlement produced the root account');
    const proof = new AccountAvailability(store).prove(account.root, [balanceKey]);
    assert.equal(readAccountLeaf(account.root, proof, balanceKey).available, '1');
    assert.deepEqual(contract.db.get('ar/' + agent), account, 'gateway availability follows the accepted contract account');
    assert.ok(store.get('finds', 'f2:5:0'));
    assert.ok(signed >= 3); assert.equal(store.count('intake/' + intake.head.id), 0);
  } finally { await pipeline.close(); await store.close(); }
});
