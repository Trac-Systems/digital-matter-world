import { accountKey } from '../../contract/account-tree.js';
import { AccountExecution } from './account-batch.mjs';
import { creditActions } from '../../rules/src/account-batch.js';
import { executeNonceReservations, financialTransitionPlan } from './nonce-reservations.mjs';
import { nonceReservation as singleNonceReservation } from '../../rules/src/financial-execution.js';
import { isBulkTransition, bulkAdmissionWrites } from './bulk-mint-admission.mjs';
import { bulkAcceptedWrites } from './bulk-mints.mjs';
import { rules } from './rules.mjs';
import { check, serial } from './util.mjs';
import { assetResources } from './asset-resources.mjs';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { financialTerminalOperations, FinancialLinkReconciler } from './financial-lifecycle.mjs';
import { publicMintAcceptedWrites } from './public-mints.mjs';
import { readPublicWinner, publicClaimReaders } from './public-claim-readers.mjs';
const nonceReservation = t => t?.type === 'reserve-many' && t.action?.type === 'reserve-n' || singleNonceReservation(t);
async function bulkWork(execution, operations) {
  if (!operations.some(op => op.op === 'fp' && op.type.startsWith('bulk-'))) return;
  const { BULK_LIMITS } = await import('../../rules/src/bulk-mint.js');
  let members = 0, groups = 0;
  for (const op of operations) {
    if (op.op !== 'fp' || !op.type.startsWith('bulk-')) continue;
    const t = op.type === 'bulk-open' ? op.terms : (await execution.getAsync('fp/' + op.id))?.manifest;
    check(t, 'bulk_work_terms');
    members += ['bulk-open', 'bulk-consume'].includes(op.type) ? t.members.length : ['bulk-finish', 'bulk-release'].includes(op.type) ? op.members.length : 0;
    groups += ['bulk-open', 'bulk-fund', 'bulk-consume', 'bulk-credit'].includes(op.type) ? t.groups.length : 0;
  }
  check(members <= BULK_LIMITS.memberWork && groups <= BULK_LIMITS.groupWork, 'bulk_batch_work');
}

