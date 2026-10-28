import { rules as r } from './rules.mjs';
import { check } from './util.mjs';

// Reconcile acknowledged legacy receipts at the import boundary. This does
// not pretend their old draft was accepted. The new terminal import commits
// their exact receipts and derived carryover dispositions explicitly.
export function carryPendingReceipts({ store, rows, original, patterns, network, gateway, history, hashAt, anchor, legacySettings }) {
  const dedupe = rows.filter(([space]) => space === 'dedupe');
  const head = store.get('meta', 'head');
  const active = new Set([...(head ? [head.id] : []), ...rows.filter(([space]) => space === 'observations').map(([, id]) => id)]);
  const pendingEntries = rows.filter(([space]) => space.startsWith('intake/') && active.has(space.slice(7)));
  check(pendingEntries.length === dedupe.length && pendingEntries.every(([, , e]) => dedupe.some(([, id]) => id === r.moveId(e.move))), 'pending_receipt_coverage');
  if (dedupe.length) check(r.hex(gateway, 32) && history && typeof hashAt === 'function', 'pending_receipt_readers_required');
  const state = structuredClone(original), entries = [], writes = [], receipts = [], seen = new Set();
  const intake = new Map(rows.filter(([space]) => space.startsWith('intake/')).map(([space, id, value]) => [`${space}/${id}`, value]));
  for (const [, id, row] of dedupe) {
    const entry = intake.get(`intake/${row.observation}/${String(row.receipt.sequence).padStart(16, '0')}`);
    check(entry && r.moveId(entry.move) === id && r.stableJSON(entry.receipt) === r.stableJSON(row.receipt), 'pending_receipt_coverage');
    entries.push({ id, ...entry });
  }
  for (const entry of entries.sort((a, b) => a.receipt.sequence - b.receipt.sequence)) {
    const { move, receipt, id } = entry;
    check(!seen.has(receipt.sequence) && r.legacyRules.verifyReceipt(receipt, move, { network, gateway, hashAt }), 'pending_receipt_signature');
    seen.add(receipt.sequence);
    check(receipt.tip <= Number(anchor.height), 'pending_receipt_future');
    const certificate = store.get('receiptCertificates', `${receipt.tip}/${receipt.hash}`);
    if (Number(anchor.height) >= receipt.tip + 2) {
      const observation = store.get('receiptObservations', `${receipt.tip}/${receipt.hash}`);
      check(certificate && observation && r.stableJSON(certificate.seal) === r.stableJSON(observation.seal) &&
        observation.receipts.some(row => r.stableJSON(row) === r.stableJSON(receipt)) &&
        r.legacyRules.verifyReceiptRoot(certificate.seal, observation.receipts, { network, gateway, tip: receipt.tip, hash: receipt.hash }) &&
        Array.isArray(legacySettings.receiptSigners) && r.legacyRules.verifyRootAttestations(certificate.seal, certificate.attestations, legacySettings.receiptSigners),
      'pending_receipt_certificate_required');
    }
    let reason = r.legacyRules.checkMove(move, { network, tip: receipt.tip, hashAt, puzzleBits: legacySettings.puzzleBits ?? 12,
      freshness: legacySettings.freshness ?? 2 });
    check(['discovery-commit', 'discovery-reveal', 'claim', 'header'].includes(move.t), 'pending_receipt_drain_required');
    if (!reason) {
      if (move.t === 'discovery-commit') {
        state.discoveryCommits ??= [];
        if (!state.discoveryCommits.some(c => c.agent === move.a && c.commitment === move.p.commitment))
          state.discoveryCommits.push({ agent: move.a, commitment: move.p.commitment, tip: receipt.tip });
      } else if (move.t === 'discovery-reveal') {
        // Use the exact old opening/window validation. No history evaluation
        // runs here; the accepted opening becomes a named-evidence attachment.
        try { r.legacyRules.queueDiscovery(state, move, receipt.tip, receipt.tip, patterns, hashAt(receipt.tip)); }
        catch (error) { reason = error.message; }
      } else {
        const window = move.t === 'header' ? move.p.height : move.p.window;
        let event = state.rounds.find(e => e.window === window);
        if (!event && window > (original.lastTip ?? -1)) {
          event = { window, windowHash: hashAt(window), claimableHeight: Math.min(Number(anchor.height), window),
            slots: r.legacyRules.slotsFor(history.get(window), patterns), claims: [], headerSenders: [], closed: false, seedHash: null };
          state.rounds.push(event);
        }
        if (!event || event.closed || !r.legacyRules.claimWindow(window, receipt.tip)) reason = 'claim_window';
        else {
          const header = move.t === 'header' ? move.p : move.p.header;
          if (header && (header.height !== window || r.parseHeader(header.raw).hash !== hashAt(window))) reason = 'header_mismatch';
          if (!reason && move.t === 'claim' && !move.p.plots.every(p => p.block <= event.claimableHeight || p.block === window)) reason = 'not_counted';
          if (!reason && move.t === 'claim' && move.p.plots.some(p => p.patterns.some(n =>
            store.get('finds', r.legacyRules.findId(p.block, n)) || r.recordGet(original.finds, r.legacyRules.findId(p.block, n))))) reason = 'already_found';
          if (!reason) {
            if (header && !event.headerSenders.some(s => s.agent === move.a)) event.headerSenders.push({ block: window, agent: move.a });
            if (move.t === 'claim') {
              const known = new Set(event.slots.map(s => s.id));
              for (const p of move.p.plots) {
                event.claims.push({ agent: move.a, window, ...p });
                for (const slot of r.legacyRules.slotsFor(history.get(p.block), patterns.filter(q => p.patterns.includes(q.number))))
                  if (!known.has(slot.id)) { known.add(slot.id); event.slots.push(slot); }
              }
            }
          }
        }
      }
    }
    receipts.push({ id, move, receipt, outcome: reason ?? 'carried' });
    writes.push({ space: 'legacyReceiptResults', id, value: receipts.at(-1) });
  }
  if (state.rounds.length) {
    state.lastTip = Math.max(state.lastTip ?? -1, ...state.rounds.map(e => e.window));
    state.highestTip = Math.max(state.highestTip ?? -1, state.lastTip);
  }
  for (const [space, id, value] of rows) if (space === 'observations') writes.push(
    { space: 'legacyObservations', id, value }, { space, id });
  if (head) writes.push({ space: 'meta', id: 'legacyHead', value: head }, { space: 'meta', id: 'head' });
  return { state, receipts, writes };
}
