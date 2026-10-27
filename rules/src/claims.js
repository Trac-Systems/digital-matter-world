import { assert, hex, integer, compare, stableJSON, randomIndex, findId } from './core.js';
import { recordGet } from './record-index.js';
import { patternCount } from './patterns.js';
export const CLAIM_DEFAULTS = Object.freeze({ claimsPerWindow: 100 });
// Hard ceiling for the setting; a move's own byte limit applies as well.
export const MAX_CLAIMS_PER_WINDOW = 1000;
export const patternAsset = p => `p${(typeof p === 'number' ? p : p.number).toString(36)}`;
export function slotsFor(header, patterns) {
  return patterns.flatMap(p => { const count = patternCount(p, header); return count > 0 ?
    [{ id: findId(header.height, p.number), block: header.height, pattern: p.number, asset: patternAsset(p), count }] : []; });
}
// A signed selection is unique per agent/block/window. Conflicting selections
// invalidate that plot. Exceeding the window budget invalidates all selections
// by that agent: arrival order can never choose which tickets survive.
export function settleClaims({ window, counted, decidingHash, claimableHeight = window, slots, claims, finds = {}, headerSenders = [], settings = {} }) {
  const s = { ...CLAIM_DEFAULTS, ...settings };
  assert(integer(window) && integer(counted) && counted >= window + 2 && hex(decidingHash, 32), 'draw_not_ready');
  assert(integer(claimableHeight) && claimableHeight <= window, 'claim_height');
  assert(integer(s.claimsPerWindow, MAX_CLAIMS_PER_WINDOW) && s.claimsPerWindow > 0, 'claim_settings');
  const senders = new Set(), byPlot = new Map(), outcomes = [], pool = new Map(), selections = new Map();
  for (const { block, agent } of headerSenders) {
    assert(block === window && hex(agent, 32), 'header_sender'); senders.add(agent);
  }
  const slotMap = new Map(slots.map(slot => [slot.id, slot]));
  assert(slotMap.size === slots.length, 'duplicate_slot');
  for (const slot of slots) assert(slot.id === findId(slot.block, slot.pattern) && integer(slot.count) && slot.count > 0, 'claim_slot');
  for (const c of claims) {
    assert(hex(c.agent, 32), 'claim_agent');
    const key = `${c.agent}:${c.block}`, list = byPlot.get(key) ?? []; list.push(c); byPlot.set(key, list);
    const ids = selections.get(c.agent) ?? new Set();
    if (c.window === window && Array.isArray(c.patterns)) for (const p of c.patterns) ids.add(`${c.block}:${p}`);
    selections.set(c.agent, ids);
  }
  for (const [, rows] of [...byPlot].sort(([a], [b]) => compare(a, b))) {
    const distinct = [...new Map(rows.map(c => [stableJSON(c), c])).entries()].sort(([a], [b]) => compare(a, b)).map(([, c]) => c);
    const c = distinct[0]; let reason = null;
    if (c.window !== window) reason = 'claim_window';
    else if (selections.get(c.agent).size > s.claimsPerWindow) reason = 'claim_budget';
    else if (distinct.length > 1) reason = 'conflicting_claims';
    else if (!integer(c.block) || (c.block > claimableHeight && c.block !== window)) reason = 'not_counted';
    else if (!Array.isArray(c.patterns) || !c.patterns.length || c.patterns.some(n => !integer(n, 0xffffffff)) || new Set(c.patterns).size !== c.patterns.length) reason = 'patterns';
    else if (c.patterns.some(p => recordGet(finds, findId(c.block, p)))) reason = 'already_found';
    else if (c.patterns.some(p => !slotMap.has(findId(c.block, p)))) reason = 'not_a_slot';
    outcomes.push(...distinct.map(claim => ({ ...claim, reason: reason ?? 'entered' })));
    if (reason) continue;
    for (const p of c.patterns) {
      const id = findId(c.block, p), agents = pool.get(id) ?? []; agents.push(c.agent); pool.set(id, agents);
    }
  }
  const draws = [...pool.keys()].sort(compare).map(id => {
    const agents = [...new Set(pool.get(id))].sort();
    return { ...slotMap.get(id), source: 'claim', claimers: agents,
      winner: agents[randomIndex(decidingHash, `claim-v2:${window}:${id}`, agents.length)], reason: 'won' };
  });
  // Only the new tip's unclaimed slots enter its correct-header-sender draw.
  for (const slot of [...slots].sort((a, b) => compare(a.id, b.id))) {
    if (slot.block !== window || pool.has(slot.id) || recordGet(finds, slot.id) || !senders.size) continue;
    const agents = [...senders].sort();
    draws.push({ ...slot, source: 'header', claimers: agents,
      winner: agents[randomIndex(decidingHash, `header-find-v2:${window}:${slot.id}`, agents.length)], reason: 'won' });
  }
  return { claims: outcomes, draws, winners: draws };
}
