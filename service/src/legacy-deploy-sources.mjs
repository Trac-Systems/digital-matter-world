import { rules } from './rules.mjs';
import { check } from './util.mjs';

// Membership and equal amounts were pinned by accepted fee terms. Ownership
// is intentionally read later, at the confirmed mint's verification snapshot.
async function legacyCommissions(reads, source, at, bitcoinNetwork = 'mainnet') {
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

// Keep all ownership reads under one canonical TAP fence, including when the
// same address currently holds both kinds of deployment inscription.
export async function legacyDeployMintCommissions(reads, source, at, bitcoinNetwork = 'mainnet') {
  const resolve = async () => {
    const result = await legacyCommissions(reads, source, at, bitcoinNetwork);
    if (!source.deployer) return result;
    check(rules.multiTickerActive(at?.executionHeight ?? at?.counted ?? await reads.counted()), 'multi_ticker_inactive');
    check(source.deployer.deployment === source.deployment.id && ['dmt', 'compound'].includes(source.deployment.kind), 'deployer_binding');
    check(typeof reads.deploymentHolders === 'function', 'deployer_holder_reader');
    const holders = await reads.deploymentHolders([source.deployment.id], at);
    check(holders.length === 1, 'deployer_holder');
    return { commissions: [...result.commissions ?? [], rules.deployerCommission(source.requestId, source.deployer, holders[0], bitcoinNetwork)] };
  };
  return reads.withTapSnapshot && source.deployer ? reads.withTapSnapshot(at, resolve) : resolve();
}
