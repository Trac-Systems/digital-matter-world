import { selectedDeployment } from './registry.mjs';
import { legacyDeployMintCommissions } from './legacy-deploy-sources.mjs';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { verifyDeployment } from './deployments.mjs';
import { capacityKey } from '../../contract/financial-capacity.js';

export const financialGenerationId = (network, asset, deployment) => rules.hashObject(['dmw-financial-generation-v2', network, asset, deployment]);

export function installCapacitySources(reads, { network, bitcoinNetwork = 'mainnet', accepted }) {
  reads.financialDeploymentState = async (asset, at, selection) => {
    await reads.ensureRegistryAsset?.(asset, selection);
    const registry = await reads.registry(), entry = selectedDeployment(registry, asset, selection);
    check(entry?.id, 'financial_deployment_missing');
    if (entry.officialDeployment) check(rules.multiTickerActive(at?.executionHeight ?? at?.counted ?? await reads.counted()), 'multi_ticker_inactive');
    const id = financialGenerationId(network, asset, entry.id), existing = await reads.financialRecord('fd/' + id, at);
    if (existing) {
      check(existing.asset === asset && existing.deployment === entry.id && await reads.financialRecord(entry.officialDeployment ? 'fd/external/' + rules.hashObject(entry.id) : 'fd/asset/' + asset, at) === id, 'financial_deployment_generation');
      return { id, existing, entry };
    }
    return { id, entry };
  };
  reads.financialDeployment = async (asset, at, selection) => {
    const { id, existing, entry } = await reads.financialDeploymentState(asset, at, selection);
    if (existing) return { id, existing };
    const verified = await verifyDeployment(reads, entry, { view: at }), d = verified.deployment;
    check(verified.authorityKey === (await reads.authority()).committee, 'financial_deployment_authority');
    const maximum = d.max, remaining = await reads.tap('getMintTokensLeft/' + (entry.indexTick ?? entry.tick));
    check(typeof maximum === 'string' && /^[1-9][0-9]*$/.test(maximum) && remaining === maximum, 'financial_deployment_not_pristine');
    const outstanding = BigInt(await reads.financialRecord(capacityKey(entry.id), at) ?? '0') + BigInt(await reads.financialRecord('fi/deployment/' + entry.id, at) ?? '0');
    check(outstanding === 0n, 'financial_deployment_outstanding');
    const previous = await reads.financialRecord('fd/asset/' + asset, at), prior = previous && await reads.financialRecord('fd/' + previous, at);
    if (entry.officialDeployment) {
      const official = financialGenerationId(network, asset, entry.officialDeployment), acceptedOfficial = await reads.financialRecord('fd/' + official, at);
      check(acceptedOfficial?.asset === asset && acceptedOfficial.deployment === entry.officialDeployment, 'official_deployment_required');
      const deployment = { asset, deployment: entry.id, official, maximum, limit: d.lim ?? '0' };
      return { id, action: { type: 'deployment-add', id, ...deployment }, evidence: { requestId: id, state: 'deployed', confirmations: 1,
        deployment, minted: '0', outstanding: '0', remaining } };
    }
    check(!previous || prior && prior.minted === prior.maximum && prior.reserved === '0', 'financial_deployment_unexhausted');
    const deployment = { asset, deployment: entry.id, generation: prior ? rules.nextUint(prior.generation) : '0', previous, maximum, limit: d.lim ?? '0' };
    return { id, action: { type: 'deployment-open', id, ...deployment }, evidence: { requestId: id, state: 'deployed',
      confirmations: 1, deployment, minted: '0', outstanding: '0', remaining } };
  };
  reads.financialCapacityEvidence = async (a, at) => {
    if (['deployment-open', 'deployment-add'].includes(a.type)) {
      const result = await reads.financialDeployment(a.asset, at, a.type === 'deployment-add' ? a.deployment : undefined);
      check(result.action && rules.stableJSON(result.action) === rules.stableJSON(a), 'financial_deployment_terms');
      return result.evidence;
    }
    const { row, funding, source } = await accepted(a.id, at);
    const capacity = await reads.financialRecord('dc/' + a.id, at) ?? (source.legacy && funding.capacity && !funding.minted ? {
      ...funding.capacity, deployment: source.deployment.id, terms: funding.terms, plot: row.request.block === undefined ? null : rules.decimalV2(row.request.block), state: 'issued' } : null);
    check(capacity && capacity.terms === funding.terms && capacity.asset === row.request.asset && capacity.amount === row.request.amount, 'financial_capacity_identity');
    if (a.type === 'capacity-finish') {
      check(capacity.state === 'issued' && funding.state === 'consumed' && a.permitHash === funding.permitHash && row.permit?.prv?.hash === a.permitHash, 'financial_capacity_permit');
      const minted = await reads.mint(a.id, at);
      check(minted?.accepted && minted.fail === false && minted.confirmations >= 1 && minted.permitHash === a.permitHash &&
        minted.deployment === source.deployment.id && minted.amount === row.request.amount && minted.receiver === row.receiver &&
        minted.tick === source.deployment.tick && minted.committee === source.deployment.privilegePublicKey &&
        (capacity.plot === null || rules.decimalV2(minted.block) === capacity.plot), 'financial_capacity_mint');
      return { requestId: a.id, state: 'minted', confirmations: 1, permitHash: a.permitHash,
        deployment: capacity.deployment, asset: capacity.asset, amount: capacity.amount, plot: capacity.plot,
        inscription: minted.inscription,
        ...await legacyDeployMintCommissions(reads, source, at, bitcoinNetwork),
        receipt: rules.hashObject(['dmw-external-mint-v2', source.deployment.id, minted.inscription, a.permitHash]) };
    }
    throw Error('financial_capacity_transition');
  };
}
