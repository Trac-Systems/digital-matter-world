import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { NamedStorage } from './named-storage.mjs';
import { Limiter } from './limiter.mjs';
import { buildCreditAccounts } from './account-batch.mjs';

// context() is supplied by the activated pipeline, after its accepted manifest
// and healthy capable quorum checks. It pins the next batch and accepted state.
// R3's sequencer must include all entries in this reserved batch or produce an
// explicit rejection. Switching a batch with admitted entries is not allowed.
export class NamedAdmission {
  constructor({ store, secret, context, history, hashAt, resources, limiter, committee }) {
    rules.validateResourceDocument(resources);
    Object.assign(this, { store, secret, context, history, hashAt, resources, limiter, committee });
    this.limiter ??= new Limiter({ capacity: resources.values.senderCapacity, burst: resources.values.senderBurst,
      perSecond: resources.values.senderPerSecond, ttl: resources.values.senderTtlMs });
    this.persistence = new NamedStorage({ get: id => store.get('namedNodes', id), cacheSize: resources.values.namedNodeCache });
    this.tail = Promise.resolve();
  }
  accept(text) {
    return this.exclusive(() => this.admit(text)).catch(error => {
      if ([429, 503].includes(error.status)) error.retryAfterMs ??= this.resources.values.outboxRetryMs;
      throw error;
    });
  }
  exclusive(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  async acknowledge(id, record) {
    if (!record.witnessPending) return record.receipt;
    const accepted = this.store.get('namedAccepted', id);
    if (accepted) { check(accepted.receipt === rules.hashObject(record.receipt), 'receipt_acceptance_conflict'); return record.receipt; }
    check(this.committee?.acknowledgeReceipt, 'receipt_witness_required', 503);
    const votes = await this.committee.acknowledgeReceipt(record.receipt, this.store.get('meta', 'ruleState')?.claimSnapshot);
    await this.store.transact([{ space: 'namedDedupe', id, value: { receipt: record.receipt, votes } }]);
    return record.receipt;
  }
  async admit(text) {
    const ctx = this.context(); check(ctx?.ruleset === 'dmw-v2', 'ruleset_not_ready', 503);
    const { settings, settingsHistory, batch, tip, counted, acceptedRoot, state: accepted } = ctx;
    check(typeof text === 'string' && Buffer.byteLength(text) <= rules.SETTINGS_CAPABILITIES.moveBytes, 'body_limit', 413);
    let parsed; try { parsed = JSON.parse(text); } catch { throw Error('json_canonical'); }
    check(parsed?.v === 2, 'upgrade_required', 409);
    // An exact retry may refer to an earlier effective revision. Recover its
    // durable receipt before applying today's admission limits to new work.
    const original = settingsHistory.get(parsed.settingsHash);
    const move = rules.parseMoveV2(text, original), id = rules.moveIdV2(move);
    const known = this.store.get('namedDedupe', id); if (known) return this.acknowledge(id, known);
    check(ctx.ready, 'ruleset_not_ready', 503);
    check(!this.store.get('namedFences', move.settingsHash), 'receipt_admission_fenced', 503);
    check(rules.namedStateRoot(accepted) === acceptedRoot, 'admission_state_root');
    rules.uintV2(batch); rules.uintV2(tip); rules.uintV2(counted);
    check(settingsHistory.at(batch, tip) === settings || rules.hashObject(settingsHistory.at(batch, tip)) === rules.hashObject(settings), 'admission_settings');
    check(!ctx.sealed, 'reserved_batch_pending', 503);
    rules.validateMoveV2(move, settings);
    check(!rules.checkMoveV2(move, { settings, tip, hashAt: this.hashAt }), 'invalid_move');
    check(!this.limiter || this.limiter.take(move.a), 'sender_rate', 429);
    const active = this.store.get('meta', 'namedReservedBatch');
    check(!active || active === batch, 'reserved_batch_pending', 503);
    const draft = this.store.get('namedDrafts', batch);
    check(!draft || draft.acceptedRoot === acceptedRoot && draft.settingsHash === rules.hashObject(settings), 'reservation_context_changed', 503);
    const s = settings.values, local = this.resources.values;
    const pairs = (move.p.matches?.length ?? 0) + (move.p.plots?.reduce((n, p) => n + p.patterns.length, 0) ?? 0), reveal = move.t === 'discovery-reveal-v2' ? 1 : 0, challenge = move.t === 'challenge-count-v2' ? 1 : 0;
    const bytes = Buffer.byteLength(text), old = draft?.work ?? { entries: 0, pairs: 0, reveals: 0, challenges: 0, bytes: local.intakeReserveBytes };
    const work = { entries: old.entries + 1, pairs: old.pairs + pairs, reveals: old.reveals + reveal, challenges: old.challenges + challenge, bytes: old.bytes + bytes,
      compoundSteps: (old.compoundSteps ?? 0) + (move.t === 'compound-refine-v2' ? move.p.steps : 0) };
    if (s.closureWorkBudget && ['claim-v2', 'header-v2'].includes(move.t)) {
      const rounds = this.store.get('meta', 'ruleState')?.rounds ?? [];
      const pendingPairs = rounds.reduce((n, r) => n + BigInt(r.closurePairs ?? (r.closed ? 1 : 0)), 0n);
      const pendingBytes = rounds.reduce((n, r) => n + BigInt(r.closureBytes ?? 0), 0n);
      work.closurePairs = (old.closurePairs ?? 0) + (move.t === 'claim-v2' ? pairs + (move.p.header ? 1 : 0) : 1);
      // Include per-row agent/window expansion, beyond the signed packet.
      work.closureBytes = (old.closureBytes ?? 0) + bytes + (move.p.plots?.length ?? 1) * (move.a.length + tip.length + 64);
      const window = move.p.window ?? move.p.height;
      work.closureWindows = [...new Set([...(old.closureWindows ?? []), window])];
      const pendingWindows = new Set([...rounds.map(r => r.window), ...work.closureWindows]);
      check(pendingPairs + BigInt(work.closurePairs) <= BigInt(s.closureBacklogPairs) &&
        pendingBytes + BigInt(work.closureBytes) <= BigInt(s.closureBacklogBytes) &&
        pendingWindows.size <= s.closureBacklogWindows,
      'closure_backlog_capacity', 429);
    } else {
      if (old.closurePairs !== undefined) work.closurePairs = old.closurePairs;
      if (old.closureBytes !== undefined) work.closureBytes = old.closureBytes;
      if (old.closureWindows !== undefined) work.closureWindows = old.closureWindows;
    }
    check(work.compoundSteps <= s.compoundWorkBudget, 'compound_work_budget', 429);
    check(work.entries <= Math.min(local.intakeEntries, s.observationBudget, ctx.segmented ? s.receiptSegmentEntries : Infinity) && work.pairs <= s.namedPairBudget && work.reveals <= s.revealBudget && work.challenges <= s.challengeBudget, 'next_batch_work_capacity', 429);
    check(work.bytes <= s.auditTotalBytes, 'next_batch_byte_capacity', 429);
    const sequence = rules.nextUint(this.store.get('meta', 'namedReceiptSequence') ?? '0');
    const receipt = rules.signReceiptV2(move, { tip, hash: this.hashAt(tip), sequence, batch }, this.secret);
    // Charge receipt and result bytes before acknowledgment as well as packet
    // bytes. The final encoded batch may reserve additional envelope overhead.
    work.bytes += Buffer.byteLength(rules.stableJSON(receipt));
    // Lazy handles belong to their loader's persistence map. Saving handles
    // from context()'s separate loader used to traverse and rewrite the entire
    // accepted catalog and occurrence history on the first move of each batch.
    const starting = draft ? this.persistence.load(draft.snapshot) : ctx.snapshot ? this.persistence.load(ctx.snapshot) : accepted;
    if (!draft) check(rules.namedStateRoot(starting) === acceptedRoot, 'admission_state_root');
    const migration = rules.mergeCompoundCatalogV4(accepted, { network: settings.network, height: counted });
    const prepared = rules.mergeCompoundCatalogV4(starting, { network: settings.network, height: counted }).state;
    const result = rules.executeNamedMove(prepared, {
      move, settings, settingsHistory, tip, counted, receiptPosition: sequence, history: this.history, hashAt: this.hashAt, craftCatalog: migration.state,
      provenance: { batch, receipt: rules.hashObject(receipt), agent: move.a, ruleset: move.ruleset, settingsHash: move.settingsHash }
    });
    const publicResult = { record: result.record ?? null, results: result.results ?? null, challenge: result.challenge ?? null,
      ...(result.craft ? { craft: result.craft } : {}), ...(result.transfers ? { transfers: result.transfers } : {}), ...(result.progress ? { progress: result.progress } : {}) };
    work.bytes += Buffer.byteLength(rules.stableJSON(publicResult));
    check(work.bytes <= s.auditTotalBytes, 'next_batch_byte_capacity', 429);
    if (result.craft || result.transfers) {
      const crafts = [...(draft?.crafts ?? []), ...(result.craft ? [result.craft] : [])];
      const transfers = [...(draft?.transfers ?? []), ...(result.transfers ?? [])];
      // Reserve the whole owner's debits/nonces and account proof capacity
      // before issuing a receipt. These writes remain speculative until the
      // corresponding accepted batch commits them atomically.
      let accounts;
      try { accounts = await buildCreditAccounts({ store: this.store, credits: [], crafts, transfers, compoundMerge: migration.merge, document: settings, height: counted }); }
      catch (error) { if (['account_operation', 'account_operation_bytes', 'account_proof_budget', 'account_leaf_budget'].includes(error.message)) error.status = 429; throw error; }
      check(Buffer.byteLength(rules.stableJSON(accounts.operations)) + s.batchEnvelopeReserveBytes <= s.batchBytes, 'next_batch_account_capacity', 429);
    }
    const saved = this.persistence.save(result.state);
    if (ctx.segmented) {
      const state = this.store.get('meta', 'ruleState'); check(state?.catalogRoot === acceptedRoot, 'admission_state_root');
      // Reserve expanded occurrence records as well as packets before issuing
      // a receipt. Hash-authenticated proof paths stream through a bounded
      // cache, so historical index growth cannot make one packet unadmittable.
      // Each admission reserves only its own expansion. Replaying the whole
      // pending segment on every arrival/refusal makes a busy queue quadratic.
      // Counter widths include all work that this segment could still admit.
      if (move.t === 'claim-v2') {
        const groups = new Map();
        for (const plot of move.p.plots) for (const number of plot.patterns) groups.set(number, (groups.get(number) ?? 0) + 1);
        const pairs = BigInt(s.namedPairBudget), fieldWidth = BigInt(Math.max(String(counted).length, String(0xffffffff).length));
        for (const [number, count] of groups) {
          const key = rules.namedGet(result.state.records, `number/${number}`), record = key && rules.namedGet(result.state.records, `pattern/${key}`);
          if (!record) continue;
          // Reserve every named pattern as a positive occurrence. Execution
          // checks headers and eligibility independently; refusals need no
          // speculative occurrence-tree reads or writes.
          const maximumHeight = BigInt(tip) > BigInt(counted) ? BigInt(tip) : BigInt(counted);
          const unitsPerPair = rules.fieldValueMode(record) ? record.fld === 4 ? maximumHeight : 0xffffffffn : fieldWidth;
          const upper = { ...record, anchor: { height: String(counted), hash: this.hashAt(String(counted)) },
            knownMatchCount: String(BigInt(record.knownMatchCount) + pairs),
            knownOccurrenceTotal: String(BigInt(record.knownOccurrenceTotal) + pairs * unitsPerPair),
            catalogRevision: String(BigInt(result.state.catalogRevision) + pairs + BigInt(s.receiptSegmentEntries)) };
          work.bytes += Math.ceil(count / s.occurrencePageSize) * (Buffer.byteLength(rules.stableJSON({ record: upper, move: receipt.move })) + 1);
        }
      }
      check(work.bytes <= s.auditTotalBytes, 'next_batch_byte_capacity', 429);
    }
    await this.store.transact([...saved.writes,
      { space: 'namedIntake/' + batch, id: rules.uintKeyV2(sequence), value: { move, receipt, result: publicResult } },
      ...(ctx.observation ? [{ space: 'intake/' + ctx.observation, id: rules.uintKeyV2(sequence), value: { move, receipt } }] : []),
      { space: 'namedDedupe', id, value: { receipt, ...(this.committee ? { witnessPending: true } : {}) } },
      { space: 'namedDrafts', id: batch, value: { acceptedRoot, settingsHash: rules.hashObject(settings), resourceHash: rules.hashObject(this.resources), snapshot: saved.snapshot, work,
        crafts: [...(draft?.crafts ?? []), ...(result.craft ? [result.craft] : [])],
        ...(result.transfers || draft?.transfers ? { transfers: [...(draft?.transfers ?? []), ...(result.transfers ?? [])] } : {}) } },
      { space: 'resourceHistory', id: rules.hashObject(this.resources), value: this.resources },
      { space: 'meta', id: 'namedReservedBatch', value: batch }, { space: 'meta', id: 'namedReceiptSequence', value: sequence }
    ]);
    saved.committed(); return this.acknowledge(id, this.store.get('namedDedupe', id));
  }
}
