import { recoveryBatch } from '../../rules/src/recovery-batch.js';
import { rules } from './adapter.mjs';
import { check, equal } from './crypto.mjs';
import { verifyFinancialExecution } from './financial-execution.mjs';

export async function verifyRecoveryBatch(policy, proposal) {
  const { reads, network, publicKey } = policy, at = await reads.batchStamp(), authority = await reads.authority(), context = await reads.rulesContext();
  check(authority.network === network && authority.committee === publicKey && context?.ready && context.ruleset === 'dmw-v2' &&
    proposal.recovery === true && proposal.files?.length === 1, 'recovery_batch_authority');
  const file = rules.decodeBinary(Buffer.from(proposal.files[0], 'hex'));
  check(file.v === 6 && file.kind === 'financial-recovery' && file.network === network, 'recovery_batch_file');
  const document = rules.effectiveSettings(context.settings, context.scheduledSettings, rules.nextUint(rules.decimalV2(at.last.n)), rules.decimalV2(at.counted));
  await verifyFinancialExecution({ files: [file], reads, document, network, height: at.counted, at });
  const previous = BigInt(at.last.n) > 0n ? await reads.batchRoot(at.last.n) : context.manifest.previousBatchRoot;
  const expected = recoveryBatch({ network, epoch: authority.epoch, at, previous, context, document, snapshot: file.previousSnapshot,
    inputs: file.financialOperations, executionHash: await reads.financialNotaryHashAt(at.counted, at) });
  check(equal(file, expected.file) && proposal.files[0] === expected.encoded && equal(proposal.batch, expected.batch), 'recovery_batch_binding');
  const preflight = await reads.preflight(expected.batch, at), digest = rules.bytesToHex(rules.batchDigest(network, expected.batch));
  check(preflight?.ok && preflight.digest === digest && rules.compareOrdinal(preflight.counted, at.counted) === 0 &&
    equal(preflight.last, at.last) && equal(await reads.batchStamp(), at), 'recovery_batch_preflight');
  return { digest, slots: [`batch/${expected.batch.epoch}/${expected.batch.n}`], details: { root: expected.batch.root, epoch: expected.batch.epoch,
    n: expected.batch.n, deadline: expected.batch.deadline, batch: expected.batch }, batch: expected.batch };
}
