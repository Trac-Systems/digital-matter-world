import { publicIdentities, encodeTracAddress, decodeTracAddress } from '../../rules/src/trac-address.js';
import { slotsFor, settleClaims, analyzePattern, CLAIM_DEFAULTS, patternAsset } from '../../rules/src/index.js';
import { chooseClaims } from '../strategies/default.mjs';
import { historyProof } from './headers.mjs';
import { check, hex32, integer } from './check.mjs';

// Replays all-history claims and the H+2 draw. Strategies see only the prefix ending at H.
// Scores are a single-agent experiment unless explicit opponent strategies enter.
export async function backtest({ history, patterns, owner, strategy = chooseClaims, opponents = [], start = 1, end = history.length - 1, settings = {}, signal, onProgress = () => {} }) {
  owner = decodeTracAddress(owner);
  opponents = opponents.map(o => ({ ...o, owner: decodeTracAddress(o.owner) }));
  const proof = historyProof(history);
  settings = { ...CLAIM_DEFAULTS, ...settings };
  check(hex32(owner) && integer(start) && start > 0 && integer(end) && end < history.length && end >= start, 'Invalid replay range');
  check(opponents.every(o => hex32(o.owner) && o.owner !== owner && typeof o.strategy === 'function') && new Set(opponents.map(o => o.owner)).size === opponents.length, 'Invalid replay opponents');
  let events = 0, wins = 0, claimed = 0, units = 0n;
  const balances = {}, pending = [], finds = {}, taken = {};
  const prefix = length => ({ length, get: h => { check(integer(h) && h < length, 'Strategy tried to read a future header'); return history.get(h); },
    field: (h, f, dt) => { check(integer(h) && h < length, 'Strategy tried to read a future header'); return history.field(h, f, dt); } });
  // Rarity is measured at replay start, never from future observations.
  const catalog = patterns.filter(p => p.historyHeight === undefined || p.historyHeight < start)
    .map(p => ({ ...p, ...Object.fromEntries(Object.entries(analyzePattern(p, prefix(start))).filter(([k]) => ['rarity', 'total', 'tier'].includes(k))), historyHeight: start - 1 }));
  for (let h = start; h <= end; h++) {
    signal?.throwIfAborted();
    // The deciding block lands at H+2; no extra confirmation depth.
    while (pending.length && pending[0].window + 2 <= h) {
      const event = pending.shift();
      const result = settleClaims({ ...event, counted: h, decidingHash: history.get(event.window + 2).hash, finds, settings });
      for (const w of result.winners) { finds[w.id] = w; (taken[w.pattern] ??= new Set()).add(w.block); }
      for (const w of result.winners.filter(w => w.winner === owner)) { wins++; units += BigInt(w.count); balances[w.asset] = (BigInt(balances[w.asset] ?? '0') + BigInt(w.count)).toString(); }
    }
    const context = { history: prefix(h + 1), patterns: structuredClone(catalog), taken, claimsPerWindow: settings.claimsPerWindow, claimableHeight: h, window: h };
    const claims = [], senders = [];
    for (const agent of [{ owner, strategy }, ...opponents]) {
      const selected = await agent.strategy({ ...context, patterns: publicIdentities(catalog), owner: encodeTracAddress(agent.owner) });
      check(Array.isArray(selected), 'Strategy must return plot selections');
      claims.push(...selected.map(p => ({ agent: agent.owner, window: h, ...p })));
      if (agent.owner === owner) claimed += selected.reduce((n, p) => n + p.patterns.length, 0);
      senders.push({ block: h, agent: agent.owner });
    }
    const blocks = [...new Set([h, ...claims.map(c => c.block)])];
    pending.push({ window: h, slots: blocks.flatMap(b => slotsFor(history.get(b), catalog)), claims, headerSenders: senders }); events++;
    if ((h - start) % 1000 === 0) { onProgress({ height: h, end, wins }); await new Promise(resolve => setImmediate(resolve)); }
  }
  return { snapshot: proof, start, end, events, settledEvents: events - pending.length, unsettledEvents: pending.length, selections: claimed, wins, units: units.toString(), balances,
    opponents: opponents.length, opponentOwners: opponents.map(o => encodeTracAddress(o.owner)), catalogSize: catalog.length, catalogIds: catalog.map(patternAsset), settings, assumptions: ['All counted history is claimable; finds are excluded in later windows', 'Fixed catalog known at replay start', 'Every supplied header is accepted', 'No reorgs', 'Only supplied opponents compete', 'No transaction fees or mint prices modeled'] };
}
