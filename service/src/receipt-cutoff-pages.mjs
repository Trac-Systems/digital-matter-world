import { rules } from './rules.mjs';
import { check } from './util.mjs';

// Materialize one immutable segment/proof page per durable checkpoint, then
// link the pages backwards. Reopening never repeats the whole backlog or
// allocates one aggregate evidence object. The admission lock seals the tail.
export async function buildPagedReceiptCutoff(intake, saved) {
  const { store } = intake, { document, predecessor, successor } = saved, settingsHash = rules.hashObject(document);
  const domain = { network: intake.network, gateway: intake.gateway, predecessor, settingsHash };
  let progress = saved.pages ?? { phase: 'forward', after: '', index: '0', sequence: saved.checkpoint.hot.namedSequence,
    claims: predecessor.claims, checkpoint: saved.checkpoint };
  const persist = async (operations, next) => {
    progress = next; saved = { ...saved, pages: progress };
    await store.transact([...operations, { space: 'namedFences', id: settingsHash, value: saved }]);
  };
  while (progress.phase === 'forward') {
    const row = store.list('observations', { after: progress.after, limit: 1 })[0];
    if (!row || row.id > saved.tail) {
      check(progress.sequence === saved.lastSequence, 'receipt_cutoff_range');
      await persist([], { ...progress, phase: 'reverse', remaining: progress.index, chain: rules.RECEIPT_CUTOFF_END });
      break;
    }
    const seal = row.value.receiptRoot, segment = store.get('receiptObservations', rules.receiptSegmentKey(seal));
    check(segment && rules.stableJSON(segment.seal) === rules.stableJSON(seal), 'receipt_cutoff_segment_missing');
    const nodes = new Map();
    const state = new rules.ClaimStorage({ cacheSize: document.values.proofDepth, get: id => {
      const node = store.get('receiptFenceNodes', id) ?? store.get('claimNodes', id); if (node) nodes.set(id, node); return node;
    } }).load({ claimSnapshot: progress.checkpoint, claimRoot: progress.claims });
    rules.recordGet(state.receiptSegments, `${seal.tip}/${seal.hash}`);
    const page = { index: progress.index, observation: row.id, segment, checkpoint: progress.checkpoint, claimEvidence: { nodes: [...nodes] } };
    const result = rules.verifyReceiptCutoffPage(domain, document, progress, page);
    // Timely evidence is retained before advancing the durable page cursor.
    await intake.namedAdmission.committee.attestRoot?.(seal);
    await persist([...result.writes.map(w => ({ ...w, space: 'receiptFenceNodes' })),
      { space: 'receiptCutoffPages', id: rules.receiptCutoffPageKey(settingsHash, progress.index), value: page }],
    { ...progress, ...result.progress, checkpoint: result.checkpoint, after: row.id });
  }
  while (progress.remaining !== '0') {
    const index = String(BigInt(progress.remaining) - 1n), id = rules.receiptCutoffPageKey(settingsHash, index), page = store.get('receiptCutoffPages', id);
    check(page?.index === index, 'receipt_cutoff_page_missing');
    const chain = rules.receiptCutoffLink(index, page.segment.seal, progress.chain);
    await persist([{ space: 'receiptCutoffPages', id, value: { ...page, next: progress.chain } }], { ...progress, remaining: index, chain });
  }
  const cutoff = { v: 2, ...domain, successorHash: rules.hashObject(successor), acceptedSequence: saved.checkpoint.hot.namedSequence,
    lastSequence: saved.lastSequence, segments: progress.chain, segmentCount: progress.index };
  const evidence = { document, successor, checkpoint: saved.checkpoint, paged: true };
  return { ...saved, cutoff, evidence };
}

export function storedRenewalSlice(store, renewal, segments, document) {
  if (renewal.cutoff.v === 1) return rules.buildRenewalSlice(renewal, segments, store.get('receiptCutoffs', renewal.id).evidence.segments, document);
  const rows = segments.map((s, i) => {
    const row = store.get('receiptCutoffPages', rules.receiptCutoffPageKey(renewal.cutoff.settingsHash, rules.addUint(renewal.cursor.segment, String(i))));
    check(row && rules.stableJSON(row.segment) === rules.stableJSON(s), 'renewal_members'); return row;
  });
  return rules.validateRenewalSlice(renewal, { from: renewal.cursor.segment, to: rules.addUint(renewal.cursor.segment, String(rows.length)),
    sequence: segments.flatMap(s => s.receipts).at(-1)?.sequence ?? renewal.cursor.sequence,
    seals: segments.map(s => s.seal), next: rows.at(-1)?.next }, document);
}
