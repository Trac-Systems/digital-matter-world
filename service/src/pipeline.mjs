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
import { readPublicWinner, publicClaimReaders } from './public-claim-readers.mjs';
export class Pipeline {
  constructor({ store, files, history, intake, committee, outbox, reads, operations, links, financial, patterns = [], settings = {}, limits = {}, replay = new Replay(), archiveWritePage = 256, pipelineDepth = 1 }) {
    Object.assign(this, { store, files, history, intake, committee, outbox, reads, operations, links, financial, patterns, settings, limits, replay, archiveWritePage });
    check([1, 2].includes(pipelineDepth), 'pipeline_depth'); this.pipelineDepth = pipelineDepth;
    this.overlap = { started: 0, promoted: 0, discarded: 0, failed: 0, buildMs: 0, overlapMs: 0 };
    this.replay.resources ??= intake?.namedAdmission?.resources;
  }
  async saveDraft(draft) {
    const text = JSON.stringify(draft), digest = hash(text), directory = join(this.store.directory, 'drafts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(join(directory, digest + '.json'), text);
    const save = () => {
      check(!draft.settings?.document || !this.store.get('namedFences', draft.settings.settingsHash) || draft.proposal.batch.renewal,
        'receipt_admission_fenced', 503);
      return this.store.put('meta', 'draft', { version: 3, external: digest, proposal: { batch: draft.proposal.batch } });
    };
    if (this.intake?.namedAdmission) await this.intake.namedAdmission.exclusive(save); else await save();
    await pruneDrafts(this.store);
  }
  async loadDraft() {
    const saved = this.store.get('meta', 'draft'); if (!saved) return null;
    check(/^[0-9a-f]{64}$/.test(saved.external), 'draft_reference');
    const text = await readFile(join(this.store.directory, 'drafts', saved.external + '.json'), 'utf8');
    check(hash(text) === saved.external, 'draft_checksum'); return JSON.parse(text);
  }
  async archiveDraft(draft, proof) {
    const batch = draft.proposal.batch, key = `batch/${batch.epoch}/${batch.n}`, id = hash(rules.stableJSON(batch));
    const evidence = JSON.stringify({ draft, ceremony: this.store.get('ceremonies', key), outbox: this.store.get('outbox', key), sent: this.store.get('sent', key) });
    const directory = join(this.store.directory, 'retired-drafts'); await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(join(directory, id + '.json'), evidence);
    await this.store.transact([
      { space: 'supersededDrafts', id, value: { state: 'RETIRED', proof, batch, evidence: { id, hash: hash(evidence) } } },
      ...['ceremonies', 'outbox', 'sent'].map(space => ({ space, id: key })), { space: 'meta', id: 'draft' }
    ]);
  }
  async reconcileDraft(draft) {
    if (!draft) return { draft: null, accepted: false };
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
    if (!draft.signature && !this.store.get('outbox', key) && !this.store.get('sent', key)) {
      const retirement = await this.committee?.retireUnprepared?.(key);
      if (retirement) {
        await this.archiveDraft(draft, { reason: 'preparation_unreserved', epoch, counted, last, root, retirement });
        return { draft: null, accepted: false };
      }
    }
    const expired = counted !== undefined && clock.valid(batch.deadline) && clock.compare(counted, batch.deadline) > 0;
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
  async build() {
    if (this.recovery?.active()) return null;
    // Reconciliation may have retired an old unsigned draft since the poller
    // last refreshed policy. Fence its acknowledged receipts before rebuilding.
    if (!this.speculative) await this.intake.prepareBatch?.();
    const clock = rules.ordinalCodec(!!this.settings.document);
    const last = await this.reads.batchLast(), epoch = clock.value(await this.reads.committeeEpoch());
    check(clock.valid(epoch), 'committee_epoch_unavailable', 503);
    const version2 = this.settings.batchVersion === 2;
    const renewal = this.settings.receiptRenewal;
    const fence = this.settings.document && this.store.get('namedFences', this.settings.settingsHash);
    if (fence && !renewal) return this.buildReceiptRenewal(fence);
    if (version2 && this.financial) this.financial.document = this.settings.document;
    if (!version2) await this.reduceStalled(last);
    if (version2 && !renewal && BigInt(this.store.countUint('observations')) < BigInt(rules.batchSettings(this.settings).observationsPerBatch)) {
      const free = this.intake.count || this.store.get('meta', 'namedReservedBatch') || this.store.get('meta', 'ruleState')?.rounds?.some(r => r.closed || r.closing);
      const financial = !free && !this.store.hasRows('observations') && await this.financial?.ready({ height: this.intake.head?.counted, at: { counted: this.intake.head?.counted, last } });
      if (free || financial) await this.intake.seal({ financial: !!financial });
    }
    let observations = this.store.list('observations', { limit: renewal ? Math.min(Number(BigInt(renewal.cutoff.segmentCount) - BigInt(renewal.cursor.segment)), rules.batchSettings(this.settings).maxObservations) : version2 ? rules.batchSettings(this.settings).observationsPerBatch : this.limits.maxObservations ?? 512 }).map(r => r.value);
    if (!observations.length || (!version2 && observations.at(-1).counted <= last.to)) return null;
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
    if (this.committee.ready && !await this.committee.ready({ counted: execution, tip: observations.reduce((n, o) => clock.max(n, o.tip), clock.zero) })) return null;
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
      let entries = originalEntries, receiptRoot = observation.receiptRoot, rootAttestations = [], missed = null;
      if (entries.length || version2) {
        try { if (this.store.get('missedReceipts', observation.id)) throw Error('receipt_quorum_unavailable'); rootAttestations = await this.committee.attestRoot(receiptRoot); }
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
      }
      const publicClaimsActive = settings.document && rules.claimsNeverCloseActive(settings, execution);
      const publicMintRead = (asset, block) => readPublicWinner({ store: accountStore, reads: this.reads, at: { counted: execution, last } }, asset, block);
      const claimReads = settings.document ? { store: this.store, staged: claimNodes, namedStaged: accountStore.spaces.get('namedNodes'),
        ...(publicClaimsActive ? { publicMintGet: publicMintRead } : {}) } : undefined;
      const replay = async () => {
        const { claimEvidence, namedEvidence, ...output } = await this.replay.run(input, history, claimReads);
        if (claimEvidence) input.claimEvidence = claimEvidence;
        if (namedEvidence) input.namedEvidence = namedEvidence;
        if (publicClaimsActive) input.publicMintEvidence = output.file.publicMintEvidence;
        // Keep proof tables once in the input, rather than serializing another
        // full copy into every persisted output/draft.
        return output;
      };
      let output = await replay();
      if (settings.document) {
        for (;;) {
          try {
            const publicReaders = publicClaimsActive ? publicClaimReaders({ input, store: accountStore, claimNodes, publicMintRead }) : undefined;
            const publicClaims = publicReaders && rules.publicClaimProjection(output, input, publicReaders.readers);
            const accounts = this.financial && !renewal && !anchored && clock.compare(execution, observation.counted) === 0
              ? await this.financial.build({ credits: output.file.ops, crafts: output.file.crafts, transfers: output.file.transfers, height: observation.counted, at: { counted: execution, last }, accountStore,
                ...(publicClaims ? { publicClaims, preparePublicMint: publicReaders.prepare } : {}),
                priorLinkInputs: items.reduce((n, i) => n + (i.output.file.financialOperations ?? []).filter(f => f.transition.action?.type?.startsWith('link-')).length, 0),
                excluded: financialIncluded, remaining: settings.document.values.mintOperationBudget - financialIncluded.size, priorOperations: input.priorOperations,
                priorAssetTouches: items.reduce((n, i) => n + (i.output.accountAssetTouches ?? 0), 0) })
              : await buildCreditAccounts({ store: accountStore, credits: output.file.ops, crafts: output.file.crafts, transfers: output.file.transfers, document: settings.document, height: observation.counted });
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
      for (const input of output.file.financialOperations ?? []) if (input.transition.type === 'reserve' || input.transition.action?.type === 'link-reserve')
        accountStore.financialReservations.set(input.transition.id, input.evidence);
      for (const i of output.file.financialOperations ?? []) financialIncluded.add(rules.hashObject(['dmw-financial-transition-v2', i.transition]));
      items.push({ observation, input, output, originalEntries, missed: !!missed }); state = output.state; patterns = output.patterns;
      for (const row of output.claimWrites ?? []) claimNodes.set(row.id, row.value);
    }
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
    const overlay = successorStore(this.store, predecessor);
    const more = predecessor.items.at(-1).output.state.rounds?.some(r => r.closed || r.closing);
    if (!overlay.store.hasRows('observations') && !more) return null;
    // Admission remains pinned to the accepted head. Only witnessed, empty
    // continuation segments can be introduced while that head is in flight.
    if (!overlay.store.hasRows('observations')) {
      if (this.intake.count || this.intake.rotating) return null;
      await this.intake.seal({ continuation: true });
    }
    // Receipt witnessing refreshes each signer's evidence lease. Finish it
    // before asking those signers to audit the predecessor; only local build
    // and replay overlap the signing lane.
    const certificates = new Map();
    for (const { value: observation } of overlay.store.list('observations', { limit: rules.batchSettings(this.settings).observationsPerBatch }))
      certificates.set(rules.hashObject(observation.receiptRoot), await this.committee.attestRoot(observation.receiptRoot));
    const builder = Object.assign(Object.create(Pipeline.prototype), this, { store: overlay.store, speculative: true,
      committee: { ...this.committee, attestRoot: async root => { const certificate = certificates.get(rules.hashObject(root)); check(certificate, 'speculative_receipt_changed'); return certificate; } },
      predecessorClaimNodes: overlay.claimNodes, predecessorNamedNodes: overlay.namedNodes, financial: null,
      settings: structuredClone(this.settings),
      intake: { ...this.intake, seal: async () => null },
      reads: { ...this.reads, batchLast: async () => last, batchRoot: async n => String(n) === String(last.n) ? predecessor.proposal.batch.root : this.reads.batchRoot(n) }
    });
    return async () => {
      this.overlap.started++; const started = performance.now();
      try { return await builder.build(); }
      finally { this.overlap.buildMs += performance.now() - started; }
    };
  }
  async promoteSuccessor(predecessor, draft) {
    if (!draft) return;
    const last = await this.reads.batchLast(), epoch = await this.reads.committeeEpoch(), counted = await this.reads.counted();
    const reason = await this.reads.batchRoot(predecessor.proposal.batch.n) !== predecessor.proposal.batch.root ? 'acceptance' :
      successorMismatch({ predecessor, draft, last, epoch, counted, settings: this.settings,
        state: this.store.get('meta', 'ruleState'), hashAt: h => this.history.hashAt(h) });
    if (reason) { this.overlap.discarded++; this.overlap.discardReasons ??= {}; this.overlap.discardReasons[reason] = (this.overlap.discardReasons[reason] ?? 0) + 1; return; }
    const active = await this.reads.rulesContext?.();
    if (active && rules.hashObject(rules.effectiveSettings(active.settings, active.scheduledSettings, String(draft.proposal.batch.n), String(draft.execution))) !== draft.settings.settingsHash) {
      this.overlap.discarded++; return;
    }
    await this.publishDraft(draft); await this.saveDraft(draft); this.overlap.promoted++;
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
      let { draft, accepted } = await this.reconcileDraft(await this.loadDraft());
      if (speculative && (!draft || this.speculation.proposalHash !== hash(JSON.stringify(draft.proposal)))) {
        if (await speculative) this.overlap.discarded++; this.speculation = null; speculative = null;
      }
      draft ??= await this.build(); if (!draft) return;
      const key = `batch/${draft.proposal.batch.epoch}/${draft.proposal.batch.n}`;
      if (!accepted) {
        await this.reads.publishContext?.(draft.proposal.batch.n, draft);
        if (!draft.signature) {
          const buildNext = await this.prepareSuccessor(draft).catch(() => { this.overlap.failed++; return null; });
          const started = performance.now();
          if (buildNext) speculative = buildNext().then(next => { this.overlap.overlapMs += Math.max(0, Math.min(performance.now(), signingEnded ?? Infinity) - started); return next; })
            .catch(() => { this.overlap.failed++; return null; });
          const signed = await this.committee.signature(key, draft.proposal); signingEnded = performance.now(); if (!signed) return;
          draft.signature = signed.signature.compact; await this.saveDraft(draft);
          if (speculative) this.speculation = { proposalHash: hash(JSON.stringify(draft.proposal)), promise: speculative };
        }
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
          if (input.transition.type === 'reserve' || input.transition.action?.type === 'link-reserve') operations.push({ space: 'financialAdmissions', id: input.transition.id, value: location });
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
        for (const refinement of file.refinements ?? []) operations.push({ space: 'compoundTiers', id: refinement.asset, value: refinement.progress });
        operations.push(...(item.output.namedWrites ?? []));
        operations.push(...(item.output.claimWrites ?? []));
        operations.push(...(item.output.accountWrites ?? []));
        for (const { move, receipt } of item.originalEntries) operations.push({ space: 'intake/' + item.observation.id, id: move.v === 2 ? rules.uintKeyV2(receipt.sequence) : heightKey(receipt.sequence) },
          ...(move.v === 2 ? [{ space: 'namedAccepted', id: rules.moveIdV2(move), value: { receipt: rules.hashObject(receipt), batch: draft.proposal.batch.n } }]
            : [{ space: 'dedupe', id: rules.moveId(move) }]));
        operations.push({ space: 'blocks', id: heightKey(file.height), value: item.publication }, { space: 'publishedObservations', id: heightKey(file.observation), value: item.publication },
          { space: 'feedEvents', id: heightKey(file.observation), value: { height: file.height, tip: file.tip, finds: Object.fromEntries(file.settlements.flatMap(s => s.winners).map(w => [w.id, finds[w.id]])), types: Object.fromEntries(file.crafts.map(c => [c.id, file.v === 5 ? { ...c.record, firstMaker: c.firstMaker } : rules.recordGet(state.types, c.id)])), crafts: file.crafts, discoveries: file.discoveries, ...(file.transfers ? { transfers: file.transfers } : {}),
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
      if (draft.settings.document) for (const item of draft.items) await archiveState(this.store, item.output.state, this.archiveWritePage);
      else await archiveState(this.store, state, this.archiveWritePage);
      operations.push({ space: 'meta', id: 'ruleState', value: hotState(state) }, { space: 'meta', id: 'patterns', value: patterns },
        { space: 'batches', id: heightKey(draft.proposal.batch.n), value: { batch: draft.proposal.batch, publications: draft.items.map(i => i.publication) } },
        { space: 'meta', id: 'latest', value: final.publication }, { space: 'meta', id: 'draft' });
      operations.push(...(this.operations?.acceptedOperations?.(draft) ?? []), ...(this.links?.acceptedOperations(draft) ?? []));
      if (draft.settings.document) operations.push({ space: 'assetCheckpoint', id: 'current', value: assetCheckpoint(state) }, { space: 'meta', id: 'namedReservedBatch' }, { space: 'meta', id: 'v2Last', value: { n: draft.proposal.batch.n, to: draft.proposal.batch.to } });
      if (draft.proposal.batch.renewal?.kind === 'execute') {
        const renewal = draft.settings.receiptRenewal;
        operations.push(...await publishReceiptRenewal(this, draft));
        const next = rules.advanceReceiptRenewal(renewal, draft.proposal.batch), complete = next.cursor.segment === renewal.cutoff.segmentCount;
        operations.push({ space: 'receiptRenewals', id: renewal.id, value: { ...next, state: complete ? 'consumed' : 'reserved',
          ...(complete ? { consumed: { n: draft.proposal.batch.n, root: draft.proposal.batch.root } } : {}) } });
      }
      operations.push(...new Payouts(this).accruals(draft), ...acceptedRetention(this.store, draft));
      // Admission counters and their accepted releases share the same lock.
      // A concurrent request cannot be lost between the read and checkpoint.
      const commit = () => this.financial ? this.financial.gate(() => {
        const accepted = [...operations, ...this.financial.acceptedOperations(draft)];
        return this.store.transact([...accepted, ...publicFinancialOperations(this.store, draft, accepted)]);
      }) : this.store.transact(operations);
      if (this.intake.namedAdmission) await this.intake.namedAdmission.exclusive(commit); else await commit();
      await pruneDrafts(this.store);
      await this.reads.retireContexts?.(draft.proposal.batch.n);
      await new Payouts(this).publish();
      await this.files.json('latest.json', final.publication);
      if (speculative) { const next = await speculative; speculative = null; this.speculation = null; await this.promoteSuccessor(draft, next); }
      if (await this.store.bytes() > this.store.checkpointBytes) await this.store.compact(); return final.publication;
    } catch (error) { this.speculation = null; throw error; }
    finally { if (speculative && this.speculation?.promise !== speculative) { if (await speculative) this.overlap.discarded++; } this.running = false; }
  }
  async close() { await this.speculation?.promise; this.speculation = null; await this.replay.close(); }
}
