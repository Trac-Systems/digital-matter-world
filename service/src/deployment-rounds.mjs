import { check, serial, hash } from './util.mjs';
import { rules } from './rules.mjs';

// These counters include reserved AND issued permits until an independently
// verified terminal result. Indexed external remaining supply alone is not a
// reservation. Callers must import outstanding legacy permits before enabling.
export class DeploymentRounds {
  constructor({ store, readDeployment, verifyTerminal, prepareRound }) {
    Object.assign(this, { store, readDeployment, verifyTerminal, prepareRound }); this.gate = serial();
  }
  reserve({ id, asset, deployment, amount, plot = null }) { return this.gate(async () => {
    check(typeof amount === 'string' && /^[1-9][0-9]*$/.test(amount), 'capacity_amount');
    const old = this.store.get('capacityRequests', id), terms = { id, asset, deployment, amount, plot };
    if (old) { check(rules.stableJSON(old.terms) === rules.stableJSON(terms), 'capacity_identity'); return old; }
    const d = await this.readDeployment(deployment); check(d.id === deployment && d.asset === asset && d.active, 'capacity_deployment');
    check(/^(0|[1-9][0-9]*)$/.test(d.remaining) && /^(0|[1-9][0-9]*)$/.test(d.limit), 'capacity_supply');
    const reserved = BigInt(this.store.get('deploymentReserved', deployment) ?? '0');
    check(reserved + BigInt(amount) <= BigInt(d.remaining) && (d.limit === '0' || BigInt(amount) <= BigInt(d.limit)), 'capacity_reserved');
    const plotKey = plot === null ? null : asset + '/' + plot;
    check(!plotKey || !this.store.get('capacityPlots', plotKey), 'capacity_plot');
    const row = { terms, state: 'reserved' };
    await this.store.transact([{ space: 'capacityRequests', id, value: row },
      { space: 'deploymentReserved', id: deployment, value: (reserved + BigInt(amount)).toString() },
      ...(plotKey ? [{ space: 'capacityPlots', id: plotKey, value: { id, state: 'reserved' } }] : [])]);
    return row;
  }); }
  finish(id, evidence) { return this.gate(async () => {
    const row = this.store.get('capacityRequests', id); check(row, 'capacity_request');
    const proof = await this.verifyTerminal(row.terms, evidence);
    check(proof?.id === id && proof.deployment === row.terms.deployment && ['minted', 'refunded', 'invalidated'].includes(proof.state) &&
      typeof proof.commitment === 'string' && /^[0-9a-f]{64}$/.test(proof.commitment), 'capacity_terminal');
    if (row.state !== 'reserved') { check(row.proof.commitment === proof.commitment, 'capacity_terminal_conflict'); return row; }
    const reserved = BigInt(this.store.get('deploymentReserved', row.terms.deployment)); check(reserved >= BigInt(row.terms.amount), 'capacity_accounting');
    const plotKey = row.terms.plot === null ? null : row.terms.asset + '/' + row.terms.plot;
    await this.store.transact([{ space: 'capacityRequests', id, value: { ...row, state: proof.state, proof } },
      { space: 'deploymentReserved', id: row.terms.deployment, value: (reserved - BigInt(row.terms.amount)).toString() },
      ...(plotKey ? [{ space: 'capacityPlots', id: plotKey, ...(proof.state === 'minted' ? { value: { id, state: 'minted' } } : {}) }] : [])]);
    return this.store.get('capacityRequests', id);
  }); }
  renew(asset, deployment) { return this.gate(async () => {
    const prior = this.store.get('deploymentRounds', asset);
    if (prior?.previous === deployment) return this.prepareRound(prior);
    const d = await this.readDeployment(deployment);
    check(d.id === deployment && d.asset === asset && d.kind === 'compound' && d.remaining === '0' && d.active, 'round_not_exhausted');
    check((this.store.get('deploymentReserved', deployment) ?? '0') === '0', 'round_unresolved_permits');
    const round = (BigInt(prior?.round ?? d.round ?? '0') + 1n).toString();
    const intent = { asset, round, previous: deployment, id: hash(rules.stableJSON(['dmw-deployment-round-v2', asset, round, deployment])) };
    await this.store.put('deploymentRounds', asset, intent);
    // Returns a player-inscribed deployment package. This class never sends.
    return this.prepareRound(intent);
  }); }
}
