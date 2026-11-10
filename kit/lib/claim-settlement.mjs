import { merkleRoot, stableJSON, findIdV2, hash, hashBytes, utf8, bytesToHex, hexToBytes } from '../../rules/src/index.js';
import { check, hex32 } from './check.mjs';
import { nextCursor } from './api-values.mjs';
import { COMPETITION_NOTE } from './agent-guide.mjs';

export const HUNT_READ_LIMIT = 64, HUNT_REPAIR_LIMIT = 4;
const PAGE_LIMIT = 50, PAGE_COUNT = 4, WINDOW_PAGES = 32, BLOCK_RESERVE = 16;
const same = (a, b) => a != null && b != null && String(a) === String(b);
const slot = row => String(row.block) + '/' + String(row.pattern ?? row.asset);
const refusalCode = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : 'claim_rejected';

export function claimRefusal(journal, row) {
  if (!['refused', 'rejected'].includes(row.state)) return null;
  const saved = journal.get(row.id), { outcome } = journal.evidence(row.id);
  return { phase: 'rejected', reason: refusalCode(outcome?.reason ?? saved?.result?.code ?? saved?.result?.reason),
    source: row.state === 'refused' ? 'saved_refusal' : 'saved_outcome' };
}

// A single budget and promise cache cover the displayed rows and old-loss repair.
export function huntingReads(agent) {
  const cache = new Map(); let reads = 0;
  const get = (key, run) => {
    if (!cache.has(key)) {
      check(reads < HUNT_READ_LIMIT, 'hunting_read_budget'); reads++;
      cache.set(key, Promise.resolve().then(run));
    }
    return cache.get(key);
  };
  const pages = async (key, read, field, from) => {
    const rows = [], seen = new Set(); let cursor = from;
    try {
      for (let n = 0; n < PAGE_COUNT; n++) {
        const page = await get(key + '/' + (cursor ?? ''), () => read({ cursor, limit: PAGE_LIMIT }));
        check(page.v === 3 && Array.isArray(page[field]) && page[field].length <= PAGE_LIMIT, 'Invalid claim evidence page');
        rows.push(...page[field]); cursor = nextCursor(page);
        if (!cursor) return { rows, complete: true, cursor: null };
        check(!seen.has(cursor), 'Repeated claim evidence cursor'); seen.add(cursor);
      }
    } catch (error) {
      if (['page_cursor_stale', 'claimed_cursor_stale'].includes(error.code ?? error.message)) cursor = undefined;
      // Partial positive evidence is still useful; absence is not.
    }
    return { rows, complete: false, cursor: cursor ?? null };
  };
  return { get, pages, get count() { return reads; }, get remaining() { return HUNT_READ_LIMIT - reads; } };
}

function relevant(winner, row) {
  if (!same(winner.window, row.window)) return false;
  return row.plots.some(p => same(p.block, winner.block) && p.patterns.some(n => same(n, winner.pattern))) ||
    winner.source === 'header' && same(row.headerBlock, winner.block);
}

// The gateway keeps the closure's explicitRoot, not the settlement page's
// complete flag. Reproduce that root from booked explicit winners, in their
// original page/offset order. No age, row count or empty projection proves it.
// Busy windows hold thousands of winners, so the root is folded page by page
// into a small frontier (same leaf/parent/count hashing as rules merkleRoot)
// that the journal keeps between calls.
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const leafHash = text => hashBytes(concat(new Uint8Array([0]), utf8(text)));
const parentHash = (a, b) => hashBytes(concat(new Uint8Array([1]), a, b));
const commitTree = (root, count) => hash(concat(new Uint8Array([3]), utf8(stableJSON([count, bytesToHex(root)]))));
const freshProof = closure => ({ root: closure.root, explicitRoot: closure.explicitRoot, cursor: null, count: 0, frontier: [], last: null });
export function addRootLeaf(proof, text) {
  let node = leafHash(text), level = 0;
  while (proof.frontier[level]) { node = parentHash(hexToBytes(proof.frontier[level]), node); proof.frontier[level] = null; level++; }
  proof.frontier[level] = bytesToHex(node); proof.count++;
}
export function finishRoot(proof) {
  if (!proof.count) return merkleRoot([]);
  const levels = proof.frontier; let carry = null;
  for (let level = 0; level < levels.length; level++) {
    const higher = levels.slice(level + 1).some(Boolean), node = levels[level] ? hexToBytes(levels[level]) : null;
    if (node && carry) carry = parentHash(node, carry);
    else if (node) { if (!higher) return commitTree(node, proof.count); carry = parentHash(node, node); }
    else if (carry) { if (!higher) return commitTree(carry, proof.count); carry = parentHash(carry, carry); }
  }
  return commitTree(carry, proof.count);
}
async function bookedWindow(agent, reads, window, closure, prior) {
  if (!hex32(closure?.explicitRoot) || !hex32(closure?.root)) return { rows: [], complete: false, proof: null };
  if (closure.explicitRoot === merkleRoot([])) return { rows: [], complete: true, proof: null };
  let proof = prior?.root === closure.root && prior?.explicitRoot === closure.explicitRoot && Array.isArray(prior.frontier)
    ? { ...prior, frontier: [...prior.frontier] } : freshProof(closure);
  const winners = [];
  for (let n = 0; n < WINDOW_PAGES && reads.remaining > BLOCK_RESERVE; n++) {
    const cursor = proof.cursor ?? undefined;
    let page;
    try {
      page = await reads.get(`window/${window}/${closure.root}/${cursor ?? ''}`, () => agent.service.readPage(`/windows/${window}/winners`, { ...(cursor ? { cursor } : {}), limit: PAGE_LIMIT, sort: 'id', order: 'asc' }));
      check(page?.v === 3 && Array.isArray(page.rows) && page.rows.length <= PAGE_LIMIT, 'Invalid claim evidence page');
    } catch (error) {
      // A stale cursor means more rows were booked: fold again from the start next time. Busy reads keep progress.
      if (['page_cursor_stale', 'claimed_cursor_stale'].includes(error.code ?? error.message)) proof = freshProof(closure);
      return { rows: winners, complete: false, proof };
    }
    try {
      for (const record of page.rows) {
        if (record.root !== closure.root) continue;
        const w = record.row;
        check(typeof record.id === 'string' && (proof.last === null || record.id > proof.last), 'Winner order changed');
        check(w?.source === 'claim' && w.id === findIdV2(String(w.block), String(w.pattern)), 'Invalid booked winner');
        addRootLeaf(proof, stableJSON(w.id)); proof.last = record.id;
        winners.push({ ...w, window, provenance: { batch: record.batch, audit: record.audit, root: record.root } });
      }
    } catch { return { rows: winners, complete: false, proof: freshProof(closure) }; }
    const next = nextCursor(page);
    if (!next) {
      // Every row booked so far is folded. A mismatch means booking continues: start over on a later call.
      const complete = finishRoot(proof) === closure.explicitRoot;
      return { rows: winners, complete, proof: complete ? null : freshProof(closure) };
    }
    proof.cursor = next;
  }
  return { rows: winners, complete: false, proof };
}

