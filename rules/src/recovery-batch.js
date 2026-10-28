import { assert, hashObject, stableJSON, bytesToHex } from './core.js';
import { decimalV2, nextUint, addUint } from './integers-v2.js';
import { encodeBinary } from './binary.js';
import { merkleRoot } from './merkle.js';
import { accountOperationsRoot } from './account-batch.js';
import { claimStateRoot } from './claim-state.js';

// A recovery batch never consumes a receipt segment or changes claim awards.
// It advances only the observation ordinal in the authenticated checkpoint,
// preserving pending journals and the ordinary batch's counted range.
export function recoveryBatch({ network, epoch, at, previous, context, document, snapshot, inputs, executionHash }) {
  assert(claimStateRoot(snapshot) === context.claimsRoot && document.network === network && inputs.length > 0 &&
    inputs.every(i => i.transition.type === 'beacon-recovery' || i.transition.type === 'lifecycle' && i.transition.action.type.startsWith('recovery-')), 'recovery_batch_inputs');
  const observation = nextUint(decimalV2(snapshot.hot.observation)), nextSnapshot = structuredClone(snapshot);
  nextSnapshot.hot.observation = observation;
  const ops = inputs.flatMap(i => i.operations), empty = merkleRoot([]), settingsHash = hashObject(document);
  const file = { v: 6, kind: 'financial-recovery', network, height: decimalV2(at.counted), tip: decimalV2(at.tip), tipHash: at.tipHash,
    settingsHash, previousSnapshot: snapshot, financialOperations: inputs, ops };
  const bytes = encodeBinary(file);
  assert(bytes.length <= document.values.auditChunkBytes, 'recovery_audit_bytes');
  const batch = { v: 2, epoch: decimalV2(epoch), n: nextUint(decimalV2(at.last.n)), from: decimalV2(at.last.to), to: decimalV2(at.last.to),
    deadline: addUint(decimalV2(at.counted), String(document.values.batchMaxDeadlineTips)), root: merkleRoot([bytes]), ops,
    previous, ruleset: 'dmw-v2', settingsRevision: document.revision, execution: { height: decimalV2(at.counted), hash: executionHash },
    observation, receipts: empty, finds: empty, catalog: context.catalogRoot, accounts: accountOperationsRoot(ops), settingsHash,
    previousClaims: context.claimsRoot, claims: claimStateRoot(nextSnapshot) };
  assert(Buffer.byteLength(stableJSON({ ...batch, sig: '0'.repeat(128) })) <= document.values.batchBytes && ops.length <= document.values.batchOps, 'recovery_batch_bytes');
  return { batch, file, bytes, snapshot: nextSnapshot, encoded: bytesToHex(bytes) };
}
