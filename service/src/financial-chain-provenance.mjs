import { rules } from './rules.mjs';
import { check, serial } from './util.mjs';
import { financialChainSettings, moneyFreeFinancialInput, financialRebaseDeployment } from './financial-chain-policy.mjs';

const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const gameActions = new Set(['credit', 'credits', 'craft', 'transfer', 'compound-merge']);
const refuse = ok => check(ok, 'financial_chain_recovery_required');

function batchCheckpoints(files) {
  const checkpoints = [];
  for (const file of files) {
    const inputs = file.financialOperations ?? [];
    refuse(Array.isArray(inputs) && Array.isArray(file.ops) && inputs.every(input => Array.isArray(input.operations)));
    const operations = inputs.flatMap(input => input.operations), split = file.ops.length - operations.length;
    refuse(split >= 0 && same(file.ops.slice(split), operations));
    // Financial effects cannot hide outside the independently reconstructed
    // input suffix. Claim credits and ordinary game actions are not payment
    // evidence, but unannotated fp operations or financial ar actions are.
    refuse(file.ops.slice(0, split).every(op => op.op === 'ar' && op.v === 2 && Array.isArray(op.actions) &&
      op.actions.every(action => gameActions.has(action.type))));
    for (const input of inputs) {
      const anchor = input.chainAnchor, ops = input.operations.filter(op => op.op === 'fp' && op.type === 'checkpoint');
      refuse(anchor && ops.length === 1 && same(ops[0].anchor, anchor));
      checkpoints.push({ anchor, previous: ops[0].previous, moneyFree: moneyFreeFinancialInput(input), deployment: financialRebaseDeployment(input) });
    }
  }
  return checkpoints;
}

async function verifyBoundary(checkpoints, { prior, at, fork, losing }, bitcoinHash, canonicalBitcoinHash, verifyInput) {
  const branches = new Map(losing.map(anchor => [anchor.height, anchor.hash]));
  let previous = null, affected = false;
  for (const checkpoint of checkpoints) {
    const { anchor } = checkpoint;
    if (previous) refuse(checkpoint.previous === rules.hashObject(previous));
    if (BigInt(anchor.bitcoin.height) <= BigInt(fork.height)) {
      refuse(!affected && await bitcoinHash(anchor.bitcoin.height, at) === anchor.bitcoin.hash &&
        await canonicalBitcoinHash(anchor.bitcoin.height) === anchor.bitcoin.hash);
    } else {
      refuse(branches.get(anchor.bitcoin.height) === anchor.bitcoin.hash);
      if (!affected && !previous) refuse([
        rules.hashObject(null), rules.hashObject({ bitcoin: fork, ethereum: prior.ethereum })
      ].includes(checkpoint.previous));
      affected = true;
      await verifyInput(checkpoint);
    }
    previous = anchor;
  }
  refuse(affected && same(previous, prior));
}

