import { assert } from './core.js';
import { multiTickerActive } from './multi-ticker-activation.js';
import { legacyDeployFee, legacyDeployHolderAddress } from './legacy-deploy-share.js';

// Both deferred holder shares are backed by the existing treasury payment.
// The gross price and every non-burn beneficiary stay unchanged.
export function deploymentHolderFee(total, baseSplit, options) {
  const result = legacyDeployFee(total, baseSplit, options);
  const { kind, document, height, deployment } = options;
  if (!['find', 'compound'].includes(kind) || !document?.values.deployerShareBps || !multiTickerActive(height)) return result;
  const amount = BigInt(total) * BigInt(document.values.deployerShareBps) / 10000n;
  if (!amount) return result;
  assert(typeof deployment?.id === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(deployment.id), 'deployer_deployment');
  assert(amount <= BigInt(result.split.burn), 'deployer_burn');
  assert(BigInt(document.values.legacyDeployPayoutMinAtoms ?? '0') > 0n, 'deployer_threshold');
  return { ...result, split: { ...result.split, burn: String(BigInt(result.split.burn) - amount), deployer: String(amount) },
    deployer: { deployment: deployment.id, amount: String(amount), payoutMinAtoms: document.values.legacyDeployPayoutMinAtoms } };
}
export function deployerCommission(id, liability, holder, bitcoinNetwork = 'mainnet') {
  assert(holder?.id === liability.deployment && /^[1-9][0-9]*$/.test(liability.amount) &&
    /^[1-9][0-9]*$/.test(liability.payoutMinAtoms), 'deployer_liability');
  return { id, role: 'deployer', deployment: liability.deployment,
    to: legacyDeployHolderAddress(holder.address, bitcoinNetwork), amount: liability.amount, payoutMinAtoms: liability.payoutMinAtoms };
}
