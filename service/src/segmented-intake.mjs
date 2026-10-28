import { buildPagedReceiptCutoff } from './receipt-cutoff-pages.mjs';
import { Intake } from './intake.mjs';
import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';

// R1 installs this adapter without competing edits to intake.mjs.
export class SegmentedIntake extends Intake {
  constructor(options) {
    const limits = rules.batchSettings(options.settings);
    super({ ...options, maxEntries: options.maxEntries ?? limits.receiptSegmentEntries, auditLimit: options.auditLimit ?? limits.auditPageBytes }); this.settings = limits; this.maxEntries = Math.min(this.maxEntries, limits.receiptSegmentEntries);
    check(this.settings?.batchVersion === 2 && this.settings.ruleset && this.settings.settingsRevision, 'segment_settings');
  }
  seal(options = {}) { check(this.head, 'head_missing'); return this.observe({ ...this.head, force: true }, options); }
  fence({ document, successor, predecessor }) {
    check(this.namedAdmission?.committee, 'receipt_witness_required', 503);
    return this.namedAdmission.exclusive(async () => {
      rules.settingsSuccessor(document, successor);
      const settingsHash = rules.hashObject(document);
      let saved = this.store.get('namedFences', settingsHash);
      if (saved) check(rules.stableJSON(saved.predecessor) === rules.stableJSON(predecessor) &&
        rules.hashObject(saved.successor) === rules.hashObject(successor), 'receipt_cutoff_conflict');
      if (saved?.phase === 'certified') return saved;
      // An ambiguous signing response is not proof that the reserved batch
      // cannot still land. Reconcile it before fixing the accepted predecessor.
      check(!this.store.get('meta', 'draft'), 'receipt_cutoff_draft_pending', 503);
      const state = this.store.get('meta', 'ruleState');
      check(state.claimRoot === predecessor.claims && state.catalogRoot === predecessor.catalog &&
        rules.claimStateRoot(state.claimSnapshot) === predecessor.claims, 'receipt_cutoff_checkpoint');
      if (!saved) {
        saved = { phase: 'closing', document, successor, predecessor, checkpoint: state.claimSnapshot, tail: this.head.id,
          paged: true,
          lastSequence: this.store.get('meta', 'namedReceiptSequence') ?? state.claimSnapshot.hot.namedSequence };
        await this.store.transact([{ space: 'namedFences', id: settingsHash, value: saved }]);
      }
      if (saved.phase === 'closing') {
        check(this.settings.settingsHash === settingsHash && this.head, 'receipt_cutoff_policy');
        saved = { ...saved, phase: 'sealed' };
        await this.observeLocked({ ...this.head, force: true }, { fenceMarker: { space: 'namedFences', id: settingsHash, value: saved } });
      }
      if (!saved.cutoff && saved.paged) {
        saved = await buildPagedReceiptCutoff(this, saved);
        await this.store.transact([{ space: 'namedFences', id: settingsHash, value: saved },
          { space: 'receiptCutoffs', id: rules.hashObject(saved.cutoff), value: { cutoff: saved.cutoff, evidence: saved.evidence } }]);
      }
      if (!saved.cutoff) {
        const segments = []; let after = '';
        for (;;) {
          const page = this.store.list('observations', { after, limit: Math.min(this.store.storePageRows ?? 100, document.values.observationBudget) });
          for (const row of page) {
            if (saved.tail && row.id > saved.tail) break;
            const seal = row.value.receiptRoot;
            check(seal.settingsHash === settingsHash, 'receipt_cutoff_mixed_policy');
            const segment = this.store.get('receiptObservations', rules.receiptSegmentKey(seal));
            check(segment && rules.stableJSON(segment.seal) === rules.stableJSON(seal), 'receipt_cutoff_segment_missing');
            segments.push(segment);
          }
          if (!page.length || saved.tail && page.at(-1).id >= saved.tail) break; after = page.at(-1).id;
        }
        const nodes = new Map();
        // Read only the paths for the unaccepted segments, rooted in the
        // accepted checkpoint. The same proof is checked by every witness.
        const claims = new rules.ClaimStorage({ cacheSize: document.values.proofDepth, get: id => {
          const node = this.store.get('claimNodes', id); if (node) nodes.set(id, node); return node;
        } }).load(state);
        for (const { seal } of segments) rules.recordGet(claims.receiptSegments, `${seal.tip}/${seal.hash}`);
        const evidence = { document, successor, checkpoint: saved.checkpoint, segments, claimEvidence: { nodes: [...nodes] } };
        const cutoff = rules.receiptCutoff({ ...evidence, network: this.network, gateway: this.gateway, predecessor });
        check(cutoff.lastSequence === saved.lastSequence, 'receipt_cutoff_range');
        saved = { ...saved, cutoff, evidence };
        await this.store.transact([{ space: 'namedFences', id: settingsHash, value: saved },
          { space: 'receiptCutoffs', id: rules.hashObject(cutoff), value: { cutoff, evidence } }]);
      }
      // Persist timely certificates while the original window is still open.
      // A later cutoff vote cannot replace a missed receipt witness.
      for (const segment of saved.evidence.segments ?? []) await this.namedAdmission.committee.attestRoot?.(segment.seal);
      const votes = await this.namedAdmission.committee.fenceReceipts(saved.cutoff, saved.evidence);
      saved = { ...saved, phase: 'certified', votes };
      await this.store.transact([{ space: 'namedFences', id: settingsHash, value: saved },
        { space: 'receiptCutoffs', id: rules.hashObject(saved.cutoff), value: { cutoff: saved.cutoff, evidence: saved.evidence, votes } }]);
      return saved;
    });
  }
  observe(head, options = {}) {
    return this.namedAdmission ? this.namedAdmission.exclusive(() => this.observeLocked(head, options)) : this.observeLocked(head, options);
  }
  async observeLocked(head, { financial = false, continuation = false, fenceMarker } = {}) {
    check(!this.rotating, 'tip_transition', 503); this.rotating = true;
    try {
      const clock = rules.ordinalCodec(!!this.settings.document);
      head = { ...head, ...Object.fromEntries(['tip', 'counted', 'confirmed', 'revision'].filter(k => head[k] !== undefined).map(k => [k, clock.value(head[k])])) };
      await Promise.all(this.pending.values());
      if (!head.force && this.head?.hash === head.hash && this.head.tip === head.tip && this.head.counted === head.counted && this.head.confirmed === head.confirmed && this.head.revision === head.revision) return null;
      check(clock.valid(head.tip) && this.hashAt(head.tip) === head.hash, 'head_unverified');
      const observation = clock.add(this.store.get('meta', 'observation') ?? 0);
      const next = { ...head, highestTip: clock.max(this.head?.highestTip ?? head.tip, head.tip), id: heightKey(observation) };
      const ops = [{ space: 'meta', id: 'head', value: next }, { space: 'meta', id: 'observation', value: observation }];
      if (fenceMarker) ops.push(fenceMarker);
      let sealed = null;
      if (this.head) {
        const key = `${this.head.tip}/${this.head.hash}`, previous = this.store.get('receiptSegmentHeads', key), entries = this.entries().map(r => r.value);
        const ruleState = this.store.get('meta', 'ruleState');
        const draftedHeight = this.store.get('meta', 'draft')?.proposal?.batch?.to ?? -1;
        if (fenceMarker || financial || continuation || entries.length || !previous || clock.compare(this.head.counted, clock.max(ruleState?.counted ?? -1, draftedHeight)) > 0 || ruleState?.rounds?.some(r => r.closed || r.closing)) {
        const receiptRoot = rules.sealReceiptSegment(entries.map(e => e.receipt), { network: this.network, tip: this.head.tip, hash: this.head.hash,
          segment: previous ? rules.nextUint(rules.decimalV2(previous.segment)) : '0', previous: previous?.hash ?? null, ruleset: this.settings.ruleset, settingsRevision: this.settings.settingsRevision,
          ...(this.settings.settingsHash ? { settingsHash: this.settings.settingsHash } : {}) }, this.secret);
        sealed = { ...this.head, receiptRoot, count: entries.length };
        ops.push({ space: 'observations', id: this.head.id, value: sealed },
          { space: 'receiptObservations', id: rules.receiptSegmentKey(receiptRoot), value: { seal: receiptRoot, receipts: entries.map(e => e.receipt) } },
          { space: 'receiptSegmentHeads', id: key, value: { segment: receiptRoot.segment, hash: rules.receiptSegmentHash(receiptRoot) } });
        }
      }
      await this.store.transact(ops); this.head = next; this.count = 0; this.reveals = 0; this.crafts = 0; this.strings.clear(); this.reserved = this.resources.intakeReserveBytes;
      return sealed;
    } finally { if (!this.store.failed) this.rotating = false; }
  }
}
