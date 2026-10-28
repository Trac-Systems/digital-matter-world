import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Runtime } from '../src/v2-runtime.mjs';
import * as r from '../../rules/src/index.js';

test('incomplete mixed financial and state-proof integration cannot activate production', async () => {
  await assert.rejects(createV2Runtime({ config: { mode: 'prod' } }), /v2_release_incomplete/);
});
test('named commitment availability cannot change an independently accepted value or root', () => {
  const settings = r.settingsRevision({ network: 'proof-test', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
  const agent = r.hash('player'), commitment = r.hash('commitment'), key = `commit/${agent}/${commitment}`;
  const named = r.commitNamedDiscovery(r.emptyNamedDiscovery(), { agent, commitment, tip: '5', receiptPosition: '1', settings });
  const saved = new r.NamedStorage({ get: () => null, cacheSize: 64 }).save(named), nodes = new Map(saved.writes.map(w => [w.id, w.value]));
  const proof = r.proveNamedRecord({ snapshot: saved.snapshot, get: id => nodes.get(id), key, settings }), root = r.namedStateRoot(named);
  assert.equal(r.verifyNamedRecord(proof, { root, key, settings }).commitment, commitment);
  assert.throws(() => r.verifyNamedRecord({ ...proof, value: { ...proof.value, eligible: '0' } }, { root, key, settings }), /named_record_value/);
  assert.throws(() => r.verifyNamedRecord(proof, { root: r.hash('different'), key, settings }), /named_record_proof/);
  assert.throws(() => r.verifyNamedRecord({ ...proof, nodes: [] }, { root, key, settings }), /named_storage_integrity/);
});
