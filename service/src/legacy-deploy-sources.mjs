import { rules } from './rules.mjs';
import { check } from './util.mjs';

// Membership and equal amounts were pinned by accepted fee terms. Ownership
// is intentionally read later, at the confirmed mint's verification snapshot.
export async function legacyDeployMintCommissions(reads, source, at, bitcoinNetwork = 'mainnet') {
  if (!source.legacyDeploy) return {};
  const liability = source.legacyDeploy;
  check(rules.legacyDeployShareActive(at?.executionHeight ?? at?.counted ?? await reads.counted()), 'legacy_deploy_inactive');
  check(source.deployment.kind === 'dmt' && source.deployment.elementId === liability.element &&
    source.deployment.privilege === liability.authority, 'legacy_deploy_binding');
  const ids = rules.legacyDeployments(liability.element, liability.authority, bitcoinNetwork);
  check(typeof reads.deploymentHolders === 'function', 'legacy_deploy_holder_reader');
  const holders = await reads.deploymentHolders(ids, at);
  return { commissions: rules.legacyDeployCommissions(source.requestId, liability, holders, bitcoinNetwork) };
}
