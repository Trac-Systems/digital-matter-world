import { assert, findId, hashObject } from './core.js';
import { findIdV2, safeNumberV2 } from './integers-v2.js';
import { recordGet, recordSet } from './record-index.js';
import { settleClaims } from '../legacy/v1/rules/src/claims.js';
import { boundedPages } from './claims-paged.js';
import { encodeBinary } from './binary.js';
import { merkleRoot } from './merkle.js';
import { publicTaken } from './public-claims.js';

// Only the terminal importer creates these rounds. The old slot IDs remain
// the lottery domain, even though the continuation uses decimal IDs/pages.
export function freezeLegacyClaimWindow({ state, event, decidingHash, counted, settings }) {
  const original = event.legacy;
  assert(original && !event.closed && BigInt(counted) >= BigInt(event.window) + 2n, 'legacy_draw_not_ready');
  const claims = [], slots = new Map(), finds = {}, senders = [];
  for (let i = 0n; i < BigInt(event.inputPages); i++) {
    const page = recordGet(state.claimInputs, `${event.window}/${i}`);
    assert(page, 'claim_input_missing');
    for (const c of page.claims) {
      const claim = { ...c, window: safeNumberV2(c.window), block: safeNumberV2(c.block), patterns: c.patterns.map(safeNumberV2) };
      claims.push(claim);
      for (const number of c.patterns) {
        const id = findIdV2(c.block, number), slot = recordGet(state.claimSlots, `${event.window}/${id}`);
        if (slot) slots.set(id, slot);
        if (recordGet(state.finds, id) || recordGet(state.claimReservations, id) || slot && state.publicMintGet && publicTaken(state, slot)) finds[findId(claim.block, safeNumberV2(number))] = true;
      }
    }
  }
  for (const id of original.tipSlots) {
    const slot = recordGet(state.claimSlots, `${event.window}/${id}`); assert(slot, 'claim_input_missing'); slots.set(id, slot);
    if (recordGet(state.finds, id) || recordGet(state.claimReservations, id) || state.publicMintGet && publicTaken(state, slot)) finds[findId(safeNumberV2(slot.block), safeNumberV2(slot.pattern))] = true;
  }
  for (let i = 0n; i < BigInt(event.headerCount); i++) {
    const agent = recordGet(state.headerInputs, `${event.window}/${i}`); assert(agent, 'header_input_missing');
    senders.push({ block: safeNumberV2(event.window), agent });
  }
  const result = settleClaims({ window: safeNumberV2(event.window), counted: safeNumberV2(counted), decidingHash,
    claimableHeight: safeNumberV2(event.claimableHeight), claims, finds, headerSenders: senders,
    settings: { claimsPerWindow: original.claimsPerWindow },
    slots: [...slots.values()].map(s => ({ ...s, id: findId(safeNumberV2(s.block), safeNumberV2(s.pattern)), block: safeNumberV2(s.block), pattern: safeNumberV2(s.pattern) })) });
  const winners = result.winners.map(({ claimers, ...w }) => ({ ...w, legacyId: w.id, id: findIdV2(String(w.block), String(w.pattern)),
    block: String(w.block), pattern: String(w.pattern), tickets: String(claimers.length) }));
  const pages = [...boundedPages(result.claims, 'claims', settings), ...boundedPages(winners, 'winners', settings)];
  for (let i = 0; i < pages.length; i++) state.settlementPages = recordSet(state.settlementPages, `${event.window}/${i}`, pages[i]);
  for (const w of winners) state.claimReservations = recordSet(state.claimReservations, w.id, { window: event.window, winner: w.winner });
  event.root = merkleRoot(pages.map(encodeBinary)); event.inputRoot = hashObject(['dmw-legacy-claim-inputs', original, claims, senders]);
  event.pages = String(pages.length); event.closed = true; event.seed = decidingHash; event.total = String(winners.length);
  return { window: event.window, root: event.root, inputRoot: event.inputRoot, pages: event.pages, claims: String(result.claims.length), winners: event.total,
    legacy: { version: 1, input: original.commitment } };
}