export async function reconcileClaim(agent, row, reads) {
  if (row.window == null && row.headerBlock != null) row = { ...row, window: row.headerBlock,
    closesAt: row.headerBlock + 2, drawAt: row.headerBlock + 2, settlesWhenCounted: row.headerBlock + 2, settlesAt: null };
  const previous = agent.journal.evidence(row.id).settlement;
  const wins = new Map((previous?.wins ?? []).map(w => [slot(w), w])), observed = new Map(wins);
  const cursors = { ...previous?.cursors };
  const add = winner => {
    if (!relevant(winner, row)) return;
    observed.set(slot(winner), winner);
    if (winner.winner === agent.address || winner.winner === agent.owner) wins.set(slot(winner), { ...wins.get(slot(winner)), ...winner });
  };
  let closure = null, booked = { rows: [], complete: false, proof: previous?.booking ?? null };
  try { closure = (await reads.get('closure/' + row.window, () => agent.service.readPage('/window-eligibility/' + row.window)))?.draw ?? null; }
  catch { /* A find or draw can establish a win even when closure reads fail. */ }
  if (closure && !same(closure.window, row.window)) closure = null;
  // A claim that already won needs no loss proof; skip the window walk.
  if (closure && closure.void !== true && !wins.size) booked = await bookedWindow(agent, reads, row.window, closure, previous?.booking);
  for (const winner of booked.rows) add(winner);

  const blocks = [...new Set([...row.plots.map(p => p.block), ...(row.headerBlock == null ? [] : [row.headerBlock])])];
  // Resume large claim bundles on later calls. Positive observations live in
  // the journal; a bounded pass through only some blocks never proves a loss.
  const start = Number.isSafeInteger(previous?.nextPlot) ? previous.nextPlot % Math.max(1, blocks.length) : 0;
  let visited = 0;
  for (; visited < blocks.length && reads.remaining > 0; visited++) {
    const block = blocks[(start + visited) % blocks.length];
    const findKey = 'finds/' + block, drawKey = `draws/${row.window}/${block}`;
    const finds = await reads.pages(findKey, opts => agent.service.block(block, { ...opts, collection: 'finds', owner: agent.address }), 'finds', cursors[findKey]);
    if (finds.cursor) cursors[findKey] = finds.cursor; else delete cursors[findKey];
    for (const find of finds.rows) if (find.finder === agent.address || find.finder === agent.owner) add({ ...find, winner: find.finder });
    const draws = await reads.pages(drawKey, opts => agent.service.block(block, { ...opts, collection: 'draws', window: row.window }), 'draws', cursors[drawKey]);
    if (draws.cursor) cursors[drawKey] = draws.cursor; else delete cursors[drawKey];
    for (const winner of draws.rows) add(winner);
  }
  const headerPending = row.headerBlock != null && (!closure || !same(closure.senderCount, 0));
  const bookingComplete = closure?.void === true || booked.complete && !headerPending;
  const phase = wins.size ? 'won' : closure?.void === true ? 'void' : bookingComplete ? 'lost' : 'awaiting_booking';
  const agents = new Set([...observed.values()].map(w => w.winner));
  const competition = observed.size ? { agentsWon: agents.size, slotsWon: observed.size, yours: wins.size,
    complete: bookingComplete, note: 'Counts cover observed tracked slots. ' + COMPETITION_NOTE } : previous?.competition;
  const settlement = { window: row.window, phase, source: 'public_booking_v3', wins: [...wins.values()], bookingComplete,
    checkedAt: Date.now(), cursors,
    nextPlot: blocks.length ? (start + visited) % blocks.length : 0,
    ...(competition ? { competition } : {}), ...(closure?.void === true ? { void: true, reason: closure.reason ?? null } : {}),
    ...(booked.complete ? { explicitRoot: closure.explicitRoot } : {}), ...(!booked.complete && booked.proof ? { booking: booked.proof } : {}),
    ...(previous?.source === 'public_draws_v3' && previous.phase === 'lost' || previous?.correctedLoss ? { correctedLoss: true } : {}) };
  agent.journal.settle(row.id, settlement);
  return { ...row, phase, settlement, ...(competition ? { competition } : {}),
    ...(!bookingComplete ? { next: { tool: 'window_eligibility', arguments: { window: row.window } } } : {}) };
}
