import { StateTransition } from '../../contract/state.js';
import { check, equal } from './crypto.mjs';
import { rules } from './adapter.mjs';
// Reuse the deployed transition's operation implementation with a disposable
// write set. The read client pins every read to the same authoritative snapshot.
export async function preflightBatch(batch, at, { read, deployment }) {
  const state = new StateTransition(key => read(key, at), deployment);
  const head = await state.head(), last = await state.batchLast(), settings = await state.settings();
  check(head.counted === at.counted && equal(last, at.last) && !await state.paused(), 'preflight_snapshot');
  check(Number.isSafeInteger(batch.deadline) && batch.deadline >= 0, 'preflight:batch_deadline');
  check(rules.utf8(rules.stableJSON({ ...batch, sig: '0'.repeat(128) })).length <= settings.batch_bytes && batch.ops.length <= settings.batch_ops, 'preflight_budget');
  if (batch.hx?.length) { const result = await state.beacon().ingest(batch.hx, deployment.admin); check(!result.error, `preflight:${result.error}`);  }
  const applied = (await state.head()).counted;
  check(Number.isSafeInteger(batch.deadline) && batch.deadline >= applied && batch.deadline - applied <= rules.MAX_BATCH_HORIZON, 'preflight:batch_deadline');
  check(batch.to <= applied && batch.n === last.n + 1 && batch.from === last.to + 1 && batch.epoch === await state.committeeEpoch(), 'preflight_batch');
  const budget = { assets: 0, kv: 0 };
  for (const op of batch.ops) { const error = await state.batchOp(op, applied, settings, budget); check(!error, `preflight:${error}`); }
  return { ok: true, counted: applied, last, digest: rules.bytesToHex(rules.batchDigest(deployment.network, batch)) };
}
