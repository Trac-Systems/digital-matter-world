import { payoutGate } from './payout-index.mjs';
import { assetCheckpoint } from './asset-provenance.mjs';
import { storedRenewalSlice } from './receipt-cutoff-pages.mjs';
import { successorStore, successorMismatch } from './pipeline-overlap.mjs';
import { pruneDrafts, acceptedRetention } from './retention.mjs';
import { rules, initialState, buildBatch } from './rules.mjs';
import { Payouts } from './payouts.mjs';
import { Replay } from './replay.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { check, heightKey, hash, atomicWrite } from './util.mjs';
import { hotState, archiveState, hydrateState } from './replay-state.mjs';
import { namedBatchEvidence } from './named-batch.mjs';
import { buildCreditAccounts, AccountBatchOverlay } from './account-batch.mjs';
import { publicFinancialOperations } from './public-financial.mjs';
import { publishReceiptRenewal } from './receipt-renewal.mjs';
import { readPublicWinner, prefetchingWinnerBatch, publicClaimReaders } from './public-claim-readers.mjs';
import { timingLog } from './read-timing.mjs';
export class Pipeline {
  constructor({ store, files, history, intake, committee, outbox, reads, operations, links, financial, patterns = [], settings = {}, limits = {}, replay = new Replay(), archiveWritePage = 256, pipelineDepth = 1 }) {
    Object.assign(this, { store, files, history, intake, committee, outbox, reads, operations, links, financial, patterns, settings, limits, replay, archiveWritePage });
    check([1, 2].includes(pipelineDepth), 'pipeline_depth'); this.pipelineDepth = pipelineDepth;
    this.overlap = { started: 0, promoted: 0, discarded: 0, failed: 0, buildMs: 0, overlapMs: 0 };
    this.replay.resources ??= intake?.namedAdmission?.resources;
  }
  // Each step's wall time is added up per tick and written to the timing log, so a slow batch shows
  // which step it waited on. Speculative successor builds are not counted here.
  get step() { return this.currentStep; }
  set step(value) {
    const prior = this.currentStep, now = Date.now();
    if (prior && !this.speculative) (this.stepTimes ??= {})[prior[0]] = (this.stepTimes[prior[0]] ?? 0) + now - prior[1];
    this.currentStep = value;
  }
  logSteps() {
    if (this.speculative) return;
    this.step = ['idle', Date.now()];
    const steps = this.stepTimes ?? {}; this.stepTimes = {};
    const ms = Object.entries(steps).reduce((n, [name, value]) => name === 'idle' ? n : n + value, 0);
    delete steps.idle;
    if (ms >= 1000) timingLog({ event: 'batch_steps', ms, steps });
  }
  async saveDraft(draft, { admissionSequence } = {}) {
    const text = JSON.stringify(draft), digest = hash(text), directory = join(this.store.directory, 'drafts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(join(directory, digest + '.json'), text);
    const save = () => {
      if (admissionSequence !== undefined && (this.store.get('meta', 'namedReceiptSequence') ?? '0') !== admissionSequence) return false;
      if (admissionSequence !== undefined) {
        const batch = String(draft.proposal.batch.n), reserved = this.store.get('namedDrafts', batch);
        const included = draft.items.reduce((count, item) => count + item.input.entries.filter(e => e.receipt.batch === batch).length, 0);
        if (reserved && included !== reserved.work.entries) return false;
      }
      check(!draft.settings?.document || !this.store.get('namedFences', draft.settings.settingsHash) || draft.proposal.batch.renewal,
        'receipt_admission_fenced', 503);
      return this.store.put('meta', 'draft', { version: 3, external: digest, proposal: { batch: draft.proposal.batch },
        ...(draft.items ? { observations: draft.items.map(i => i.observation.id) } : {}) });
    };
    const result = this.intake?.namedAdmission ? await this.intake.namedAdmission.exclusive(save) : await save();
    await pruneDrafts(this.store); return result;
  }
  async loadDraft() {
    const saved = this.store.get('meta', 'draft'); if (!saved) return null;
    check(/^[0-9a-f]{64}$/.test(saved.external), 'draft_reference');
    const text = await readFile(join(this.store.directory, 'drafts', saved.external + '.json'), 'utf8');
    check(hash(text) === saved.external, 'draft_checksum'); return JSON.parse(text);
  }
  async archiveDraft(draft, proof) {
    const batch = draft.proposal.batch, key = `batch/${batch.epoch}/${batch.n}`, id = hash(rules.stableJSON(batch));
    const ceremony = this.store.get('ceremonies', key);
    const evidence = JSON.stringify({ draft, ceremony, outbox: this.store.get('outbox', key), sent: this.store.get('sent', key) });
    const directory = join(this.store.directory, 'retired-drafts'); await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(join(directory, id + '.json'), evidence);
    await this.store.transact([
      { space: 'supersededDrafts', id, value: { state: 'RETIRED', proof, batch, evidence: { id, hash: hash(evidence) } } },
      ...(ceremony?.id ? [{ space: 'batchCeremonyAttempts', id: key + '/' + ceremony.id, value: ceremony }] : []),
      ...['ceremonies', 'outbox', 'sent'].map(space => ({ space, id: key })), { space: 'meta', id: 'draft' }
    ]);
  }
  async retiredBatchDrafts(batch, { counted } = {}) {
    const candidates = []; let after = '';
    for (;;) {
      const page = this.store.list('supersededDrafts', { after, limit: this.archiveWritePage });
      for (const { value: row } of page) {
        if (String(row.batch?.n) !== String(batch.n) || String(row.batch?.epoch) !== String(batch.epoch)) continue;
        if (counted !== undefined && rules.compareOrdinal(counted, row.batch.deadline) > 0) continue;
        if (this.committee?.retirementFor?.(row.batch)) continue;
        check(/^[0-9a-f]{64}$/.test(row.evidence?.id), 'draft_reference');
        const text = await readFile(join(this.store.directory, 'retired-drafts', row.evidence.id + '.json'), 'utf8');
        check(hash(text) === row.evidence.hash, 'draft_checksum');
        const saved = JSON.parse(text);
        check(rules.stableJSON(saved.draft?.proposal?.batch) === rules.stableJSON(row.batch), 'draft_batch_conflict');
        candidates.push(saved);
      }
      if (page.length < this.archiveWritePage) break; after = page.at(-1).id;
    }
    return candidates;
  }
  async recoverReservedDraft(draft, { epoch, counted, last, root = null }) {
    const batch = draft?.proposal.batch ?? { epoch, n: rules.ordinalCodec(typeof last.n === 'string').add(last.n) };
    const key = `batch/${batch.epoch}/${batch.n}`, ceremony = this.store.get('ceremonies', key);
    const expired = draft && counted !== undefined && rules.compareOrdinal(counted, batch.deadline) > 0;
    // Let a live ceremony finish, and give a fresh attempt time to prepare.
    // Waiting polls use the existing retry setting; a new committed height
    // bypasses that delay so strict deadline expiry can unblock immediately.
    if (draft && ceremony?.recovery?.waiting && String(ceremony.recovery.counted) === String(counted) &&
      Date.now() - ceremony.recovery.checkedAt < this.committee.batchRetryMs) return { draft, accepted: false, waiting: true };
    if (draft && !expired && ceremony?.proposal?.batch && rules.stableJSON(ceremony.proposal.batch) === rules.stableJSON(batch) && (['prepared', 'running', 'complete'].includes(ceremony.stage) ||
      !ceremony.recovery?.waiting && Date.now() - (ceremony.recovery?.checkedAt ?? ceremony.lastReset ?? ceremony.started ?? 0) < this.committee.batchRetryMs))
      return { draft, accepted: false, waiting: !!ceremony.recovery?.waiting };
    check(ceremony?.reason !== 'signature_disagreement', 'signature_disagreement', 503);
    const archived = await this.retiredBatchDrafts(batch, { counted });
    const candidates = [...(draft ? [{ draft, proposal: draft.proposal }] : []), ...archived.map(row => ({ ...row, proposal: row.draft.proposal }))];
    if (!candidates.length) return { draft, accepted: false };
    const checkSnapshot = async () => check(rules.stableJSON(last) === rules.stableJSON(await this.reads.batchLast()) &&
      rules.compareOrdinal(epoch, await this.reads.committeeEpoch()) === 0, 'draft_snapshot_changed', 503);
    if (this.committee.retireStaleFinancial) {
      for (const candidate of candidates) {
        const retirement = await this.committee.retireStaleFinancial(candidate.proposal, () => this.reads.batchStamp?.());
        if (!retirement || draft && candidate.draft !== draft) continue;
        if (retirement.ready) {
          await checkSnapshot();
          await this.archiveDraft(candidate.draft, { reason: 'financial_snapshot_retired', epoch, counted, last, root,
            digest: retirement.certificate.target.digest });
          return { draft: null, accepted: false };
        }
        draft ??= candidate.draft;
        if (!this.store.get('meta', 'draft')) await this.saveDraft(draft);
        await this.committee.waitForBatch(key, draft.proposal, { counted, retirement: retirement.certificate.target.digest }, 'batch_retirement_wait');
        return { draft, accepted: false, waiting: true };
      }
    }
    const plan = await this.committee.batchReservationPlan(key, candidates, { epoch, counted });
    const activation = this.settings.batchVersion === 2 && this.settings.activation;
    const anchored = draft && activation && String(batch.n) === String(activation.sequence) && String(draft.execution) === String(activation.height);
    const changed = draft && !anchored && counted !== undefined && rules.compareOrdinal(draft.execution, counted) !== 0;
    const rejected = ceremony?.stage === 'blocked' && ceremony.reason === 'prepare_incomplete' &&
      !ceremony.resetting && !ceremony.retry && !ceremony.retryPrepare && !ceremony.retryBusy && !ceremony.unreserved?.length &&
      !ceremony.failures?.every(e => e === 'committee_signer_busy');
    let fence = { ok: true, unavailable: [] };
    if (plan.unreserved && (!draft || expired || changed || rejected)) {
      // Absence is only provisional until late preparations are fenced. Once
      // every old deadline has passed, signers prove retirement themselves.
      fence = plan.retired ? fence : await this.committee.fenceBatchAttempts(plan.attempts, this.committee.signers.map(s => s.id), { epoch, counted });
      if (fence.ok) {
        await checkSnapshot();
        if (draft) await this.archiveDraft(draft, { reason: expired ? 'deadline_expired' : changed ? 'execution_snapshot_changed' : 'preparation_unreserved', epoch, counted, last, root });
        return { draft: null, accepted: false };
      }
    }
    if (plan.candidate) {
      fence = await this.committee.fenceBatchAttempts(plan.attempts, plan.peers, { epoch, counted }, plan.digest);
      if (fence.ok) {
        await checkSnapshot();
        const restored = plan.candidate.draft;
        if (draft && rules.stableJSON(batch) !== rules.stableJSON(restored.proposal.batch))
          await this.archiveDraft(draft, { reason: 'reserved_version_restored', epoch, counted, last, root, digest: plan.digest });
        if (restored !== draft) await this.saveDraft(restored);
        await this.committee.resumeBatch(key, plan);
        return { draft: restored, accepted: false };
      }
    } else if (plan.retired && draft && !expired) {
      if (ceremony) await this.store.transact([
        ...(ceremony.id && ceremony.peers?.length === 3 ? [{ space: 'batchCeremonyAttempts', id: key + '/' + ceremony.id, value: ceremony }] : []),
        { space: 'ceremonies', id: key }
      ]);
      return { draft, accepted: false };
    }
    draft ??= candidates[0].draft;
    if (!this.store.get('meta', 'draft')) await this.saveDraft(draft);
    await this.committee.waitForBatch(key, draft.proposal, { ...plan.recovery, fenceFailures: fence.unavailable }, plan.waiting ? 'batch_reservation_wait' : 'batch_recovery_fencing');
    return { draft, accepted: false, waiting: true };
  }
  async reconcileDraft(draft) {
    if (!draft) {
      if (!this.committee?.batchReservationPlan) return { draft: null, accepted: false };
      const last = await this.reads.batchLast(), epoch = await this.reads.committeeEpoch(), counted = await this.reads.counted?.();
      return this.committee.signatureGate(() => this.recoverReservedDraft(null, { last, epoch, counted }));
    }
    const batch = draft.proposal.batch, key = `batch/${batch.epoch}/${batch.n}`, clock = rules.ordinalCodec(!!draft.settings?.document);
    const last = await this.reads.batchLast(), epoch = await this.reads.committeeEpoch(), counted = await this.reads.counted?.();
    const root = this.reads.batchRoot ? await this.reads.batchRoot(batch.n) : clock.compare(last.n, batch.n) < 0 ? null :
      (await this.outbox.transport.status({ op: 'bt', value: batch })).state === 'accepted' ? batch.root : undefined;
    check(rules.stableJSON(last) === rules.stableJSON(await this.reads.batchLast()) && epoch === await this.reads.committeeEpoch(), 'draft_snapshot_changed', 503);
    check(clock.valid(clock.value(epoch)) && clock.compare(epoch, batch.epoch) >= 0, 'committee_epoch_unavailable', 503);
    // Acceptance takes precedence over expiry or rotation, even if the service
    // crashed before saving its transport receipt or local replay checkpoint.
    if (root === batch.root) return { draft, accepted: true };
    check(root === null && clock.compare(last.n, batch.n) < 0, 'draft_batch_conflict', 503);
    const expired = counted !== undefined && clock.valid(batch.deadline) && clock.compare(counted, batch.deadline) > 0;
    if (this.committee?.batchReservationPlan && clock.compare(epoch, batch.epoch) === 0 &&
      (expired || !draft.signature && !this.store.get('outbox', key) && !this.store.get('sent', key)))
      return this.committee.signatureGate(() => this.recoverReservedDraft(draft, { epoch, counted, last, root }));
    if (!draft.signature && !this.store.get('outbox', key) && !this.store.get('sent', key)) {
      const retirement = await this.committee?.retireUnprepared?.(key);
      if (retirement) {
        await this.archiveDraft(draft, { reason: 'preparation_unreserved', epoch, counted, last, root, retirement });
        return { draft: null, accepted: false };
      }
    }
    const superseded = clock.compare(epoch, batch.epoch) > 0;
    // A blocked preparation in which every member answered that it holds no
    // reservation for this proposal can never be signed; treat it as unreserved.
    const ceremony = this.store.get('ceremonies', key);
    const unprepared = ceremony?.stage === 'blocked' && ceremony.retryPrepare === true && Array.isArray(ceremony.peers) && ceremony.peers.length > 0
      && ceremony.peers.every(id => ceremony.unreserved?.includes(id));
    const unreserved = !draft.signature && (!ceremony || unprepared) && !this.store.get('outbox', key) && !this.store.get('sent', key);
    const activation = this.settings.batchVersion === 2 && this.settings.activation;
    const anchoredDraft = activation && clock.compare(batch.n, activation.sequence) === 0 && clock.compare(draft.execution, activation.height) === 0;
    if (superseded || expired || unreserved && !anchoredDraft && counted !== undefined && clock.compare(draft.execution, counted) !== 0) {
      await this.archiveDraft(draft, { reason: superseded ? 'epoch_superseded' : expired ? 'deadline_expired' : 'execution_snapshot_changed',
        epoch, counted: counted ?? null, last, root });
      return { draft: null, accepted: false };
    }
    return { draft, accepted: false };
  }
  // While batches stall, a forced seal can land behind a tip a later batch already
  // counted. An empty one carries no receipts and can never pass the block clock;
  // retire it instead of retrying the same batch forever. Entries with moves stay.
  async retireStaleEmpty(clock) {
    const counted = this.store.get('meta', 'ruleState')?.counted;
    if (counted === undefined || counted === null) return;
    for (const { id, value: o } of this.store.list('observations', { limit: 64 })) {
      if (clock.compare(o.counted, counted) >= 0 || Number(o.receiptRoot?.count) !== 0 || this.store.hasRows('intake/' + id)) return;
      await this.store.transact([{ space: 'observationRecovery', id, value: { reason: 'stale_empty_observation', counted: o.counted, tip: o.tip } }, { space: 'observations', id }]);
    }
  }
  async reduceStalled(last) {
    const cap = this.limits.maxObservations ?? 512;
    if (this.store.count('observations') <= cap) return;
    const page = this.store.list('observations', { limit: Math.min(4096, cap + 1) });
    // Keep every new raw-tip height so window/deciding-hash observations cannot have
    // gaps. Excess stalled revisits receive explicit rejections, preserving seals
    // and signed moves; they are never moved to a newer receipt window.
    const first = page[0].value;
    if (first.counted !== last.to) return;
    let highestTip = first.tip;
    for (const row of page.slice(1, -1)) {
      const o = row.value;
      if (o.counted !== first.counted) break;
      if (o.tip > highestTip) { highestTip = o.tip; continue; }
      const entries = this.store.list('intake/' + row.id, { limit: 1000 });
      const path = `records/deferred/${row.id}.json`;
      await this.files.immutable(path, Buffer.from(JSON.stringify({ observation: o, entries: entries.map(r => r.value), reason: 'stalled_observation_capacity', retry: 'submit_new_signed_move_at_current_tip' })));
      await this.store.transact([{ space: 'observationRecovery', id: row.id, value: { path: '/' + path, reason: 'stalled_observation_capacity' } }, { space: 'observations', id: row.id },
        ...entries.flatMap(r => [{ space: 'intake/' + row.id, id: r.id }, { space: 'dedupe', id: rules.moveId(r.value.move) }])]);
    }
  }
  // A late segment needs three signers that acknowledged all of its receipts. When the
  // witness quorum fails, collect the missing acknowledgements once and ask again.
  async attestSegment(root, entries, version2) {
    try { return await this.committee.attestRoot(root); }
    catch (error) {
      const admission = this.intake.namedAdmission;
      if (!version2 || this.speculative || !entries.length || error.message !== 'receipt_quorum_unavailable' || !admission?.backfillAcknowledgements) throw error;
      this.step = ['backfillAcknowledgements', Date.now()];
      await admission.backfillAcknowledgements(entries);
      this.step = ['attestRoot', Date.now()];
      return this.committee.attestRoot(root);
    }
  }
  async build() {
    if (this.recovery?.active()) return null;
    // Reconciliation may have retired an old unsigned draft since the poller
    // last refreshed policy. Fence its acknowledged receipts before rebuilding.
    this.step = ['prepareBatch', Date.now()];
    if (!this.speculative) await this.intake.prepareBatch?.();
    const clock = rules.ordinalCodec(!!this.settings.document);
    this.step = ['batchLast', Date.now()];
    const last = await this.reads.batchLast(), epoch = clock.value(await this.reads.committeeEpoch());
    check(clock.valid(epoch), 'committee_epoch_unavailable', 503);
    const version2 = this.settings.batchVersion === 2;
    const renewal = this.settings.receiptRenewal;
    const fence = this.settings.document && this.store.get('namedFences', this.settings.settingsHash);
    if (fence && !renewal) return this.buildReceiptRenewal(fence);
    if (version2 && this.financial) this.financial.document = this.settings.document;
    if (!version2) await this.reduceStalled(last);
    this.step = ['retireStale', Date.now()];
    if (version2 && !renewal && !this.speculative) await this.retireStaleEmpty(clock);
    if (version2 && !renewal && BigInt(this.store.countUint('observations')) < BigInt(rules.batchSettings(this.settings).observationsPerBatch)) {
      const free = this.intake.count || this.store.get('meta', 'namedReservedBatch') || this.store.get('meta', 'ruleState')?.rounds?.some(r => r.closed || r.closing);
      this.step = ['financialReady', Date.now()];
      const financial = !free && !this.store.hasRows('observations') && await this.financial?.ready({ height: this.intake.head?.counted, at: { counted: this.intake.head?.counted, last } });
      this.step = ['seal', Date.now()];
      if (free || financial) await this.intake.seal({ financial: !!financial });
    }
    let observations = this.store.list('observations', { limit: renewal ? Math.min(Number(BigInt(renewal.cutoff.segmentCount) - BigInt(renewal.cursor.segment)), rules.batchSettings(this.settings).maxObservations) : version2 ? rules.batchSettings(this.settings).observationsPerBatch : this.limits.maxObservations ?? 512 }).map(r => r.value);
    if (!observations.length || (!version2 && observations.at(-1).counted <= last.to)) return null;
    this.step = ['counted', Date.now()];
    let execution = clock.value(await this.reads.counted?.() ?? observations.at(-1).counted);
    // The contract pins the first v2 batch to the activation anchor. If headers were
    // counted while the gateway started, execute that batch at the anchor and treat its
    // observations as counted there (v2 has counted nothing past the anchor yet).
    const activation = version2 && this.settings.activation;
    let anchored = false; const liveCounted = execution;
    if (activation && clock.compare(clock.add(last.n), activation.sequence) === 0 && clock.compare(execution, activation.height) > 0) {
      anchored = true;
      execution = clock.value(activation.height);
      observations = observations.map(o => clock.compare(o.counted, execution) > 0 ? { ...o, counted: execution, confirmed: clock.min(o.confirmed, execution) } : o);
    }
    this.step = ['committeeReady', Date.now()];
    if (this.committee.ready && !await this.committee.ready({ counted: execution, tip: observations.reduce((n, o) => clock.max(n, o.tip), clock.zero) })) return null;
    this.step = ['settings', Date.now()];
    const contract = await this.reads.settings?.();
    const policy = version2 && this.settings.document?.values;
    const limits = { ...this.limits, ...(policy ? { maxBytes: policy.batchBytes, maxOps: policy.batchOps, maxAssets: policy.batchAssets, maxKv: policy.batchKv, maxAuditBytes: policy.auditTotalBytes } :
      contract ? { maxBytes: contract.batch_bytes, maxOps: contract.batch_ops, maxAssets: contract.batch_assets, maxKv: contract.batch_kv } : {}) };
    const settings = { claimsPerWindow: rules.CLAIM_DEFAULTS.claimsPerWindow, ...this.settings, maxBatchBytes: limits.maxBytes, maxOps: limits.maxOps, maxAssets: limits.maxAssets, maxKv: limits.maxKv, maxMintOps: limits.maxMintOps ?? this.settings.maxMintOps ?? 8 };
    limits.maxMintOps = settings.maxMintOps;
    let state = this.store.get('meta', 'ruleState') ?? initialState(observations[0].tip, observations[0].hash, last.to);
    if (version2) state.batchVersion = 2;
    state = hydrateState(this.store, state, observations, settings);
    let patterns = this.store.get('meta', 'patterns') ?? this.patterns;
    for (const observation of observations) for (const { value: { move } } of this.store.list('intake/' + observation.id, { limit: 1000 })) if (move.t === 'craft') {
      state.balances[move.a] ??= {};
      this.step = ['balances', Date.now()];
      for (const [asset] of move.p.request.in) state.balances[move.a][asset] ??= await this.reads.balance(move.a, asset);
      state.usedNonces[`${move.a}:${move.p.request.nonce}`] ??= await this.reads.nonceUsed(move.a, move.p.request.nonce);
    }
    const findIds = new Set((state.rounds ?? []).flatMap(r => (r.slots ?? []).map(s => s.id)));
    for (const observation of observations) for (const { value: { move } } of this.store.list('intake/' + observation.id, { limit: 1000 }))
      if (move.t === 'claim') for (const plot of move.p.plots) for (const pattern of plot.patterns) findIds.add(rules.findId(plot.block, pattern));
    for (const id of findIds) { const find = this.store.get('finds', id); if (find) state.finds[id] = find; }
    const startState = structuredClone(state), startPatterns = structuredClone(patterns), items = [], claimNodes = new Map(this.predecessorClaimNodes);
    const accountStore = new AccountBatchOverlay(this.store), financialIncluded = new Set();
    if (this.predecessorNamedNodes) accountStore.spaces.set('namedNodes', new Map(this.predecessorNamedNodes));
    observationsLoop: for (const observation of observations) {
      const history = this.history.view?.(observation.tip, observation.hash) ?? this.history;
      const originalEntries = this.store.list('intake/' + observation.id, { limit: 1000 }).map(r => r.value);
      if (settings.document && !renewal && originalEntries.some(e => rules.compareUint(e.receipt.batch, String(clock.add(last.n))) > 0)) break;
      let entries = originalEntries, receiptRoot = observation.receiptRoot, rootAttestations = [], missed = null;
      if (entries.length || version2) {
        if (version2 && !this.speculative && this.intake.namedAdmission && entries.length) {
          this.step = ['acknowledgeReceipts', Date.now()];
          await this.intake.namedAdmission.acknowledgePending(entries);
        }
        this.step = ['attestRoot', Date.now()];
        try { if (this.store.get('missedReceipts', observation.id)) throw Error('receipt_quorum_unavailable'); rootAttestations = await this.attestSegment(receiptRoot, originalEntries, version2); }
        catch (e) {
          if (version2 || e.message !== 'receipt_quorum_unavailable' || (this.intake.head?.highestTip ?? 0) < observation.tip + 2) throw e;
          missed = { observation, entries: originalEntries, reason: 'receipt_witness_window_missed' };
          await this.files.immutable(`records/missed/${observation.id}.json`, Buffer.from(JSON.stringify(missed)));
          await this.store.put('missedReceipts', observation.id, { reason: missed.reason, seal: receiptRoot, path: `/records/missed/${observation.id}.json` });
          entries = []; receiptRoot = rules.sealReceipts([], { network: this.intake.network, tip: observation.tip, hash: observation.hash }, this.intake.secret);
        }
      }
      const view = { observation: clock.add(state.observation ?? 0), height: observation.counted, tip: observation.tip, tipHash: observation.hash };
      const input = { height: observation.counted, executionHeight: execution, blockHash: history.hashAt(observation.counted), tip: observation.tip, tipHash: observation.hash,
        confirmed: clock.min(observation.confirmed, observation.counted), network: this.intake.network, gateway: this.intake.gateway,
        entries, receiptRoot, rootAttestations, priorOperations: rules.budgetOperations(items.map(i => i.output.file)), state: structuredClone(state), patterns, settings, mintOperations: [] };
      if (settings.document) {
        input.financialPlanning = true;
        const deliveryCap = this.financial?.resources?.settlementDeliveryRows, allowance = rules.batchSettings(settings);
        if (deliveryCap) input.deliveryRows = Math.min(deliveryCap, allowance.settlementPageRows * allowance.settlementPagesPerObservation);
        input.batchSequence = String(clock.add(last.n));
        if (renewal) input.renewal = renewal;
        input.settingsDocuments = this.settings.settingsDocuments ?? [];
        if (receiptRoot.settingsHash !== settings.settingsHash) {
          const original = this.store.get('settingsHistory', receiptRoot.settingsHash);
          check(original && rules.hashObject(original) === receiptRoot.settingsHash, 'settings_unknown');
          input.settingsDocuments = [...input.settingsDocuments, original];
        }
        input.namedEvidence = namedBatchEvidence({ store: accountStore, state, entries, settings: settings.document,
          settingsDocuments: input.settingsDocuments, batch: input.batchSequence, gateway: this.intake.gateway, history, counted: observation.counted, renewal });
        input.claimEvidence = { nodes: [] };
        input.settingsDocuments = input.namedEvidence.settingsDocuments;
        const owners = rules.accountRevisionOwners(entries);
        if (owners.length) input.accountRevisions = owners.map(owner => [owner, accountStore.get('accountRecords', 'ar/' + owner)?.revision ?? '0']);
      }
      const publicClaimsActive = settings.document && rules.claimsNeverCloseActive(settings, execution);
      this.step = ['publicReads', Date.now()];
      const publicReads = publicClaimsActive ? (await import('../../committee/signer/bulk-mint.mjs')).bulkPublicReads(this.reads, accountStore) : this.reads;
      const publicMintRead = (asset, block, deployment) => readPublicWinner({ store: accountStore, reads: publicReads, at: { counted: execution, last } }, asset, block, deployment);
      const claimReads = settings.document ? { store: this.store, staged: claimNodes, namedStaged: accountStore.spaces.get('namedNodes'),
        ...(publicClaimsActive ? { publicMintGet: publicMintRead,
          publicMintBatch: prefetchingWinnerBatch({ store: accountStore, reads: publicReads, at: { counted: execution, last }, claims: this.speculative ? null : this.store }) } : {}) } : undefined;
      const replay = async () => {
        const { claimEvidence, namedEvidence, claimReadHints, deliveryRows, ...output } = await this.replay.run(input, history, claimReads);
        if (claimEvidence) input.claimEvidence = claimEvidence;
        if (namedEvidence) input.namedEvidence = namedEvidence;
        if (claimReadHints) input.claimReadHints = claimReadHints;
        else delete input.claimReadHints;
        if (deliveryRows !== undefined) input.deliveryRows = deliveryRows;
        if (publicClaimsActive) input.publicMintEvidence = output.file.publicMintEvidence;
        // Keep proof tables once in the input, rather than serializing another
        // full copy into every persisted output/draft.
        return output;
      };
      this.step = ['replay', Date.now()];
      let output = await replay();
      if (settings.document) {
        for (;;) {
          try {
            const publicReaders = publicClaimsActive ? publicClaimReaders({ input, store: accountStore, claimNodes, publicMintRead }) : undefined;
            const publicClaims = publicReaders && rules.publicClaimProjection(output, input, publicReaders.readers);
            const accounts = this.financial && !renewal && !anchored && clock.compare(execution, observation.counted) === 0
              ? await this.financial.build({ credits: output.file.ops, crafts: output.file.crafts, transfers: output.file.transfers, compoundMerge: output.file.compoundMerge, height: observation.counted, at: { counted: execution, last }, accountStore,
                ...(publicClaims ? { publicClaims, preparePublicMint: publicReaders.prepare } : {}),
                priorLinkInputs: items.reduce((n, i) => n + (i.output.file.financialOperations ?? []).filter(f => f.transition.action?.type?.startsWith('link-')).length, 0),
                excluded: financialIncluded, remaining: settings.document.values.mintOperationBudget - financialIncluded.size, priorOperations: input.priorOperations,
                priorAssetTouches: items.reduce((n, i) => n + (i.output.accountAssetTouches ?? 0), 0) })
              : await buildCreditAccounts({ store: accountStore, credits: output.file.ops, crafts: output.file.crafts, transfers: output.file.transfers, compoundMerge: output.file.compoundMerge, document: settings.document, height: observation.counted, executionHeight: execution });
            input.accountOperations = accounts.creditOperations ?? accounts.operations;
            if (accounts.inputs?.length) input.financialOperations = accounts.inputs;
            if (!entries.length && !accounts.operations.length && !output.file.settlements.length && !output.file.closures.length && !output.file.closureProgress?.length &&
              clock.compare(observation.counted, state.counted) === 0 && clock.compare(observation.tip, state.lastTip) === 0) input.receiptContinuation = true;
            // Financial segments can outlive source readiness. Imported work
            // can also have observed the activation tip already. In both
            // cases commit the witnessed receipt-chain advancement, so the
            // first activation batch does not require another player action.
            delete input.financialPlanning;
            if (publicClaims) {
              const rows = new Map([...input.publicMintEvidence, ...publicClaims.evidence.rows()].map(row => [row.asset + '/' + row.block, row]));
              input.publicMintEvidence = [...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row);
              publicReaders.collect();
            }
            output = { ...rules.finalizeBlockV2Accounts(output, input, publicReaders?.readers), accountWrites: accounts.writes, accountAssetTouches: accounts.assetTouches };
            publicReaders?.collect();
            break;
          } catch (error) {
            const rows = input.deliveryRows ?? settings.settlementPageRows * settings.settlementPagesPerObservation;
            if (items.length && error.message === 'financial_batch_assets' && rows <= 1) break observationsLoop;
            if (!['account_operation', 'account_operation_bytes', 'account_proof_budget', 'account_leaf_budget', 'financial_batch_assets', 'audit_budget'].includes(error.message) || rows === 0 || rows === 1 && !output.file.crafts.length && !output.file.transfers?.length) throw error;
            input.deliveryRows = rows === 1 ? 0 : Math.max(1, Math.floor(rows / 2)); delete input.accountOperations; delete input.financialOperations;
            output = await replay();
          }
        }
      }
      if (items.length && items.reduce((n, i) => n + i.output.auditBytes.length, 0) + output.auditBytes.length >
        (version2 ? rules.batchSettings(settings).auditMaxBytes : limits.maxAuditBytes ?? 1500000)) break;
      if (version2 && items.length) {
        const ops = [...items.flatMap(i => i.output.file.ops), ...output.file.ops], s = rules.batchSettings(settings);
        if (ops.length + 2 > s.maxOps || Buffer.byteLength(rules.stableJSON(ops)) + s.batchEnvelopeReserveBytes > s.maxBatchBytes ||
          items.reduce((n, i) => n + (i.output.accountAssetTouches ?? 0), output.accountAssetTouches ?? 0) > s.maxAssets) break;
      }
      accountStore.apply([...(output.accountWrites ?? []), ...(output.namedWrites ?? [])]);
      for (const input of output.file.financialOperations ?? []) if (input.transition.type === 'reserve' || input.transition.type === 'reserve-many' || input.transition.action?.type === 'link-reserve')
        accountStore.financialReservations.set(input.transition.id, input.evidence);
      for (const i of output.file.financialOperations ?? []) financialIncluded.add(rules.hashObject(['dmw-financial-transition-v2', i.transition]));
      items.push({ observation, input, output, originalEntries, missed: !!missed }); state = output.state; patterns = output.patterns;
      for (const row of output.claimWrites ?? []) claimNodes.set(row.id, row.value);
    }
    if (!items.length) return null;
    const headers = this.reads.batchHeaders ? await this.reads.batchHeaders(items.map(i => i.observation)) : items.flatMap(i => i.observation.headers ?? []);
    check(headers.length <= (version2 ? rules.batchSettings(settings).maxHeaders : 20), 'header_catchup_required', 503);
    const batchLimits = version2 && rules.batchSettings(settings);
    // An anchored first batch executes in the past; its deadline counts from the live clock, within the max horizon.
    const deadline = !version2 ? rules.batchDeadline(execution) : anchored
      ? clock.min(clock.add(liveCounted, batchLimits.batchDeadlineBlocks), clock.add(execution, batchLimits.batchDeadlineMaxBlocks))
      : clock.add(execution, batchLimits.batchDeadlineBlocks);
    const previousRoot = version2 ? (BigInt(last.n) > 0n ? await this.reads.batchRoot(last.n) : this.settings.activation.previousRoot) : undefined;
    const assemble = () => buildBatch({ ...limits, network: this.intake.network, epoch, executionHeight: execution, deadline,
      settings, renewal, ...(renewal ? { renewalSlice: storedRenewalSlice(this.store, renewal, items.map(i => ({ seal: i.output.file.receiptRoot, receipts: i.output.file.receipts })), settings.document) } : {}), activation: this.settings.activation, previousRoot, executionHash: this.history.hashAt(execution),
      catalogRoot: items.at(-1).output.state.catalogRoot, accountRoot: items.at(-1).output.state.accountRoot,
      sequence: clock.add(last.n), lastTo: last.to, files: items.map(i => i.output.file), headers });
    let built;
    if (renewal) {
      for (;;) {
        try { built = assemble(); break; } catch (error) {
          if (items.length <= 1 || !['batch_bytes', 'batch_audit_budget', 'batch_record_budget', 'batch_closure_budget', 'renewal_slice_budget'].includes(error.message)) throw error;
          items.pop();
        }
      }
    }
    const final = items.at(-1);
    if (!renewal && (this.operations || this.links) && clock.compare(execution, final.input.height) === 0) {
      const view = { observation: final.output.file.observation, height: execution, tip: final.input.tip, tipHash: final.input.tipHash };
      const linkOperations = await this.links?.inputs(view) ?? [];
      if (linkOperations.length) {
        final.input.linkOperations = linkOperations;
        final.output = await this.replay.run(final.input, this.history.view?.(final.input.tip, final.input.tipHash) ?? this.history);
      }
      // Mint evidence projects balances from the final allocation, including
      // credits deferred when links consumed the remaining operation budget.
      const mintOperations = await this.operations?.inputs({ counted: execution, last, files: items.map(i => i.output.file), view, limit: settings.maxMintOps }) ?? [];
      if (mintOperations.length) {
        final.input.mintOperations = mintOperations;
        final.output = await this.replay.run(final.input, this.history.view?.(final.input.tip, final.input.tipHash) ?? this.history);
      }
    }
    if (version2 && !items.some(({ output: { file: f } }) => f.receiptContinuation || f.closureProgress?.length || f.moves.length || f.settlements.length || f.closures.length || f.financialOperations?.length || clock.compare(f.height, f.previousHeight) > 0 || clock.compare(f.tip, f.previousTip) > 0)) return null;
    built ??= assemble();
    const draft = { version: 3, execution, last, startState, startPatterns, settings, limits, headers, items,
      ...(version2 ? { activation: this.settings.activation, previousRoot } : {}),
      proposal: { network: this.intake.network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(b => Buffer.from(b).toString('hex')) } };
    if (!this.speculative) { await this.publishDraft(draft); await this.saveDraft(draft); } return draft;
  }
  async publishDraft(draft) {
    for (const item of draft.items) {
      item.publication = await this.files.publish(item.output, { ...item.observation, ...(item.missed ? { receiptSuffix: '-missed' } : {}) });
      item.output = { ...item.output, auditBytes: undefined, viewerBytes: undefined };
    }
  }
  async prepareSuccessor(predecessor) {
    if (this.pipelineDepth < 2 || !predecessor.settings.document || this.operations || this.links ||
      predecessor.proposal.batch.renewal || this.store.get('namedFences', predecessor.settings.settingsHash)) return null;
    const last = { n: predecessor.proposal.batch.n, to: predecessor.proposal.batch.to };
    const admissionSequence = this.store.get('meta', 'namedReceiptSequence') ?? '0';
    const overlay = successorStore(this.store, predecessor);
    if (this.intake.entries?.().length) return null;
    const more = predecessor.items.at(-1).output.state.rounds?.some(r => r.closed || r.closing);
    if (!overlay.store.hasRows('observations') && !more) return null;
    // A successor remains speculative until every receipt admitted during
    // signing is accounted for. Promotion checks the sequence under the gate.
    if (!overlay.store.hasRows('observations')) {
      if (this.intake.namedAdmission?.wait?.admissionFutureBatches) return null;
      if (this.intake.count || this.intake.rotating) return null;
      await this.intake.seal({ continuation: true });
    }
    // Receipt witnessing refreshes each signer's evidence lease. Finish it
    // before asking those signers to audit the predecessor; only local build
    // and replay overlap the signing lane.
    const certificates = new Map();
    for (const { value: observation } of overlay.store.list('observations', { limit: rules.batchSettings(this.settings).observationsPerBatch })) {
      const entries = this.store.list('intake/' + observation.id, { limit: 1000 }).map(r => r.value);
      if (entries.length && this.intake.namedAdmission) await this.intake.namedAdmission.acknowledgePending(entries);
      certificates.set(rules.hashObject(observation.receiptRoot), await this.committee.attestRoot(observation.receiptRoot));
    }
    const builder = Object.assign(Object.create(Pipeline.prototype), this, { store: overlay.store, speculative: true,
      committee: { ...this.committee, attestRoot: async root => { const certificate = certificates.get(rules.hashObject(root)); check(certificate, 'speculative_receipt_changed'); return certificate; } },
      predecessorClaimNodes: overlay.claimNodes, predecessorNamedNodes: overlay.namedNodes, financial: null,
      settings: structuredClone(this.settings),
      intake: { ...this.intake, seal: async () => null },
      reads: { ...this.reads, batchLast: async () => last, batchRoot: async n => String(n) === String(last.n) ? predecessor.proposal.batch.root : this.reads.batchRoot(n) }
    });
    return async () => {
      this.overlap.started++; const started = performance.now();
      try { const draft = await builder.build(); return draft && { ...draft, admissionSequence }; }
      finally { this.overlap.buildMs += performance.now() - started; }
    };
  }
  async promoteSuccessor(predecessor, draft) {
    if (!draft) return;
    if (draft.admissionSequence !== undefined && draft.admissionSequence !== (this.store.get('meta', 'namedReceiptSequence') ?? '0')) {
      this.overlap.discarded++; return;
    }
    const last = await this.reads.batchLast(), epoch = await this.reads.committeeEpoch(), counted = await this.reads.counted();
    const reason = await this.reads.batchRoot(predecessor.proposal.batch.n) !== predecessor.proposal.batch.root ? 'acceptance' :
      successorMismatch({ predecessor, draft, last, epoch, counted, settings: this.settings,
        state: this.store.get('meta', 'ruleState'), hashAt: h => this.history.hashAt(h) });
    if (reason) { this.overlap.discarded++; this.overlap.discardReasons ??= {}; this.overlap.discardReasons[reason] = (this.overlap.discardReasons[reason] ?? 0) + 1; return; }
    const active = await this.reads.rulesContext?.();
    if (active && rules.hashObject(rules.effectiveSettings(active.settings, active.scheduledSettings, String(draft.proposal.batch.n), String(draft.execution))) !== draft.settings.settingsHash) {
      this.overlap.discarded++; return;
    }
    await this.publishDraft(draft);
    if (await this.saveDraft(draft, { admissionSequence: draft.admissionSequence }) === false) { this.overlap.discarded++; return; }
    this.overlap.promoted++;
  }
  async buildReceiptRenewal(fence) {
    check(fence.phase === 'certified', 'receipt_cutoff_incomplete', 503);
    const accepted = await this.reads.rulesContext();
    check(!accepted.receiptRenewal && rules.hashObject(accepted.settings) === fence.cutoff.settingsHash &&
      accepted.scheduledSettings && rules.hashObject(accepted.scheduledSettings) === fence.cutoff.successorHash, 'renewal_policy');
    for (const segment of fence.evidence.segments ?? []) await this.committee.attestRoot(segment.seal);
    const execution = rules.decimalV2(await this.reads.counted()), state = this.store.get('meta', 'ruleState');
    const built = rules.buildReceiptRenewalBatch({ cutoff: fence.cutoff, votes: fence.votes, document: fence.document,
      epoch: rules.decimalV2(await this.reads.committeeEpoch()), last: accepted.last, accounts: accepted.accountsRoot,
      observation: rules.decimalV2(state.observation), execution: { height: execution, hash: this.history.hashAt(execution) },
      deadline: rules.addUint(execution, String(fence.document.values.batchDeadlineTips)) });
    const draft = { version: 3, execution, last: accepted.last, startState: state, startPatterns: this.patterns,
      settings: this.settings, limits: this.limits, headers: [], items: [], activation: this.settings.activation, previousRoot: built.batch.previous,
      proposal: { network: this.intake.network, kind: 'batch', batch: built.batch, files: [], cutoffEvidence: fence.evidence } };
    await this.saveDraft(draft); return draft;
  }
  async tick() {
    if (this.running) return; this.running = true;
    let speculative = this.speculation?.promise, signingEnded;
    try {
      if (!this.reconciled) { await pruneDrafts(this.store); const latest = this.store.get('meta', 'latest'); if (latest) await this.files.json('latest.json', latest); this.reconciled = true; }
      this.step = ['reconcile', Date.now()];
      let { draft, accepted, waiting } = await this.reconcileDraft(await this.loadDraft());
      if (waiting) { this.step = ['batchReservationWait', Date.now()]; return; }
      if (speculative && (!draft || this.speculation.proposalHash !== hash(JSON.stringify(draft.proposal)))) {
        if (await speculative) this.overlap.discarded++; this.speculation = null; speculative = null;
      }
      this.step = ['build', Date.now()];
      draft ??= await this.build(); if (!draft) return;
      const key = `batch/${draft.proposal.batch.epoch}/${draft.proposal.batch.n}`;
      if (!accepted) {
        this.step = ['publishContext', Date.now()];
        await this.reads.publishContext?.(draft.proposal.batch.n, draft);
        if (!draft.signature) {
          this.step = ['successor', Date.now()];
          const buildNext = await this.prepareSuccessor(draft).catch(() => { this.overlap.failed++; return null; });
          const started = performance.now();
          if (buildNext) speculative = buildNext().then(next => { this.overlap.overlapMs += Math.max(0, Math.min(performance.now(), signingEnded ?? Infinity) - started); return next; })
            .catch(() => { this.overlap.failed++; return null; });
          this.step = ['sign', Date.now()];
          const signed = await this.committee.signature(key, draft.proposal, { counted: draft.execution }); signingEnded = performance.now(); if (!signed) return;
          draft.signature = signed.signature.compact; await this.saveDraft(draft);
          if (speculative) this.speculation = { proposalHash: hash(JSON.stringify(draft.proposal)), promise: speculative };
        }
        this.step = ['outbox', Date.now()];
        await this.outbox.enqueue(key, 'bt', { ...draft.proposal.batch, sig: draft.signature }); await this.outbox.tick();
        if (!this.store.get('sent', key)) return;
      } else if (this.store.get('outbox', key)) {
        await this.store.transact([{ space: 'sent', id: key, value: { id: key, accepted: Date.now(), root: draft.proposal.batch.root } }, { space: 'outbox', id: key }]);
      }
      if (draft.proposal.batch.renewal?.kind === 'reserve') {
        const batch = draft.proposal.batch, renewal = rules.receiptRenewalRecord(batch);
        await this.intake.namedAdmission.exclusive(() => this.store.transact([
          { space: 'receiptRenewals', id: renewal.id, value: { ...renewal, state: 'reserved' } },
          { space: 'batches', id: heightKey(batch.n), value: { batch, publications: [] } },
          { space: 'meta', id: 'v2Last', value: { n: batch.n, to: batch.to } }, { space: 'meta', id: 'draft' }
        ]));
        await pruneDrafts(this.store); await this.reads.retireContexts?.(batch.n); return { renewal };
      }
      const operations = [], final = draft.items.at(-1), state = final.output.state, patterns = final.output.patterns;
      const finds = Object.assign({}, ...draft.items.map(item => rules.recordObject(item.output.state.finds)));
      for (const [id, value] of Object.entries(finds)) { const prior = this.store.get('finds', id); if (prior) { check(rules.stableJSON(prior) === rules.stableJSON(value), 'duplicate_committed_find', 503); continue; } operations.push({ space: 'finds', id, value }, { space: 'findProvenance', id, value: draft.proposal.batch.n }); }
      for (const [id, value] of Object.entries(rules.recordObject(state.types))) operations.push({ space: 'types', id, value });
      for (const [fileIndex, item] of draft.items.entries()) {
        const { file } = item.output;
        for (const [index, input] of (file.financialOperations ?? []).entries()) {
          const location = { n: draft.proposal.batch.n, file: fileIndex, index };
          if (input.transition.type === 'reserve' || input.transition.type === 'reserve-many' || input.transition.action?.type === 'link-reserve') operations.push({ space: 'financialAdmissions', id: input.transition.id, value: location });
          for (const [key] of input.recordCommitments ?? []) operations.push({ space: 'financialRecordProvenance', id: key, value: location });
        }
        for (const [index, input] of (file.mintOperations ?? []).entries()) if (input.op === 'rq' && file.mintOutcomes?.[index]?.reason === 'accepted') {
          operations.push({ space: 'mintAdmissions', id: rules.pendingId(this.intake.network, input.request), value: { n: draft.proposal.batch.n, file: fileIndex, index } });
        }
        for (const discovery of file.discoveries) {
          const asset = discovery.record.key ? rules.patternAssetV2(discovery.record.number) : rules.patternAsset(discovery.record);
          operations.push({ space: 'patternProvenance', id: asset, value: draft.proposal.batch.n });
          if (discovery.record.key) operations.push({ space: 'patternsByAsset', id: asset, value: discovery.record });
        }
        for (const craft of file.crafts) {
          if (!this.store.get('typeProvenance', craft.id)) operations.push({ space: 'typeProvenance', id: craft.id, value: draft.proposal.batch.n });
          if (file.v === 5) operations.push({ space: 'compoundTypes', id: craft.id, value: { ...craft.record, firstMaker: craft.firstMaker } });
        }
        for (const type of file.compoundMerge?.types ?? []) {
          operations.push({ space: 'compoundTypes', id: type.id, value: type });
          if (!type.retired) operations.push({ space: 'typeProvenance', id: type.id, value: draft.proposal.batch.n });
        }
        if (file.compoundMerge) for (const row of rules.COMPOUND_IDENTITY_V4_MERGES.rows) {
          operations.push({ space: 'agentAssets/' + row.holder, id: row.oldId },
            { space: 'agentAssets/' + row.holder, id: row.newId, value: true });
        }
        for (const refinement of file.refinements ?? []) operations.push({ space: 'compoundTiers', id: refinement.asset, value: refinement.progress });
        operations.push(...(item.output.namedWrites ?? []));
        operations.push(...(item.output.claimWrites ?? []));
        operations.push(...(item.output.accountWrites ?? []));
        for (const { move, receipt } of item.originalEntries) operations.push({ space: 'intake/' + item.observation.id, id: move.v === 2 ? rules.uintKeyV2(receipt.sequence) : heightKey(receipt.sequence) },
          ...(move.v === 2 ? [{ space: 'namedAccepted', id: rules.moveIdV2(move), value: { receipt: rules.hashObject(receipt), batch: draft.proposal.batch.n } }]
            : [{ space: 'dedupe', id: rules.moveId(move) }]));
        operations.push({ space: 'blocks', id: heightKey(file.height), value: item.publication }, { space: 'publishedObservations', id: heightKey(file.observation), value: item.publication },
          { space: 'feedEvents', id: heightKey(file.observation), value: { height: file.height, tip: file.tip, finds: Object.fromEntries(file.settlements.flatMap(s => s.winners).map(w => [w.id, finds[w.id]])), types: Object.fromEntries([...file.crafts.map(c => [c.id, file.v === 5 ? { ...c.record, firstMaker: c.firstMaker } : rules.recordGet(state.types, c.id)]), ...(file.compoundMerge?.types ?? []).map(c => [c.id, c])]), crafts: file.crafts, discoveries: file.discoveries, ...(file.transfers ? { transfers: file.transfers } : {}),
            ...(file.v === 5 ? { occurrences: file.occurrences, observation: rules.decimalV2(file.observation), batch: rules.decimalV2(draft.proposal.batch.n), ...(file.refinements ? { refinements: file.refinements } : {}) } : {}),
            links: file.linkOperations.filter((_, i) => file.linkOutcomes[i].reason === 'accepted').map(i => i.request.height),
            agents: [...file.ops.filter(o => o.op === 'xc').map(o => ({ owner: o.request.owner, assets: [...o.request.in, ...o.request.out].map(p => p[0]) })),
              ...file.crafts.filter(c => c.action).map(c => ({ owner: c.action.owner, assets: [...c.action.in, ...c.action.out].map(p => p[0]) })),
              ...(file.transfers ?? []).flatMap(({ action: a }) => [a.owner, a.to].map(owner => ({ owner, assets: [a.asset] })))] } },
          { space: 'observations', id: item.observation.id });
        for (const closure of file.closures ?? []) operations.push({ space: 'windowEligibility', id: heightKey(closure.window), value: closure.draw });
        if (file.v === 5) for (const settlement of file.settlements) for (const kind of ['claims', 'winners', 'headers']) {
          for (const [offset, row] of (settlement[kind] ?? []).entries()) operations.push({ space: `window/${settlement.window}/${kind}`,
            id: `${settlement.root}/${heightKey(settlement.page)}/${heightKey(settlement.from + offset)}`, value: { row, root: settlement.root,
              inputRoot: settlement.inputRoot, batch: draft.proposal.batch.n, audit: item.publication.audit } });
        }
      }
      // The contract already accepted this draft. Cold-index pages can be
      // repeated after a crash before the atomic local acceptance checkpoint.
      this.step = ['archive', Date.now()];
      if (draft.settings.document) for (const item of draft.items) await archiveState(this.store, item.output.state, this.archiveWritePage);
      else await archiveState(this.store, state, this.archiveWritePage);
      operations.push({ space: 'meta', id: 'ruleState', value: hotState(state) }, { space: 'meta', id: 'patterns', value: patterns },
        { space: 'batches', id: heightKey(draft.proposal.batch.n), value: { batch: draft.proposal.batch, publications: draft.items.map(i => i.publication) } },
        { space: 'meta', id: 'latest', value: final.publication }, { space: 'meta', id: 'draft' });
      operations.push(...(this.operations?.acceptedOperations?.(draft) ?? []), ...(this.links?.acceptedOperations(draft) ?? []));
      if (draft.settings.document) operations.push({ space: 'assetCheckpoint', id: 'current', value: assetCheckpoint(state) }, { space: 'meta', id: 'v2Last', value: { n: draft.proposal.batch.n, to: draft.proposal.batch.to } });
      if (draft.proposal.batch.renewal?.kind === 'execute') {
        const renewal = draft.settings.receiptRenewal;
        operations.push(...await publishReceiptRenewal(this, draft));
        const next = rules.advanceReceiptRenewal(renewal, draft.proposal.batch), complete = next.cursor.segment === renewal.cutoff.segmentCount;
        operations.push({ space: 'receiptRenewals', id: renewal.id, value: { ...next, state: complete ? 'consumed' : 'reserved',
          ...(complete ? { consumed: { n: draft.proposal.batch.n, root: draft.proposal.batch.root } } : {}) } });
      }
      operations.push(...acceptedRetention(this.store, draft));
      // Admission counters and their accepted releases share the same lock.
      // A concurrent request cannot be lost between the read and checkpoint.
      const commit = () => payoutGate(this.store, () => {
        const accrued = [...operations, ...new Payouts(this).accruals(draft)];
        const reserved = this.store.get('meta', 'namedReservedBatch');
        if (draft.settings.document && (!reserved || rules.compareUint(reserved, String(draft.proposal.batch.n)) <= 0))
          accrued.push({ space: 'meta', id: 'namedReservedBatch' });
        return this.financial ? this.financial.gate(() => {
          const accepted = [...accrued, ...this.financial.acceptedOperations(draft)];
          return this.store.transact([...accepted, ...publicFinancialOperations(this.store, draft, accepted)]);
        }) : this.store.transact(accrued);
      });
      this.step = ['commit', Date.now()];
      if (this.intake.namedAdmission) await this.intake.namedAdmission.exclusive(commit); else await commit();
      this.step = ['prune', Date.now()];
      await pruneDrafts(this.store);
      this.step = ['retireContexts', Date.now()];
      await this.reads.retireContexts?.(draft.proposal.batch.n);
      this.step = ['payouts', Date.now()];
      await new Payouts(this).publish();
      this.step = ['latest', Date.now()];
      await this.files.json('latest.json', final.publication);
      this.step = ['promote', Date.now()];
      if (speculative) { const next = await speculative; speculative = null; this.speculation = null; await this.promoteSuccessor(draft, next); }
      this.step = ['compact', Date.now()];
      if (await this.store.bytes() > this.store.checkpointBytes) await this.store.compact(); return final.publication;
    } catch (error) { this.speculation = null; throw error; }
    finally { if (speculative && this.speculation?.promise !== speculative) { if (await speculative) this.overlap.discarded++; } this.running = false; this.logSteps(); }
  }
  async close() { await this.speculation?.promise; this.speculation = null; await this.replay.close(); }
}
