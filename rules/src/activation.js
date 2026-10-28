import { assert, exactKeys, hashObject, hex, networkId } from './core.js';
import { compareUint, uintV2, decimalV2 } from './integers-v2.js';
import { processBlockV2, buildBatchV2 } from './batch-v2.js';
import * as legacy from '../legacy/v1/rules/src/index.js';
import { freezeDocument } from './settings-v2.js';

export { legacy as legacyRules };
export function activationManifest(value, expectedHash) {
  assert(exactKeys(value, ['version', 'network', 'fromRuleset', 'toRuleset', 'effectiveBatch', 'previousBatchRoot',
    'bitcoinAnchor', 'settingsHash', 'catalogRoot', 'accountsRoot', 'receiptSegmentStart', 'schemas', 'minimumKitVersion', 'route']), 'activation_fields');
  assert(value.version === 1 && value.fromRuleset === 'dmw-v1' && value.toRuleset === 'dmw-v2', 'activation_version');
  networkId(value.network); uintV2(value.effectiveBatch); uintV2(value.receiptSegmentStart);
  assert(compareUint(value.effectiveBatch, '0') > 0, 'activation_batch');
  for (const k of ['previousBatchRoot', 'settingsHash', 'catalogRoot', 'accountsRoot']) assert(hex(value[k], 32), 'activation_root');
  assert(exactKeys(value.bitcoinAnchor, ['height', 'hash']) && hex(value.bitcoinAnchor.hash, 32), 'activation_anchor');
  uintV2(value.bitcoinAnchor.height);
  assert(exactKeys(value.schemas, ['batch', 'file', 'integer', 'receipt']) && value.schemas.batch === 2 && value.schemas.file === 5 &&
    value.schemas.integer === 2 && value.schemas.receipt === 2, 'activation_schema');
  assert(typeof value.minimumKitVersion === 'string' && /^\d+\.\d+\.\d+$/.test(value.minimumKitVersion), 'activation_kit');
  assert(value.route === 'terminal-import', 'activation_route_unsupported');
  assert(hashObject(value) === expectedHash, 'activation_pin');
  return freezeDocument(structuredClone(value));
}
const v2Rules = Object.freeze({ processBlock: processBlockV2, buildBatch: buildBatchV2 });
export function rulesForBatch({ batch, manifest, manifestHash, previousRoot, hashAt, settingsHistory, network }) {
  networkId(network);
  assert(batch && [1, 2].includes(batch.v), 'batch_version_unsupported');
  const sequence = batch.v === 1 ? (assert(Number.isSafeInteger(batch.n) && batch.n > 0, 'batch_sequence'), String(batch.n)) : decimalV2(batch.n);
  if (manifest) {
    manifest = activationManifest(manifest, manifestHash);
    assert(manifest.network === network, 'activation_network');
  }
  const activated = manifest && compareUint(sequence, manifest.effectiveBatch) >= 0;
  if (!activated) { assert(batch.v === 1 && (batch.ruleset === undefined || batch.ruleset === 'dmw-v1'), 'batch_ruleset'); return legacy; }
  assert(batch.v === 2 && batch.ruleset === 'dmw-v2', 'upgrade_required');
  const predecessor = batch.previous ?? batch.previousRoot;
  assert(hex(predecessor, 32) && predecessor === previousRoot, 'batch_predecessor');
  if (sequence === manifest.effectiveBatch) assert(previousRoot === manifest.previousBatchRoot, 'activation_predecessor');
  assert(typeof hashAt === 'function' && hashAt(manifest.bitcoinAnchor.height) === manifest.bitcoinAnchor.hash, 'activation_anchor');
  const window = decimalV2(batch.execution?.height ?? batch.bitcoinWindow);
  const settings = settingsHistory.at(sequence, window);
  assert(settings.network === network && settings.revision === batch.settingsRevision && hashObject(settings) === batch.settingsHash, 'batch_settings');
  if (sequence === manifest.effectiveBatch) assert(batch.settingsHash === manifest.settingsHash && settings.effectiveBatch === sequence, 'activation_settings');
  return v2Rules;
}
