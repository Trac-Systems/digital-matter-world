import { rules } from './rules.mjs';
import { check, serial, heightKey } from './util.mjs';
import { recoveryBatch } from '../../rules/src/recovery-batch.js';
import { buildFinancialExecution } from './financial-execution.mjs';
import { assetCheckpoint } from './asset-provenance.mjs';
import { recoveryEnd } from '../../contract/financial-lifecycle.js';

// One bounded step per tick, with the exact signed draft persisted before
// delivery. Ordinary Pipeline work pauses; acknowledged receipts remain in
// their original queues and the claim checkpoint only advances its ordinal.
export class RecoveryCoordinator {
  constructor({ store, reads, financial, committee, network, files, outbox }) {
    Object.assign(this, { store, reads, financial, committee, network, files, outbox }); this.gate = serial();
  }
  attach(options) { Object.assign(this, options); }
  active() { return this.store.get('meta', 'financialRecoveryActive') ?? (this.starting ? 'starting' : null); }
  begin({ anchor, proof, target }) { return this.gate(async () => {
    if (this.active()) {
      const old = this.store.get('financialRecoveries', this.active());
      check(rules.stableJSON(old.anchor) === rules.stableJSON(anchor) && rules.stableJSON(old.proof) === rules.stableJSON(proof) &&
        (!target || rules.stableJSON(old.target) === rules.stableJSON(target)), 'financial_recovery_busy');
      return { id: old.id, state: old.state };
    }
    check(!this.pipeline?.running && !this.store.get('meta', 'draft'), 'financial_recovery_pending_batch');
    this.starting = true;
    try {
    const at = await this.reads.batchStamp(); target ??= await this.reads.financialCanonicalTip();
    check(await this.reads.financialCanonicalBitcoinHash(at.tip) !== at.tipHash, 'financial_recovery_not_needed');
    check(await this.reads.financialCanonicalBitcoinHash(target.height) === target.hash, 'financial_recovery_target');
    const id = rules.hashObject(['dmw-native-recovery-v2', this.network, at.tipHash, target, anchor]);
    const context = await this.reads.rulesContext(), document = rules.effectiveSettings(context.settings, context.scheduledSettings, rules.nextUint(rules.decimalV2(at.last.n)), rules.decimalV2(at.counted));
    await buildFinancialExecution({ store: this.store, reads: this.reads, document, height: at.counted, at,
      transitions: [{ type: 'beacon-recovery', id, operation: { op: 'br', v: 2, type: 'begin', id, anchor, proof, previous: at.tipHash } }] });
    if (!this.store.get('financialRecoveries', id)) await this.store.transact([
      { space: 'financialRecoveries', id, value: { id, anchor, proof, previous: at.tipHash, target, state: 'active' } },
      { space: 'meta', id: 'financialRecoveryActive', value: id }]);
    return { id, state: this.store.get('financialRecoveries', id).state };
    } finally { this.starting = false; }
  }); }
  async reconcile(draft) {
    if (!draft) return null;
    const batch = draft.proposal.batch, key = `batch/${batch.epoch}/${batch.n}`, at = await this.reads.batchStamp();
    const root = await this.reads.batchRoot(batch.n), authority = await this.reads.authority();
    check(rules.stableJSON(at) === rules.stableJSON(await this.reads.batchStamp()), 'financial_snapshot_changed');
    if (root === batch.root) return draft;
    check(root === null && rules.compareOrdinal(at.last.n, batch.n) < 0, 'financial_recovery_batch_conflict');
    const unreserved = !draft.signature && !this.store.get('ceremonies', key) && !this.store.get('outbox', key) && !this.store.get('sent', key);
    const retirement = !draft.signature && !this.store.get('outbox', key) && !this.store.get('sent', key) ? await this.committee.retireUnprepared?.(key) : null;
    const reason = rules.compareOrdinal(authority.epoch, batch.epoch) > 0 ? 'epoch_superseded' :
      rules.compareOrdinal(at.counted, batch.deadline) > 0 ? 'deadline_expired' : retirement ? 'preparation_unreserved' :
      unreserved && draft.at && rules.stableJSON(draft.at) !== rules.stableJSON(at) ? 'snapshot_changed' : null;
    if (!reason) return draft;
    await this.store.transact([{ space: 'financialRecoveryRetired', id: rules.hashObject(batch), value: {
      draft, proof: { reason, at, epoch: authority.epoch, root, retirement: retirement ?? null },
      ceremony: this.store.get('ceremonies', key), outbox: this.store.get('outbox', key), sent: this.store.get('sent', key) } },
      ...['ceremonies', 'outbox', 'sent'].map(space => ({ space, id: key })), { space: 'meta', id: 'financialRecoveryDraft' }]);
    return null;
  }
  tick() { return this.gate(async () => {
    const id = this.active(); if (!id || this.store.get('meta', 'draft')) return;
    check(this.files && this.outbox, 'financial_recovery_transport');
    let draft = await this.reconcile(this.store.get('meta', 'financialRecoveryDraft'));
    if (!draft) {
      const job = this.store.get('financialRecoveries', id), at = await this.reads.batchStamp(), stage = await this.reads.financialRecord('br/' + id + '/meta', at);
      const context = await this.reads.rulesContext(), document = rules.effectiveSettings(context.settings, context.scheduledSettings, rules.nextUint(rules.decimalV2(at.last.n)), rules.decimalV2(at.counted));
      const row = await this.reads.financialRecord('fr/' + id, at), lifecycle = action => ({ type: 'lifecycle', id, action: { id, ...action } });
      if (row?.state === 'complete' || row?.state === 'aborted') {
        await this.store.transact([{ space: 'financialRecoveries', id, value: { ...job, state: row.state } }, { space: 'meta', id: 'financialRecoveryActive' }]); return;
      }
      let transition;
      const canonical = await this.reads.financialCanonicalBitcoinHash(job.target.height);
      check(rules.hex(canonical, 32), 'financial_recovery_source_unavailable');
      if (stage?.state !== 'adopted' && canonical !== job.target.hash && !['complete', 'aborted'].includes(row?.state)) {
        if (!row) {
          await this.store.transact([{ space: 'financialRecoveries', id, value: { ...job, state: 'aborted' } }, { space: 'meta', id: 'financialRecoveryActive' }]); return;
        }
        transition = lifecycle({ type: 'recovery-abort' });
      }
      else if (!stage) transition = { type: 'beacon-recovery', id, operation: { op: 'br', v: 2, type: 'begin', id, anchor: job.anchor, proof: job.proof, previous: job.previous } };
      else if (!row) {
        const candidate = await this.reads.financialRecoveryStage(id, at);
        if (rules.compareOrdinal(candidate.tip.height, job.target.height) < 0) {
          const headers = await this.reads.financialRecoveryHeaders(candidate.tip.height, job.target, document.values.recoveryHeaders);
          transition = { type: 'beacon-recovery', id, operation: { op: 'br', v: 2, type: 'append', id, sequence: stage.sequence, headers } };
        } else {
          check(candidate.tip.hash === job.target.hash, 'financial_recovery_target');
          transition = lifecycle({ type: 'recovery-inventory', previous: job.previous, tip: job.target.hash });
        }
      } else if (row.state === 'inventory') {
        const limit = document.values.paymentPage, items = await this.reads.financialRecoveryItems({ after: row.cursor, limit }, at);
        transition = items.length ? lifecycle({ type: 'recovery-inventory-page', cursor: row.cursor, limit, items }) : lifecycle({ type: 'recovery-inventory-seal' });
      } else if (row.state === 'reconciling') {
        if (row.next === recoveryEnd) transition = lifecycle({ type: 'recovery-approve', batch: at.last.n });
        else transition = lifecycle({ type: 'recovery-page', sequence: row.sequence, ...await this.reads.financialRecord('fr/' + id + '/page/' + row.next, at) });
      } else if (row.state === 'approved') {
        if (stage.state === 'adopted') transition = lifecycle({ type: 'recovery-finish', anchor: await this.reads.financialRecoveryAnchor(at) });
        else {
          const approval = await this.reads.financialRecord('recoveryApproved/' + id, at);
          transition = rules.compareOrdinal(approval.lastBatch, at.last.n) === 0 ? { type: 'beacon-recovery', id,
            operation: { op: 'br', v: 2, type: 'adopt', id, previous: row.previous, tip: row.tip, reconciliation: row.root } } :
            lifecycle({ type: 'recovery-refresh', batch: at.last.n });
        }
      } else throw Error('financial_recovery_state');
      const result = await buildFinancialExecution({ store: this.store, reads: this.reads, document, height: at.counted, at, transitions: [transition] });
      const state = this.store.get('meta', 'ruleState'), previous = BigInt(at.last.n) > 0n ? await this.reads.batchRoot(at.last.n) : context.manifest.previousBatchRoot;
      const built = recoveryBatch({ network: this.network, epoch: (await this.reads.authority()).epoch, at, previous, context, document,
        snapshot: state.claimSnapshot, inputs: result.inputs, executionHash: await this.reads.financialNotaryHashAt(at.counted, at) });
      const audit = await this.files.immutable(`blocks/v2/${rules.hash(built.bytes)}.bin`, built.bytes);
      draft = { id, at, proposal: { network: this.network, kind: 'batch', recovery: true, batch: built.batch, files: [built.encoded] },
        publications: [{ audit }], writes: result.writes, snapshot: built.snapshot, inputs: result.inputs, document };
      await this.store.put('meta', 'financialRecoveryDraft', draft);
    }
    const { batch } = draft.proposal, key = `batch/${batch.epoch}/${batch.n}`;
    if (await this.reads.batchRoot(batch.n) !== batch.root) {
      if (!draft.signature) {
        const signed = await this.committee.signature(key, draft.proposal); if (!signed) return;
        draft = { ...draft, signature: signed.signature.compact }; await this.store.put('meta', 'financialRecoveryDraft', draft);
      }
      await this.outbox.enqueue(key, 'bt', { ...batch, sig: draft.signature }); await this.outbox.tick();
      if (await this.reads.batchRoot(batch.n) !== batch.root) return;
    }
    const old = this.store.get('meta', 'ruleState'), state = { ...old, ...draft.snapshot.hot, claimSnapshot: draft.snapshot, claimRoot: batch.claims, accountRoot: batch.accounts };
    const changes = [...draft.writes, { space: 'meta', id: 'ruleState', value: state },
      { space: 'assetCheckpoint', id: 'current', value: assetCheckpoint({ namedSnapshot: state.namedSnapshot, claimSnapshot: draft.snapshot }) },
      { space: 'batches', id: heightKey(batch.n), value: { batch: { ...batch, sig: draft.signature }, publications: draft.publications } },
      { space: 'settingsHistory', id: batch.settingsHash, value: draft.document }, { space: 'meta', id: 'financialRecoveryDraft' }];
    for (const [index, input] of draft.inputs.entries()) for (const [record] of input.recordCommitments ?? []) if (input.chainAnchor)
      changes.push({ space: 'financialRecordProvenance', id: record, value: { n: batch.n, file: 0, index } });
    await this.store.transact(changes);
  }); }
}