// Explicit source adapter: it must reconstruct fees, rights, chain settlement,
// permit recovery and exits from independent point reads. There is no fallback
// that treats a gateway-supplied evidence object as a source verification.
export async function buildFinancialExecution({ store, credits = [], crafts = [], transfers = [], compoundMerge = null, transitions, reads, document, height, at, defer = false, priorOperations = [], priorAssetTouches = 0, priorLinkInputs = 0, publicClaims, preparePublicMint }) {
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
  const actions = [...rules.compoundMergeAction(compoundMerge), ...creditActions(credits), ...crafts.map(c => c.action), ...transfers.map(t => t.action)]; if (actions.length) await execution.accounts(actions);
  check(priorAssetTouches + execution.assetTouches <= document.values.batchAssets, 'financial_batch_assets');
  const creditOperations = [...execution.operations], inputs = [], deferred = [];
  let linkInputs = priorLinkInputs;
  const handled = new Set();
  for (const transition of transitions) {
    if (handled.has(transition)) continue;
    if (nonceReservation(transition)) {
      const snapshot = () => ({ records: new Map(execution.changed), nodes: new Map(execution.availability.pending),
        balances: new Map(execution.balances), operations: [...execution.operations], touches: execution.assetTouches });
      const checkpoint = snapshot();
      const restore = state => {
        execution.changed = new Map(state.records); execution.availability.pending = new Map(state.nodes);
        execution.balances = new Map(state.balances); execution.operations = [...state.operations]; execution.assetTouches = state.touches;
      };
      const owner = transition.action.owner, selected = [];
      let packed = [], accepted = checkpoint;
      for (const candidate of transitions.filter(t => !handled.has(t) && nonceReservation(t) && t.action.owner === owner)) {
        handled.add(candidate); restore(checkpoint);
        try {
          // A later observation cannot add another packet for this owner's
          // new reserves in the same batch. Its queue entries remain valid.
          check(!priorOperations.some(op => op.op === 'ar' && op.actions.some(a => a.type === 'reserve-n' && a.owner === owner)), 'financial_account_batch_full');
          const proposed = await executeNonceReservations({ execution, transitions: [...selected, candidate], sources, reads, document, height, at });
          const combined = [...priorOperations, ...execution.operations];
          await bulkWork(execution, combined);
          check(combined.length + 2 <= document.values.batchOps && Buffer.byteLength(rules.stableJSON(combined)) +
            document.values.batchEnvelopeReserveBytes <= document.values.batchBytes, 'financial_batch_bytes');
          check(priorAssetTouches + execution.assetTouches <= document.values.batchAssets, 'financial_batch_assets');
          selected.push(candidate); packed = proposed; accepted = snapshot();
        } catch (error) {
          if (!defer) throw error;
          deferred.push({ id: rules.hashObject(['dmw-financial-transition-v2', candidate]), reason: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_evidence_unavailable' });
          // Keep the last fully verified group without querying its sources
          // again while rolling back a later failed candidate.
          restore(accepted);
        }
      }
      inputs.push(...packed);
      for (const input of packed) reservations.set(input.transition.id, input.evidence);
      continue;
    }
    const checkpoint = { records: new Map(execution.changed), nodes: new Map(execution.availability.pending), balances: new Map(execution.balances), count: execution.operations.length, touches: execution.assetTouches };
    try {
    const link = /^(?:legacy-)?link-/.test(transition.action?.type ?? '');
    check(!link || linkInputs < document.values.linkOperationBudget, 'financial_link_budget');
    let evidence = await sources.financialEvidence(transition, rules.legacyDeployShareActive(height) || rules.multiTickerActive(height) || rules.freeLinkActive(height) ? { ...at, executionHeight: height } : at);
    if (transition.type === 'public-scan' && rules.claimsNeverCloseActive(document, height)) {
      check(publicClaims && preparePublicMint, 'public_claim_projection_required');
      const { pattern, asset } = rules.publicPatternForAsset(publicClaims.patterns, transition.asset);
      check(asset === transition.asset, 'public_claim_asset');
      await preparePublicMint(asset, transition.block, transition.deployment);
      evidence = { ...evidence, claim: rules.publicScanClaim({ ...publicClaims, pattern, asset, block: transition.block, deployment: transition.deployment }) };
    }
    const input = { transition, evidence };
    if (reads.financialChainAnchor && transition.type !== 'beacon-recovery' && !transition.action?.type?.startsWith('recovery-')) input.chainAnchor = await reads.financialChainAnchor({ at, prior: await execution.getAsync('fp/chain'), ethereum: evidence.ethereumAnchor });
    const plan = await financialTransitionPlan(input, { read: key => execution.getAsync(key), height, document }), operations = [];
    for (const op of plan) operations.push(op.op === 'ar' ? await execution.accounts(op.actions) : op.op === 'br' ?
      await execution.beacon(op, await reads.financialBeaconConfig()) : await execution.payment(op));
    input.recordCommitments = [];
    for (const [key, value] of execution.changed) {
      const old = checkpoint.records.has(key) ? checkpoint.records.get(key) : await execution.base(key);
      if (rules.stableJSON(value ?? null) !== rules.stableJSON(old ?? null)) input.recordCommitments.push([key, rules.hashObject(value ?? null)]);
    }
    input.recordCommitments.sort(([a], [b]) => a < b ? -1 : 1);
    const combined = [...priorOperations, ...execution.operations];
    await bulkWork(execution, combined);
    check(combined.length + 2 <= document.values.batchOps && Buffer.byteLength(rules.stableJSON(combined)) +
      document.values.batchEnvelopeReserveBytes <= document.values.batchBytes, 'financial_batch_bytes');
    check(priorAssetTouches + execution.assetTouches <= document.values.batchAssets, 'financial_batch_assets');
    if (publicClaims) for (const operation of operations) if (operation.op === 'fp' && operation.type === 'public-scan')
      rules.applyPublicClaimScan({ ...publicClaims, operation });
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
    Object.assign(this, { store, reads, document }); this.resources = assetResources(resources);
    const commit = serial(); this.revision = 0; this.acceptedRevision = 0;
    this.gate = (task, { pending = false } = {}) => commit(async () => { const result = await task(); this.revision++; if (!pending) this.acceptedRevision++; return result; });
    this.linkReconciler = new FinancialLinkReconciler({ store, reads, financial: this, resources });
  }
  existing(id) { return this.store.get('financialAccepted', id) ?? (this.store.get('financialQueue', id) ? { id, state: 'queued' } : null); }
  async submit(transition) {
    check(transition && rules.hex(transition.id, 32), 'financial_identity');
    const limit = isBulkTransition(transition) ? (await import('../../rules/src/bulk-mint.js')).BULK_LIMITS.transitionBytes : this.document.values.moveBytes;
    check((isBulkTransition(transition) || ['reserve', 'fund', 'surplus', 'consume', 'refund', 'lifecycle', 'beacon-recovery', 'public-scan', 'public-payment'].includes(transition.type)) &&
      Buffer.byteLength(rules.stableJSON(transition)) <= limit, 'financial_transition');
    const key = rules.hashObject(['dmw-financial-transition-v2', transition]);
    const old = this.existing(key); if (old) return old;
    const document = this.document;
    check(!this.admissionReady || await this.admissionReady(), 'financial_admission_fenced', 503);
    return this.gate(async () => {
    const existing = this.existing(key); if (existing) return existing;
    check(document === this.document, 'financial_snapshot_changed', 503);
    check(this.store.count('financialQueue') < this.resources.mintInputCapacity, 'financial_queue_capacity', 503);
    // Submission is a durable intent, not a claim of payment or acceptance.
    await this.store.put('financialQueue', key, transition); return { id: key, state: 'queued' };
  }, { pending: true }); }
  async admit(transition, at) {
    const id = rules.hashObject(['dmw-financial-transition-v2', transition]);
    const old = this.existing(id);
    if (old) return old;
    check(!this.admissionReady || await this.admissionReady(), 'financial_admission_fenced', 503);
    const bulk = transition.type === 'reserve-many';
    check((transition.type === 'reserve' || bulk) && this.store.count('financialQueue') < this.resources.mintInputCapacity, 'financial_queue_capacity', 503);
    check(Buffer.byteLength(rules.stableJSON(transition)) <= (bulk ? (await import('../../rules/src/bulk-mint.js')).BULK_LIMITS.transitionBytes : this.document.values.moveBytes), 'financial_transition');
    const revision = this.revision, acceptedRevision = this.acceptedRevision, document = this.document, parallel = nonceReservation(transition);
    const result = await buildFinancialExecution({ store: this.store, transitions: [transition], reads: this.reads, document, height: at.counted, at });
    const owner = transition.action.owner; let capacity = result.inputs[0].evidence.capacity;
    const imported = capacity ? BigInt(await this.reads.financialRecord('fi/deployment/' + capacity.deployment, at) ?? '0') : 0n;
    // Close source verification before entering the local commit gate. Bulk
    // gateway stamps include authority/policy as well as the accepted batch and TAP.
    if (bulk) check(rules.stableJSON(at) === rules.stableJSON(await this.reads.batchStamp()), 'financial_snapshot_changed', 503);
    return this.gate(async () => {
    const existing = this.existing(id); if (existing) return existing;
    // The pipeline commits accepted roots under this same short gate. Source
    // verification can overlap other work, but cannot commit across a change.
    check((parallel ? acceptedRevision === this.acceptedRevision : revision === this.revision) && document === this.document, 'financial_snapshot_changed', 503);
    check(this.store.count('financialQueue') < this.resources.mintInputCapacity, 'financial_queue_capacity', 503);
    check(!this.store.get('financialAdmissionOwner', owner), 'financial_account_reserved', 409);
    const count = this.store.get('financialAdmissionCount', owner) ?? 0, writes = [];
    let hold;
    if (parallel) {
      check(count < this.resources.pendingMintsPerAgent, 'financial_owner_fair_share', 409);
      const a = transition.action, key = owner + '/' + a.asset, nonce = owner + '/' + a.nonce;
      check(!this.store.get('financialAdmissionNonce', nonce), 'financial_nonce_reserved', 409);
      const pending = BigInt(this.store.get('financialAdmissionHeld', key) ?? '0');
      // This leaf was authenticated by buildFinancialExecution against the
      // accepted account root. The acceptedRevision fence protects that root;
      // pending counters are read afresh inside the short commit gate.
      const packet = result.operations.find(op => op.op === 'ar').accounts.find(p => p.owner === owner);
      const available = packet.proof.leaves?.find(l => l.key === accountKey('balance', a.asset))?.value?.available ?? '0';
      check(pending + BigInt(a.amount) <= BigInt(available), 'financial_balance_reserved', 409);
      hold = { asset: a.asset, amount: a.amount, nonce: a.nonce };
      writes.push({ space: 'financialAdmissionCount', id: owner, value: count + 1 },
        { space: 'financialAdmissionHeld', id: key, value: (pending + BigInt(a.amount)).toString() },
        { space: 'financialAdmissionNonce', id: nonce, value: id });
    } else {
      check(count === 0, 'financial_account_reserved', 409);
      writes.push({ space: 'financialAdmissionOwner', id: owner, value: id });
    }
    if (bulk) {
      const held = bulkAdmissionWrites(this.store, transition, capacity, imported, this.resources, id, result.inputs[0].evidence.generationCapacity);
      capacity = held.capacity; writes.push(...held.writes);
    } else if (capacity) {
      const key = capacityKey(capacity.deployment), pending = BigInt(this.store.get('financialAdmissionCapacity', key) ?? '0');
      const accepted = BigInt(this.store.get('accountRecords', key) ?? '0') + imported;
      check(pending + accepted + BigInt(capacity.amount) <= BigInt(capacity.remaining), 'financial_capacity_reserved', 409);
      const plot = capacity.block === null ? null : plotKey(capacity.asset, capacity.block, capacity.supplyScope);
      check(!plot || !this.store.get('financialAdmissionPlot', plot), 'financial_plot_reserved', 409);
      writes.push({ space: 'financialAdmissionCapacity', id: key, value: (pending + BigInt(capacity.amount)).toString() },
        ...(plot ? [{ space: 'financialAdmissionPlot', id: plot, value: id }] : []));
    }
    await this.store.transact([...writes, { space: 'financialAdmission', id, value: { owner, capacity: capacity ?? null, ...(hold ? { hold } : {}) } }, { space: 'financialQueue', id, value: transition }]);
    return { id, state: 'queued' };
  }, { pending: true }); }
  async admitLink(transition, at) {
    const id = rules.hashObject(['dmw-financial-transition-v2', transition]);
    if (this.store.get('financialAccepted', id) || this.store.get('financialQueue', id)) return { id, state: 'queued' };
    check(!this.admissionReady || await this.admissionReady(), 'financial_admission_fenced', 503);
    check(transition.type === 'lifecycle' && transition.action.type === 'link-reserve' && this.store.count('financialQueue') < this.resources.mintInputCapacity, 'financial_queue_capacity');
    const revision = this.revision, document = this.document;
    await buildFinancialExecution({ store: this.store, transitions: [transition], reads: this.reads, document, height: at.counted, at });
    return this.gate(async () => {
    if (this.existing(id)) return { id, state: 'queued' };
    check(revision === this.revision && document === this.document, 'financial_snapshot_changed', 503);
    check(this.store.count('financialQueue') < this.resources.mintInputCapacity, 'financial_queue_capacity', 503);
    const block = transition.action.block;
    check(!this.store.get('financialAdmissionLink', block), 'financial_link_reserved', 409);
    await this.store.transact([{ space: 'financialAdmissionLink', id: block, value: id },
      { space: 'financialAdmission', id, value: { link: block } }, { space: 'financialQueue', id, value: transition }]);
    return { id, state: 'queued' };
  }, { pending: true }); }
  pending() { return this.store.count('financialQueue') > 0; }
  async expire(id, at) {
    const transition = this.store.get('financialQueue', id);
    if (!transition) return !this.store.get('financialAccepted', id);
    if (transition.type === 'refund' || transition.type.startsWith('bulk-') && !['bulk-fund', 'bulk-consume'].includes(transition.type)) return false;
    const revision = this.revision;
    if (['bulk-fund', 'bulk-consume'].includes(transition.type)) {
      const funding = await this.reads.financialRecord('fp/' + transition.id, at);
      if (!funding?.manifest || BigInt(at.counted) <= BigInt(funding.manifest.expires) || BigInt(funding.issuedMask) !== 0n) return false;
    } else if (transition.type === 'public-payment') {
      // Reveals account for actual payments and must remain recoverable.
      if (transition.action !== 'register' || rules.compareOrdinal(at.counted, transition.registration.validUntil) <= 0) return false;
    } else if (transition.type === 'reserve' || transition.type === 'reserve-many' || transition.action?.type === 'link-reserve') { if (rules.compareOrdinal(at.counted, transition.action.until) <= 0) return false; }
    else {
      const exit = await this.reads.financialEvidence({ type: 'refund', id: transition.id, reason: 'credit' }, at);
      check(exit.state === 'credit' && rules.compareOrdinal(at.counted, exit.expiry) > 0, 'financial_exit_live');
    }
    return this.gate(async () => {
    if (!this.store.get('financialQueue', id)) return !this.store.get('financialAccepted', id);
    check(revision === this.revision, 'financial_snapshot_changed', 503);
    // Preserve anything already signed or sent. Pipeline resolves that exact
    // draft before local admission counters can be released.
    const draft = this.store.get('meta', 'draft');
    if (draft?.proposal?.batch?.ops?.some(o => o.id === transition.id || o.op === 'ar' && o.actions.some(a => a.id === transition.id))) return false;
    await this.store.transact([...this.releaseAdmission(id), { space: 'financialQueue', id }, { space: 'financialDeferred', id },
      { space: 'financialRejected', id, value: { reason: 'reservation_expired', height: at.counted } }]); return true;
  }, { pending: true }); }
  releaseAdmission(id, capacities = new Map(), owners = new Map(), balances = new Map()) {
    const admission = this.store.get('financialAdmission', id), release = [];
    if (!admission) return release;
    if (admission.link !== undefined) return [{ space: 'financialAdmission', id }, { space: 'financialAdmissionLink', id: admission.link }];
    release.push({ space: 'financialAdmission', id });
    if (admission.hold) {
      const { owner, hold } = admission, key = owner + '/' + hold.asset;
      const count = (owners.get(owner) ?? this.store.get('financialAdmissionCount', owner) ?? 0) - 1;
      const amount = (balances.get(key) ?? BigInt(this.store.get('financialAdmissionHeld', key) ?? '0')) - BigInt(hold.amount);
      check(count >= 0 && amount >= 0n, 'financial_admission_accounting');
      owners.set(owner, count); balances.set(key, amount);
      release.push({ space: 'financialAdmissionCount', id: owner, ...(count ? { value: count } : {}) },
        { space: 'financialAdmissionHeld', id: key, value: amount.toString() },
        { space: 'financialAdmissionNonce', id: owner + '/' + hold.nonce });
    } else release.push({ space: 'financialAdmissionOwner', id: admission.owner });
    if (admission.capacity) {
      const c = admission.capacity, key = capacityKey(c.deployment), n = (capacities.get(key) ?? BigInt(this.store.get('financialAdmissionCapacity', key))) - BigInt(c.amount);
      check(n >= 0n, 'financial_admission_accounting'); capacities.set(key, n);
      release.push({ space: 'financialAdmissionCapacity', id: key, value: n.toString() }, ...(c.block === null ? [] : [{ space: 'financialAdmissionPlot', id: plotKey(c.asset, c.block, c.supplyScope) }]));
      if (c.plots) release.push(...c.plots.map(plot => ({ space: 'financialAdmissionPlot', id: plot })));
    }
    return release;
  }
  transitions() {
    const after = this.store.get('meta', 'financialCursor') ?? '', limit = Math.min(this.resources.workPage, this.document.values.mintOperationBudget);
    let rows = this.store.list('financialQueue', { after, limit });
    if (!rows.length && after) rows = this.store.list('financialQueue', { limit });
    else if (after && rows.length < limit && rows.some(row => nonceReservation(row.value))) {
      // Complete the bounded circular page so a cursor left by earlier work
      // does not split one owner's ready reserves across otherwise empty batches.
      rows.push(...this.store.list('financialQueue', { limit: limit - rows.length }).filter(row => row.id <= after));
    }
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
    if (rules.claimsNeverCloseActive(this.document, args.height) && this.transitions().some(row => row.value.type === 'public-scan')) {
      // Readiness uses accepted claims; the actual observation rebuilds this
      // projection after its agent moves. Do not seal empty batches forever
      // merely because a delayed scan remains queued without source evidence.
      const store = args.accountStore ?? this.store;
      const input = { settings: { document: this.document }, executionHeight: args.height };
      const publicReads = (await import('../../committee/signer/bulk-mint.mjs')).bulkPublicReads(this.reads, store);
      const publicReaders = publicClaimReaders({ input, store, claimNodes: new Map(),
        publicMintRead: (asset, block, deployment) => readPublicWinner({ store, reads: publicReads, at: args.at }, asset, block, deployment) });
      args = { ...args, preparePublicMint: publicReaders.prepare,
        publicClaims: rules.publicClaimProjection({ state: store.get('meta', 'ruleState') }, input, publicReaders.readers) };
    }
    const result = await this.build(args);
    this.prepared = result.inputs.length ? result.inputs.map(i => ({ id: rules.hashObject(['dmw-financial-transition-v2', i.transition]), value: i.transition })) : null;
    return !!this.prepared;
  }
  acceptedOperations(draft) {
    const capacities = new Map(), owners = new Map(), balances = new Map();
    const projected = new Map(), view = { get: (space, id) => projected.has(space + '/' + id) ? projected.get(space + '/' + id) : this.store.get(space, id) };
    return draft.items.flatMap(item => {
      const records = new Map((item.output.accountWrites ?? []).filter(w => w.space === 'accountRecords').map(w => [w.id, w.value]));
      const accepted = { get: (space, id) => space === 'accountRecords' && records.has(id) ? records.get(id) : view.get(space, id) };
      const localWrites = (item.output.file.financialOperations ?? []).flatMap(input => {
        const id = rules.hashObject(['dmw-financial-transition-v2', input.transition]);
        const local = [...this.releaseAdmission(id, capacities, owners, balances), ...financialTerminalOperations(view, input, draft.proposal.batch.n), ...publicMintAcceptedWrites(view, input, accepted), ...bulkAcceptedWrites(view, input, accepted)];
        for (const write of local) projected.set(write.space + '/' + write.id, write.value);
        return [{ space: 'financialQueue', id }, { space: 'financialDeferred', id }, { space: 'financialAccepted', id, value: { id, state: 'accepted', batch: draft.proposal.batch.n,
          request: input.transition.id, type: input.transition.type, evidence: rules.hashObject(input.evidence) } },
          ...local];
      });
      for (const [id, value] of records) projected.set('accountRecords/' + id, value);
      return localWrites;
    });
  }
}
