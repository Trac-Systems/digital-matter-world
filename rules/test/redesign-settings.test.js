import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hash, hashObject, SETTINGS_PROFILE, settingsRevision, SettingsHistory, validateSettings,
  activationManifest, rulesForBatch, legacyRules, findIdV2, parseFindIdV2, nextUint,
  RESOURCE_PROFILE, resourceRevision, ResourceHistory, validateResourceDocument, processBlockV2, buildBatchV2 } from '../src/index.js';

const settings = (overrides = {}) => settingsRevision({ network: 'fixture', effectiveBatch: '43', effectiveBitcoinWindow: '100', values: { ...SETTINGS_PROFILE }, ...overrides });
test('settings revisions are complete, pinned, immutable, ordered, and selected by both clocks', () => {
  const first = settings(), second = settings({ previous: first, effectiveBatch: '45', effectiveBitcoinWindow: '101', values: { ...SETTINGS_PROFILE, claimsPerWindow: 200 } });
  const history = new SettingsHistory();
  assert.throws(() => history.append(first, hash('wrong')), /settings_pin/);
  history.append(first, hashObject(first)); history.append(second, hashObject(second));
  assert.equal(history.at('44', '100').values.claimsPerWindow, 100);
  assert.equal(history.at('45', '101').values.claimsPerWindow, 200);
  assert.equal(history.get(hashObject(first)).values.claimsPerWindow, 100);
  assert.equal(history.at('45', '100').revision, '0');
  assert.throws(() => history.at('42', '100'), /settings_not_effective/);
  assert.throws(() => history.append(first, hashObject(first)), /settings_history/);
  assert.throws(() => { first.values.claimsPerWindow = 3; }, TypeError);
  assert.throws(() => validateSettings({ ...SETTINGS_PROFILE, surprise: 1 }), /settings_keys/);
  assert.throws(() => validateSettings({ ...SETTINGS_PROFILE, patternMaxLength: 65 }), /settings_capability/);
  assert.throws(() => validateSettings({ ...SETTINGS_PROFILE, minMatchingBlocks: 101 }), /settings_witness_budget/);
});
test('local resources have pinned retained history without changing consensus defaults', () => {
  const one = resourceRevision({ operator: 'fixture', values: { ...RESOURCE_PROFILE } });
  const two = resourceRevision({ operator: 'fixture', values: { ...RESOURCE_PROFILE, senderBurst: 16 }, previous: one });
  const history = new ResourceHistory();
  assert.throws(() => history.append(one, hash('wrong')), /resource_pin/);
  history.append(one, hashObject(one)); history.append(two, hashObject(two));
  assert.equal(history.current().values.senderBurst, 16); assert.equal(history.get(hashObject(one)).values.senderBurst, 8);
  assert.throws(() => history.append(one, hashObject(one)), /resource_history/);
  assert.throws(() => resourceRevision({ operator: 'fixture', values: { senderBurst: 2 } }), /resource_keys/);
  assert.equal(settings().values.claimsPerWindow, 100);
});
test('resource v4 upgrades retain the original v3 document and reject pages beyond local storage capacity', () => {
  const { relayObservationPage, committeeHealthMs, committeeReadyMs, committeeRequestMs,
    committeeResponseBytes, committeePollMs, committeeHistoryPage,
    closureWorkPerSecond, closureReadsPerSecond, closureBytesPerSecond, closureTimeoutPaddingMs,
    assetPublicMintsPerPayer, assetPublicMintsPerIP, assetPublicMintStartsPerMinute,
    assetPublicBulkMintBlocks, assetPublicBulkInputBytes, assetPublicBulkResponseBytes, ...previousValues } = RESOURCE_PROFILE;
  const previous = { version: 3, operator: 'fixture', revision: '0', previousHash: null, values: previousValues };
  const pinned = hashObject(previous), history = new ResourceHistory();
  assert.equal(validateResourceDocument(previous), previous); history.append(previous, pinned);
  const next = resourceRevision({ operator: 'fixture', previous, values: { ...RESOURCE_PROFILE, relayObservationPage: 1, committeeHistoryPage: 1 } });
  assert.equal(next.version, 6); assert.equal(next.previousHash, pinned); history.append(next, hashObject(next));
  assert.equal(hashObject(history.get(pinned)), pinned); assert.equal(history.get(pinned).version, 3);
  for (const key of ['relayObservationPage', 'committeeHistoryPage']) assert.throws(() => resourceRevision({
    operator: 'fixture', values: { ...RESOURCE_PROFILE, [key]: RESOURCE_PROFILE.storePageRows + 1 }
  }), /resource_page/);
});
test('activation pins predecessor, anchor and settings before dispatching v2 execution', () => {
  const document = settings(), history = new SettingsHistory(); history.append(document, hashObject(document));
  const manifest = { version: 1, network: 'fixture', fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '43',
    previousBatchRoot: hash('42'), bitcoinAnchor: { height: '100', hash: hash('anchor') }, settingsHash: hashObject(document),
    catalogRoot: hash('catalog'), accountsRoot: hash('accounts'), receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const context = { manifest, manifestHash: hashObject(manifest), network: 'fixture', previousRoot: hash('42'), hashAt: () => hash('anchor'), settingsHistory: history };
  assert.deepEqual(activationManifest(manifest, hashObject(manifest)), manifest);
  assert.equal(rulesForBatch({ ...context, batch: { v: 1, n: 42 } }), legacyRules);
  assert.equal(rulesForBatch({ network: 'fixture', batch: { v: 1, n: 9000 } }), legacyRules);
  assert.throws(() => rulesForBatch({ ...context, batch: { v: 1, n: 43 } }), /upgrade_required/);
  const batch = { v: 2, n: '43', ruleset: 'dmw-v2', previousRoot: hash('42'), bitcoinWindow: '100', settingsHash: hashObject(document), settingsRevision: '0' };
  assert.equal(rulesForBatch({ ...context, batch }).processBlock, processBlockV2);
  const wire = { ...batch, n: 43, previous: batch.previousRoot, execution: { height: 100 } }; delete wire.previousRoot; delete wire.bitcoinWindow;
  assert.equal(rulesForBatch({ ...context, batch: wire }).buildBatch, buildBatchV2);
  assert.throws(() => rulesForBatch({ ...context, batch, previousRoot: hash('wrong') }), /batch_predecessor/);
  assert.throws(() => rulesForBatch({ ...context, batch, hashAt: () => hash('reorg') }), /activation_anchor/);
  assert.throws(() => rulesForBatch({ ...context, batch: { ...batch, settingsRevision: '1' } }), /batch_settings/);
  assert.throws(() => rulesForBatch({ ...context, batch: { v: 3, n: '43' } }), /batch_version_unsupported/);
});
test('large integer keys cross u32 and safe-number boundaries without collisions or rounding', () => {
  for (const n of ['4294967295', '4294967296', '9007199254740991', '9007199254740992', '9'.repeat(100)]) {
    assert.deepEqual(parseFindIdV2(findIdV2(n, nextUint(n))), { height: n, pattern: nextUint(n) });
    assert.notEqual(findIdV2(n, '1'), findIdV2('1', n));
  }
  for (const n of [1, -1, '01', '-0', '1e3', '']) assert.throws(() => findIdV2(n, '1'));
});
test('frozen legacy verifier source and signing dependencies match the baseline byte for byte', async () => {
  const root = new URL('../legacy/v1/', import.meta.url), manifest = JSON.parse(await readFile(new URL('manifest.json', root)));
  for (const [path, expected] of Object.entries(manifest.files)) assert.equal(hash(await readFile(new URL(path, root))), expected, path);
});
