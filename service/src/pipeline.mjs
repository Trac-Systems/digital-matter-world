import { pruneDrafts, acceptedRetention } from './retention.mjs';
import { rules, initialState, buildBatch } from './rules.mjs';
import { Payouts } from './payouts.mjs';
import { Replay } from './replay.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { check, heightKey, hash, atomicWrite } from './util.mjs';
import { hotState, archiveState, hydrateState } from './replay-state.mjs';
export class Pipeline {
  constructor({ store, files, history, intake, committee, outbox, reads, operations, links, patterns = [], settings = {}, limits = {}, replay = new Replay() }) {
    Object.assign(this, { store, files, history, intake, committee, outbox, reads, operations, links, patterns, settings, limits, replay });
  }
  async saveDraft(draft) {
    const text = JSON.stringify(draft), digest = hash(text), directory = join(this.store.directory, 'drafts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(join(directory, digest + '.json'), text);
    await this.store.put('meta', 'draft', { version: 3, external: digest, proposal: { batch: draft.proposal.batch } });
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
    const batch = draft.proposal.batch, key = `batch/${batch.epoch}/${batch.n}`;
    const last = await this.reads.batchLast(), epoch = await this.reads.committeeEpoch(), counted = await this.reads.counted?.();
    const root = this.reads.batchRoot ? await this.reads.batchRoot(batch.n) : last.n < batch.n ? null :
      (await this.outbox.transport.status({ op: 'bt', value: batch })).state === 'accepted' ? batch.root : undefined;
    check(rules.stableJSON(last) === rules.stableJSON(await this.reads.batchLast()) && epoch === await this.reads.committeeEpoch(), 'draft_snapshot_changed', 503);
    check(Number.isSafeInteger(epoch) && epoch >= batch.epoch, 'committee_epoch_unavailable', 503);
    // Acceptance takes precedence over expiry or rotation, even if the service
    // crashed before saving its transport receipt or local replay checkpoint.
    if (root === batch.root) return { draft, accepted: true };
    check(root === null && last.n < batch.n, 'draft_batch_conflict', 503);
    if (!draft.signature && !this.store.get('outbox', key) && !this.store.get('sent', key)) {
      const retirement = await this.committee?.retireUnprepared?.(key);
      if (retirement) {
        await this.archiveDraft(draft, { reason: 'preparation_unreserved', epoch, counted, last, root, retirement });
        return { draft: null, accepted: false };
      }
    }
    const expired = Number.isSafeInteger(batch.deadline) && Number.isSafeInteger(counted) && counted > batch.deadline;
    const superseded = epoch > batch.epoch;
    const unreserved = !draft.signature && !this.store.get('ceremonies', key) && !this.store.get('outbox', key) && !this.store.get('sent', key);
    if (superseded || expired || unreserved && counted !== undefined && draft.execution !== counted) {
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
    const last = await this.reads.batchLast(), epoch = await this.reads.committeeEpoch();
    check(Number.isSafeInteger(epoch) && epoch >= 0, 'committee_epoch_unavailable', 503);
    await this.reduceStalled(last);
    const observations = this.store.list('observations', { limit: this.limits.maxObservations ?? 512 }).map(r => r.value);
    if (!observations.length || observations.at(-1).counted <= last.to) return null;
    const execution = await this.reads.counted?.() ?? observations.at(-1).counted;
    if (this.committee.ready && !await this.committee.ready()) return null;
    const contract = await this.reads.settings?.();
    const limits = { ...this.limits, ...(contract ? { maxBytes: contract.batch_bytes, maxOps: contract.batch_ops, maxAssets: contract.batch_assets, maxKv: contract.batch_kv } : {}) };
    const settings = { claimsPerWindow: rules.CLAIM_DEFAULTS.claimsPerWindow, ...this.settings, maxBatchBytes: limits.maxBytes, maxOps: limits.maxOps, maxAssets: limits.maxAssets, maxKv: limits.maxKv, maxMintOps: limits.maxMintOps ?? this.settings.maxMintOps ?? 8 };
    limits.maxMintOps = settings.maxMintOps;
    let state = this.store.get('meta', 'ruleState') ?? initialState(observations[0].tip, observations[0].hash, last.to);
    state = hydrateState(this.store, state, observations);
    let patterns = this.store.get('meta', 'patterns') ?? this.patterns;
    for (const observation of observations) for (const { value: { move } } of this.store.list('intake/' + observation.id, { limit: 1000 })) if (move.t === 'craft') {
      state.balances[move.a] ??= {};
      for (const [asset] of move.p.request.in) state.balances[move.a][asset] ??= await this.reads.balance(move.a, asset);
      state.usedNonces[`${move.a}:${move.p.request.nonce}`] ??= await this.reads.nonceUsed(move.a, move.p.request.nonce);
    }
    const findIds = new Set((state.rounds ?? []).flatMap(r => r.slots.map(s => s.id)));
    for (const observation of observations) for (const { value: { move } } of this.store.list('intake/' + observation.id, { limit: 1000 }))
      if (move.t === 'claim') for (const plot of move.p.plots) for (const pattern of plot.patterns) findIds.add(rules.findId(plot.block, pattern));
    for (const id of findIds) { const find = this.store.get('finds', id); if (find) state.finds[id] = find; }
    const startState = structuredClone(state), startPatterns = structuredClone(patterns), items = [];
    for (const observation of observations) {
      const history = this.history.view?.(observation.tip, observation.hash) ?? this.history;
      const originalEntries = this.store.list('intake/' + observation.id, { limit: 1000 }).map(r => r.value);
      let entries = originalEntries, receiptRoot = observation.receiptRoot, rootAttestations = [], missed = null;
      if (entries.length) {
        try { if (this.store.get('missedReceipts', observation.id)) throw Error('receipt_quorum_unavailable'); rootAttestations = await this.committee.attestRoot(receiptRoot); }
        catch (e) {
          if (e.message !== 'receipt_quorum_unavailable' || (this.intake.head?.highestTip ?? 0) < observation.tip + 2) throw e;
          missed = { observation, entries: originalEntries, reason: 'receipt_witness_window_missed' };
          await this.files.immutable(`records/missed/${observation.id}.json`, Buffer.from(JSON.stringify(missed)));
          await this.store.put('missedReceipts', observation.id, { reason: missed.reason, seal: receiptRoot, path: `/records/missed/${observation.id}.json` });
          entries = []; receiptRoot = rules.sealReceipts([], { network: this.intake.network, tip: observation.tip, hash: observation.hash }, this.intake.secret);
        }
      }
      const view = { observation: (state.observation ?? 0) + 1, height: observation.counted, tip: observation.tip, tipHash: observation.hash };
      const input = { height: observation.counted, executionHeight: execution, blockHash: history.hashAt(observation.counted), tip: observation.tip, tipHash: observation.hash,
        confirmed: Math.min(observation.confirmed, observation.counted), network: this.intake.network, gateway: this.intake.gateway,
        entries, receiptRoot, rootAttestations, priorOperations: rules.budgetOperations(items.map(i => i.output.file)), state: structuredClone(state), patterns, settings, mintOperations: [] };
      const output = await this.replay.run(input, history);
      items.push({ observation, input, output, originalEntries, missed: !!missed }); state = output.state; patterns = output.patterns;
    }
    const headers = this.reads.batchHeaders ? await this.reads.batchHeaders(items.map(i => i.observation)) : items.flatMap(i => i.observation.headers ?? []);
    check(headers.length <= 20, 'header_catchup_required', 503);
    const deadline = rules.batchDeadline(execution);
    const assemble = () => buildBatch({ ...limits, network: this.intake.network, epoch, executionHeight: execution, deadline,
      sequence: last.n + 1, lastTo: last.to, files: items.map(i => i.output.file), headers });
    const final = items.at(-1);
    if ((this.operations || this.links) && execution === final.input.height) {
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
    const built = assemble();
    for (const item of items) { item.publication = await this.files.publish(item.output, { ...item.observation, ...(item.missed ? { receiptSuffix: '-missed' } : {}) }); item.output = { ...item.output, auditBytes: undefined, viewerBytes: undefined }; }
    const draft = { version: 3, execution, last, startState, startPatterns, settings, limits, headers, items,
      proposal: { network: this.intake.network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(b => Buffer.from(b).toString('hex')) } };
    await this.saveDraft(draft); return draft;
  }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      if (!this.reconciled) { await pruneDrafts(this.store); const latest = this.store.get('meta', 'latest'); if (latest) await this.files.json('latest.json', latest); this.reconciled = true; }
      let { draft, accepted } = await this.reconcileDraft(await this.loadDraft());
      draft ??= await this.build(); if (!draft) return;
      const key = `batch/${draft.proposal.batch.epoch}/${draft.proposal.batch.n}`;
      if (!accepted) {
        await this.reads.publishContext?.(draft.proposal.batch.n, draft);
        if (!draft.signature) {
          const signed = await this.committee.signature(key, draft.proposal); if (!signed) return;
          draft.signature = signed.signature.compact; await this.saveDraft(draft);
        }
        await this.outbox.enqueue(key, 'bt', { ...draft.proposal.batch, sig: draft.signature }); await this.outbox.tick();
        if (!this.store.get('sent', key)) return;
      } else if (this.store.get('outbox', key)) {
        await this.store.transact([{ space: 'sent', id: key, value: { id: key, accepted: Date.now(), root: draft.proposal.batch.root } }, { space: 'outbox', id: key }]);
      }
      const operations = [], final = draft.items.at(-1), state = final.output.state, patterns = final.output.patterns;
      const finds = rules.recordObject(state.finds);
      for (const [id, value] of Object.entries(finds)) { const prior = this.store.get('finds', id); if (prior) { check(rules.stableJSON(prior) === rules.stableJSON(value), 'duplicate_committed_find', 503); continue; } operations.push({ space: 'finds', id, value }, { space: 'findProvenance', id, value: draft.proposal.batch.n }); }
      for (const [id, value] of Object.entries(rules.recordObject(state.types))) operations.push({ space: 'types', id, value });
      for (const item of draft.items) {
        const { file } = item.output;
        for (const discovery of file.discoveries) operations.push({ space: 'patternProvenance', id: rules.patternAsset(discovery.record), value: draft.proposal.batch.n });
        for (const craft of file.crafts) if (!this.store.get('typeProvenance', craft.id)) operations.push({ space: 'typeProvenance', id: craft.id, value: draft.proposal.batch.n });
        for (const { move, receipt } of item.originalEntries) operations.push({ space: 'intake/' + item.observation.id, id: heightKey(receipt.sequence) }, { space: 'dedupe', id: rules.moveId(move) });
        operations.push({ space: 'blocks', id: heightKey(file.height), value: item.publication }, { space: 'publishedObservations', id: heightKey(file.observation), value: item.publication },
          { space: 'feedEvents', id: heightKey(file.observation), value: { height: file.height, tip: file.tip, finds: Object.fromEntries(file.settlements.flatMap(s => s.winners).map(w => [w.id, finds[w.id]])), types: rules.recordObject(state.types), crafts: file.crafts, discoveries: file.discoveries,
            links: file.linkOperations.filter((_, i) => file.linkOutcomes[i].reason === 'accepted').map(i => i.request.height),
            agents: file.ops.filter(o => o.op === 'xc').map(o => ({ owner: o.request.owner, assets: [...o.request.in, ...o.request.out].map(p => p[0]) })) } },
          { space: 'observations', id: item.observation.id });
      }
      // The contract already accepted this draft. Cold-index pages can be
      // repeated after a crash before the atomic local acceptance checkpoint.
      await archiveState(this.store, state);
      operations.push({ space: 'meta', id: 'ruleState', value: hotState(state) }, { space: 'meta', id: 'patterns', value: patterns },
        { space: 'batches', id: heightKey(draft.proposal.batch.n), value: { batch: draft.proposal.batch, publications: draft.items.map(i => i.publication) } },
        { space: 'meta', id: 'latest', value: final.publication }, { space: 'meta', id: 'draft' });
      operations.push(...(this.operations?.acceptedOperations?.(draft) ?? []), ...(this.links?.acceptedOperations(draft) ?? []));
      operations.push(...new Payouts(this).accruals(draft), ...acceptedRetention(this.store, draft));
      await this.store.transact(operations);
      await pruneDrafts(this.store);
      await this.reads.retireContexts?.(draft.proposal.batch.n);
      await new Payouts(this).publish();
      await this.files.json('latest.json', final.publication);
      if (await this.store.bytes() > 8_000_000) await this.store.compact(); return final.publication;
    } finally { this.running = false; }
  }
  async close() { await this.replay.close(); }
}