// Each reader authenticates archives through its own accepted notary roots.
// Provenance is only a location hint. An unchanged checkpoint does not update
// that hint, so prove the entire bounded gap, including raw account effects.
export function createFinancialRebaseVerifier({ store, audits, bitcoinHash, canonicalBitcoinHash, deploymentIncluded, settings }) {
  const policy = financialChainSettings(settings);
  // Retain only the active losing anchor, compact checkpoint summaries and a
  // verified batch cursor, never a cache of historical files. A shared gate
  // coalesces concurrent inputs. Completed batches are not read again; a later
  // accepted tip verifies only its new suffix. A restart independently rebuilds
  // this bounded proof instead of trusting an unauthenticated persisted result.
  let cached;
  return args => {
    const identity = rules.hashObject(args.prior);
    if (cached?.identity !== identity) cached = { identity, gate: serial(), deployments: new Map() };
    const entry = cached;
    return entry.gate(async () => {
      const latest = BigInt(rules.decimalV2(args.at.last.n));
      if (!entry.location) {
        const location = await store.get('financialRecordProvenance', 'fp/chain');
        refuse(location && Number.isSafeInteger(location.file) && location.file >= 0 && Number.isSafeInteger(location.index) && location.index >= 0);
        entry.location = { ...location, n: rules.decimalV2(location.n) };
      }
      const origin = BigInt(entry.location.n);
      refuse(latest >= origin && latest - origin <= BigInt(policy.rebaseBatchLimit) && !entry.blocked);
      // An older snapshot cannot borrow a proof that includes newer effects.
      refuse(entry.through === undefined || latest >= entry.through);
      const verifyInput = async checkpoint => {
        if (checkpoint.moneyFree) return;
        const id = checkpoint.deployment;
        refuse(id && deploymentIncluded);
        if (entry.deployments.has(id)) return;
        // The existing adapter authenticates the reveal transaction and witness
        // against the canonical block and the retained view, not its old height
        // or confirmation count in an accepted financial evidence object.
        const inclusion = await deploymentIncluded(id, args.at);
        refuse(inclusion?.tx?.txid === id.slice(0, 64) && rules.hex(inclusion.blockHash, 32));
        const height = rules.decimalV2(inclusion.height);
        refuse(BigInt(height) <= BigInt(args.at.tip) && BigInt(rules.decimalV2(inclusion.confirmations)) > 0n &&
          await bitcoinHash(height, args.at) === inclusion.blockHash && await canonicalBitcoinHash(height) === inclusion.blockHash);
        entry.deployments.set(id, { height, hash: inclusion.blockHash });
        delete entry.deploymentStamp;
      };
      if (!entry.checkpoints) {
        const files = await audits(entry.location.n), committed = files[entry.location.file]?.financialOperations?.[entry.location.index];
        if (!committed?.recordCommitments?.some(([key, digest]) => key === 'fp/chain' && digest === identity) || !same(committed.chainAnchor, args.prior)) {
          // A stale local hint is not an immutable verdict about this anchor.
          // Let a repaired accepted-provenance projection supply it again.
          delete entry.location; refuse(false);
        }
        let checkpoints;
        try {
          checkpoints = batchCheckpoints(files);
        } catch (error) { entry.blocked = true; throw error; }
        if (!checkpoints.length || !same(checkpoints.at(-1).anchor, args.prior)) { delete entry.location; refuse(false); }
        entry.checkpoints = checkpoints;
        entry.through = origin;
      }
      // The caller rechecks current best-chain membership and the fork hash.
      // That immutable fork identity also pins its already verified ancestors.
      const boundary = rules.hashObject([args.fork, args.losing]);
      if (entry.boundary !== boundary) {
        await verifyBoundary(entry.checkpoints, args, bitcoinHash, canonicalBitcoinHash, verifyInput);
        entry.boundary = boundary;
      }
      while (entry.through < latest) {
        const n = entry.through + 1n;
        let checkpoints = entry.pending?.checkpoints;
        if (!checkpoints) {
          const files = await audits(String(n));
          try { checkpoints = batchCheckpoints(files); }
          catch (error) { entry.blocked = true; throw error; }
          entry.pending = { checkpoints };
        }
        try {
          for (const checkpoint of checkpoints) refuse((checkpoint.moneyFree || checkpoint.deployment) &&
            same(checkpoint.anchor, args.prior) && checkpoint.previous === identity);
        } catch (error) { entry.blocked = true; throw error; }
        // Source failures are retryable and cannot become an immutable verdict
        // about accepted bytes. Keep this compact pending batch for the retry.
        for (const checkpoint of checkpoints) await verifyInput(checkpoint);
        entry.through = n;
        delete entry.pending;
      }
      const stamp = rules.hashObject([args.at.tip, args.at.tipHash]);
      if (entry.deploymentStamp !== stamp) {
        // A cached transaction proof remains valid only on the current retained
        // branch, whose tip the caller independently checks before and after us.
        // Reuse the immutable inclusion; never refetch a deployment per input.
        for (const inclusion of entry.deployments.values()) refuse(BigInt(inclusion.height) <= BigInt(args.at.tip) &&
          await bitcoinHash(inclusion.height, args.at) === inclusion.hash);
        entry.deploymentStamp = stamp;
      }
      return true;
    });
  };
}
