import { AccountExecution } from './account-batch.mjs';
import { creditActions } from '../../rules/src/account-batch.js';
import { financialPlan } from '../../rules/src/financial-execution.js';
import { rules } from './rules.mjs';
import { check, serial } from './util.mjs';
import { assetResources } from './asset-resources.mjs';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { financialTerminalOperations, FinancialLinkReconciler } from './financial-lifecycle.mjs';

// Explicit source adapter: it must reconstruct fees, rights, chain settlement,
// permit recovery and exits from independent point reads. There is no fallback
// that treats a gateway-supplied evidence object as a source verification.
export async function buildFinancialExecution({ store, credits = [], crafts = [], transitions, reads, document, height, at, defer = false, priorOperations = [], priorAssetTouches = 0, priorLinkInputs = 0 }) {
  check(typeof reads.financialEvidence === 'function', 'financial_source_adapter_required');
  check(Array.isArray(transitions) && transitions.length <= document.values.mintOperationBudget, 'financial_batch_budget');
  if (reads.financialScope) {
    const snapshot = await reads.batchStamp();
    check(!at || rules.compareOrdinal(at.counted, snapshot.counted) === 0 && rules.stableJSON(at.last) === rules.stableJSON(snapshot.last) &&
      (at.revision === undefined || at.revision === snapshot.revision) && (at.tipHash === undefined || at.tipHash === snapshot.tipHash), 'financial_snapshot_changed');
    at = snapshot;
  }
  const execution = new AccountExecution({ store, document, height, read: typeof reads.financialRecord === 'function' ? key => reads.financialRecord(key, at) : undefined });
  const reservations = new Map(store.financialReservations ?? []);
  const sources = reads.financialScope?.({ record: key => execution.getAsync(key), reservations }) ?? reads;
  const actions = [...creditActions(credits), ...crafts.map(c => c.action)]; if (actions.length) await execution.accounts(actions);
  check(priorAssetTouches + execution.assetTouches <= document.values.batchAssets, 'financial_batch_assets');
  const creditOperations = [...execution.operations], inputs = [], deferred = [];
  let linkInputs = priorLinkInputs;
  for (const transition of transitions) {
    const checkpoint = { records: new Map(execution.changed), nodes: new Map(execution.availability.pending), balances: new Map(execution.balances), count: execution.operations.length, touches: execution.assetTouches };
    try {
    const link = /^(?:legacy-)?link-/.test(transition.action?.type ?? '');
    check(!link || linkInputs < document.values.linkOperationBudget, 'financial_link_budget');
    const evidence = await sources.financialEvidence(transition, at), input = { transition, evidence };
    if (reads.financialChainAnchor && transition.type !== 'beacon-recovery' && !transition.action?.type.startsWith('recovery-')) input.chainAnchor = await reads.financialChainAnchor({ at, prior: await execution.getAsync('fp/chain'), ethereum: evidence.ethereumAnchor });
    const plan = await financialPlan(input, { read: key => execution.getAsync(key), height, document }), operations = [];
    for (const op of plan) operations.push(op.op === 'ar' ? await execution.accounts(op.actions) : op.op === 'br' ?
      await execution.beacon(op, await reads.financialBeaconConfig()) : await execution.payment(op));
    input.recordCommitments = [];
    for (const [key, value] of execution.changed) {
      const old = checkpoint.records.has(key) ? checkpoint.records.get(key) : await execution.base(key);
      if (rules.stableJSON(value ?? null) !== rules.stableJSON(old ?? null)) input.recordCommitments.push([key, rules.hashObject(value ?? null)]);
    }
    input.recordCommitments.sort(([a], [b]) => a < b ? -1 : 1);
    const combined = [...priorOperations, ...execution.operations];
    check(combined.length + 2 <= document.values.batchOps && Buffer.byteLength(rules.stableJSON(combined)) +
      document.values.batchEnvelopeReserveBytes <= document.values.batchBytes, 'financial_batch_bytes');
    check(priorAssetTouches + execution.assetTouches <= document.values.batchAssets, 'financial_batch_assets');
    inputs.push({ ...input, operations });
    if (transition.type === 'reserve' || transition.action?.type === 'link-reserve') reservations.set(transition.id, evidence);
    if (link) linkInputs++;
    } catch (error) {
      if (!defer) throw error;
      execution.changed = checkpoint.records; execution.availability.pending = checkpoint.nodes; execution.balances = checkpoint.balances; execution.operations.length = checkpoint.count; execution.assetTouches = checkpoint.touches;
      deferred.push({ id: rules.hashObject(['dmw-financial-transition-v2', transition]), reason: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_evidence_unavailable' });
    }
  }
  return { ...execution.result(), creditOperations, inputs, deferred };
}

export class FinancialExecution {
  constructor({ store, reads, document, resources }) {
    Object.assign(this, { store, reads, document }); this.resources = assetResources(resources); this.gate = serial();
    this.linkReconciler = new FinancialLinkReconciler({ store, reads, financial: this, resources });
  }
  submit(transition) { return this.gate(async () => {
    check(transition && rules.hex(transition.id, 32), 'financial_identity');
    check(['reserve', 'fund', 'surplus', 'consume', 'refund', 'lifecycle', 'beacon-recovery'].includes(transition.type) &&
      Buffer.byteLength(rules.stableJSON(transition)) <= this.document.values.moveBytes, 'financial_transition');
    const key = rules.hashObject(['dmw-financial-transition-v2', transition]);
    const accepted = this.store.get('financialAccepted', key); if (accepted) return accepted;
    const old = this.store.get('financialQueue', key); if (old) return { id: key, state: 'queued' };
    check(!this.admissionReady || await this.admissionReady(), 'financial_admission_fenced', 503);
    check(this.store.count('financialQueue') < this.resources.mintInputCapacity, 'financial_queue_capacity', 503);
    // Submission is a durable intent, not a claim of payment or acceptance.
    await this.store.put('financialQueue', key, transition); return { id: key, state: 'queued' };
  }); }
  admit(transition, at) { return this.gate(async () => {
    const id = rules.hashObject(['dmw-financial-transition-v2', transition]);
    const old = this.store.get('financialAccepted', id) ?? (this.store.get('financialQueue', id) ? { id, state: 'queued' } : null);
    if (old) return old;
    check(!this.admissionReady || await this.admissionReady(), 'financial_admission_fenced', 503);
    check(transition.type === 'reserve' && this.store.count('financialQueue') < this.resources.mintInputCapacity, 'financial_queue_capacity', 503);
    check(Buffer.byteLength(rules.stableJSON(transition)) <= this.document.values.moveBytes, 'financial_transition');
    const result = await buildFinancialExecution({ store: this.store, transitions: [transition], reads: this.reads, document: this.document, height: at.counted, at });
    const owner = transition.action.owner, capacity = result.inputs[0].evidence.capacity;
    check(!this.store.get('financialAdmissionOwner', owner), 'financial_account_reserved', 409);
    const writes = [{ space: 'financialAdmissionOwner', id: owner, value: id }];
    if (capacity) {
      const key = capacityKey(capacity.deployment), pending = BigInt(this.store.get('financialAdmissionCapacity', key) ?? '0');
      const accepted = BigInt(this.store.get('accountRecords', key) ?? '0') + BigInt(await this.reads.financialRecord('fi/deployment/' + capacity.deployment, at) ?? '0');
      check(pending + accepted + BigInt(capacity.amount) <= BigInt(capacity.remaining), 'financial_capacity_reserved', 409);
      const plot = capacity.block === null ? null : plotKey(capacity.asset, capacity.block);
      check(!plot || !this.store.get('financialAdmissionPlot', plot), 'financial_plot_reserved', 409);
      writes.push({ space: 'financialAdmissionCapacity', id: key, value: (pending + BigInt(capacity.amount)).toString() },
        ...(plot ? [{ space: 'financialAdmissionPlot', id: plot, value: id }] : []));
    }
    await this.store.transact([...writes, { space: 'financialAdmission', id, value: { owner, capacity: capacity ?? null } }, { space: 'financialQueue', id, value: transition }]);
    return { id, state: 'queued' };
  }); }
  admitLink(transition, at) { return this.gate(async () => {
    const id = rules.hashObject(['dmw-financial-transition-v2', transition]);
    if (this.store.get('financialAccepted', id) || this.store.get('financialQueue', id)) return { id, state: 'queued' };
    check(!this.admissionReady || await this.admissionReady(), 'financial_admission_fenced', 503);
    check(transition.type === 'lifecycle' && transition.action.type === 'link-reserve' && this.store.count('financialQueue') < this.resources.mintInputCapacity, 'financial_queue_capacity');
    await buildFinancialExecution({ store: this.store, transitions: [transition], reads: this.reads, document: this.document, height: at.counted, at });
    const block = transition.action.block;
    check(!this.store.get('financialAdmissionLink', block), 'financial_link_reserved', 409);
    await this.store.transact([{ space: 'financialAdmissionLink', id: block, value: id },
      { space: 'financialAdmission', id, value: { link: block } }, { space: 'financialQueue', id, value: transition }]);
    return { id, state: 'queued' };
  }); }
  pending() { return this.store.count('financialQueue') > 0; }
  expire(id, at) { return this.gate(async () => {
    const transition = this.store.get('financialQueue', id);
    if (!transition) return !this.store.get('financialAccepted', id);
    if (transition.type === 'refund') return false;
    if (transition.type === 'reserve' || transition.action?.type === 'link-reserve') { if (rules.compareOrdinal(at.counted, transition.action.until) <= 0) return false; }
    else {
      const exit = await this.reads.financialEvidence({ type: 'refund', id: transition.id, reason: 'credit' }, at);
      check(exit.state === 'credit' && rules.compareOrdinal(at.counted, exit.expiry) > 0, 'financial_exit_live');
    }
    // Preserve anything already signed or sent. Pipeline resolves that exact
    // draft before local admission counters can be released.
    const draft = this.store.get('meta', 'draft');
    if (draft?.proposal?.batch?.ops?.some(o => o.id === transition.id || o.op === 'ar' && o.actions.some(a => a.id === transition.id))) return false;
    await this.store.transact([...this.releaseAdmission(id), { space: 'financialQueue', id }, { space: 'financialDeferred', id },
      { space: 'financialRejected', id, value: { reason: 'reservation_expired', height: at.counted } }]); return true;
  }); }
  releaseAdmission(id, capacities = new Map()) {
    const admission = this.store.get('financialAdmission', id), release = [];
    if (!admission) return release;
    if (admission.link !== undefined) return [{ space: 'financialAdmission', id }, { space: 'financialAdmissionLink', id: admission.link }];
    release.push({ space: 'financialAdmission', id }, { space: 'financialAdmissionOwner', id: admission.owner });
    if (admission.capacity) {
      const c = admission.capacity, key = capacityKey(c.deployment), n = (capacities.get(key) ?? BigInt(this.store.get('financialAdmissionCapacity', key))) - BigInt(c.amount);
      check(n >= 0n, 'financial_admission_accounting'); capacities.set(key, n);
      release.push({ space: 'financialAdmissionCapacity', id: key, value: n.toString() }, ...(c.block === null ? [] : [{ space: 'financialAdmissionPlot', id: plotKey(c.asset, c.block) }]));
    }
    return release;
  }
  transitions() {
    const after = this.store.get('meta', 'financialCursor') ?? '', limit = Math.min(this.resources.workPage, this.document.values.mintOperationBudget);
    let rows = this.store.list('financialQueue', { after, limit });
    if (!rows.length && after) rows = this.store.list('financialQueue', { limit });
    return rows;
  }
  async build(args) {
    await this.linkReconciler.tick(args.height, args.at);
    const rows = (this.prepared ?? this.transitions()).filter(r => !args.excluded?.has(r.id)).slice(0, args.remaining ?? this.document.values.mintOperationBudget); this.prepared = null;
    const result = await buildFinancialExecution({ ...args, store: args.accountStore ?? this.store, reads: this.reads, document: this.document,
      transitions: rows.map(r => r.value), defer: true });
    // Advancing this local work cursor changes no financial state. Deferred
    // funded work stays durable and cannot starve unrelated requests.
    await this.store.transact([{ space: 'meta', id: 'financialCursor', value: rows.at(-1)?.id ?? '' },
      ...result.deferred.map(row => ({ space: 'financialDeferred', id: row.id, value: { ...row, height: args.height } }))]);
    return result;
  }
  async ready(args) {
    await this.linkReconciler.tick(args.height, args.at);
    if (!this.pending()) return false;
    const result = await this.build(args);
    this.prepared = result.inputs.length ? result.inputs.map(i => ({ id: rules.hashObject(['dmw-financial-transition-v2', i.transition]), value: i.transition })) : null;
    return !!this.prepared;
  }
  acceptedOperations(draft) {
    const capacities = new Map();
    const projected = new Map(), view = { get: (space, id) => projected.has(space + '/' + id) ? projected.get(space + '/' + id) : this.store.get(space, id) };
    return draft.items.flatMap(item => (item.output.file.financialOperations ?? []).flatMap(input => {
      const id = rules.hashObject(['dmw-financial-transition-v2', input.transition]);
      const local = [...this.releaseAdmission(id, capacities), ...financialTerminalOperations(view, input, draft.proposal.batch.n)];
      for (const write of local) projected.set(write.space + '/' + write.id, write.value);
      return [{ space: 'financialQueue', id }, { space: 'financialDeferred', id }, { space: 'financialAccepted', id, value: { id, state: 'accepted', batch: draft.proposal.batch.n,
        request: input.transition.id, type: input.transition.type, evidence: rules.hashObject(input.evidence) } },
        ...local];
    }));
  }
}
