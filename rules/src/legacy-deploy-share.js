import * as btc from '@scure/btc-signer';
import { assert } from './core.js';
import { decimalV2 } from './integers-v2.js';
import { LEGACY_DEPLOY_MANIFEST } from './legacy-deploy-manifest.js';

// One coordinated release gate. Quotes preview the counted height; batch
// execution supplies its own height and never trusts a quote's clock.
export const LEGACY_DEPLOY_SHARE_HEIGHT = '973870';
export const legacyDeployShareActive = height => BigInt(decimalV2(height)) >= BigInt(LEGACY_DEPLOY_SHARE_HEIGHT);
const inscription = value => typeof value === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(value);
export function legacyDeployments(element, authority, bitcoinNetwork = 'mainnet') {
  if (bitcoinNetwork !== LEGACY_DEPLOY_MANIFEST.network) return [];
  assert(inscription(authority), 'legacy_deploy_authority');
  return (LEGACY_DEPLOY_MANIFEST.elements[element] ?? []).filter(row => row.privilege !== authority).map(row => row.id);
}

// Missing optional settings retain all historical bytes. Economic settings
// must be a complete validated group before this function can allocate.
export function legacyDeployFee(total, split, { kind, deployment, document, height, bitcoinNetwork = 'mainnet' }) {
  if (kind !== 'find' || !document?.values.legacyDeployShareBps || !legacyDeployShareActive(height)) return { split };
  const ids = legacyDeployments(deployment.elementId, deployment.privilege, bitcoinNetwork);
  if (!ids.length) return { split };
  const perDeploy = BigInt(total) * BigInt(document.values.legacyDeployShareBps) / 10000n / BigInt(ids.length);
  if (!perDeploy) return { split };
  const amount = perDeploy * BigInt(ids.length);
  assert(amount <= BigInt(split.burn), 'legacy_deploy_burn');
  assert(BigInt(document.values.legacyDeployPayoutMinAtoms) > 0n, 'legacy_deploy_threshold');
  return { split: { ...split, burn: String(BigInt(split.burn) - amount), legacyDeploy: String(amount) },
    legacyDeploy: { element: deployment.elementId, authority: deployment.privilege, count: ids.length,
      perDeploy: String(perDeploy), amount: String(amount), payoutMinAtoms: document.values.legacyDeployPayoutMinAtoms } };
}

// One item per deployment, even when several inscriptions share one address.
// The caller independently verifies each address at the mint snapshot.
export function legacyDeployHolderAddress(address, bitcoinNetwork = 'mainnet') {
  assert(typeof address === 'string' && address.length <= 90 && ['mainnet', 'regtest'].includes(bitcoinNetwork), 'legacy_deploy_holder');
  // All Bitcoin address types qualify; no Trac binding or Taproot-only filter.
  btc.Address(bitcoinNetwork === 'mainnet' ? btc.NETWORK : { ...btc.TEST_NETWORK, bech32: 'bcrt' }).decode(address);
  return address;
}
export function legacyDeployCommissions(id, liability, holders, bitcoinNetwork = 'mainnet') {
  const ids = legacyDeployments(liability.element, liability.authority, bitcoinNetwork);
  assert(ids.length === liability.count && ids.length === holders.length &&
    BigInt(liability.perDeploy) > 0n && BigInt(liability.perDeploy) * BigInt(ids.length) === BigInt(liability.amount), 'legacy_deploy_liability');
  return ids.map((deployment, i) => {
    const holder = holders[i];
    assert(holder?.id === deployment && typeof holder.address === 'string' && holder.address.length > 0, 'legacy_deploy_holder');
    return { id, role: 'legacyDeploy', deployment, to: legacyDeployHolderAddress(holder.address, bitcoinNetwork), amount: liability.perDeploy,
      payoutMinAtoms: liability.payoutMinAtoms };
  });
}
