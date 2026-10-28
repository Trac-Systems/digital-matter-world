import { StateTransition } from '../../contract/state.js';
import { batchSettingsDocument, installSettings } from '../../contract/settings-v2.js';
import { checkBatchV2 } from '../../contract/batch-v2.js';
import { executionSettingsDocument } from '../../contract/receipt-renewal.js';
import { check, equal } from './crypto.mjs';
import { rules } from './adapter.mjs';
// Reuse the deployed transition's operation implementation with a disposable
// write set. The read client pins every read to the same authoritative snapshot.
export async function preflightBatch(batch, at, { read, deployment }) {
  const state = new StateTransition(key => read(key, at), deployment);
  const clock = rules.ordinalCodec(!!batch.settingsHash);
  const head = await state.head(), last = await state.batchLast(); let settings = await state.settings();
  const document = batch.v === 2 ? await executionSettingsDocument(state, batch) : null;
  if (document) { settings = { ...settings, batch_bytes: document.values.batchBytes, batch_ops: document.values.batchOps, batch_assets: document.values.batchAssets, batch_kv: document.values.batchKv }; }
  // Header counting may run ahead of an anchored batch's execution height; the accepted batch must not.
  check(clock.compare(head.counted, at.counted) >= 0 && equal(last, at.last) && !await state.paused(), 'preflight_snapshot');
  check(clock.valid(batch.deadline), 'preflight:batch_deadline');
  check(rules.utf8(rules.stableJSON({ ...batch, sig: '0'.repeat(128) })).length <= settings.batch_bytes && batch.ops.length <= settings.batch_ops, 'preflight_budget');
  if (batch.hx?.length) { const result = await state.beacon().ingest(batch.hx, deployment.admin); check(!result.error, `preflight:${result.error}`);  }
  const applied = (await state.head()).counted;
  const horizon = batch.v === 2 ? document?.values.batchMaxDeadlineTips ?? deployment.batchActivation?.settings?.batchDeadlineMaxBlocks ?? rules.MAX_BATCH_HORIZON : rules.MAX_BATCH_HORIZON;
  check(clock.valid(batch.deadline) && clock.compare(batch.deadline, applied) >= 0 && clock.compare(batch.deadline, clock.add(applied, horizon)) <= 0, 'preflight:batch_deadline');
  check(clock.compare(batch.to, applied) <= 0 && batch.n === clock.add(last.n) && batch.from === clock.add(last.to, batch.v === 2 ? 0 : 1) && batch.epoch === await state.committeeEpoch(), 'preflight_batch');
  if (batch.v === 2) check(!await checkBatchV2(state, batch, last) && clock.compare(batch.execution.height, applied) <= 0, 'preflight_activation');
  else check(!deployment.batchActivation || batch.n < deployment.batchActivation.sequence, 'preflight_activation');
  if (document) installSettings(state, document);
  const budget = { assets: 0, kv: 0 };
  for (const op of batch.ops) { const error = await state.batchOp(op, applied, settings, budget); check(!error, `preflight:${error}`); }
  return { ok: true, counted: applied, last, digest: rules.bytesToHex(rules.batchDigest(deployment.network, batch)) };
}
