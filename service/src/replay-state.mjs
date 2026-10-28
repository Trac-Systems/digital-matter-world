import { rules } from './rules.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, hash } from './util.mjs';

// Lifetime indexes live as individual journaled rows. Only keys that the next
// bounded replay can read are materialized in its input snapshot.
export const claimMaps = ['receiptSegments', 'claimAgents', 'claimInputs', 'claimSlots', 'claimReservations', 'settlementPages', 'headerAwards', 'headerInputs', 'headerTickets', 'headerPools'];
export const coldMaps = ['receiptSeals', 'linkPayments', 'links', ...claimMaps];
export function coldOperations(state) {
  const ops = [];
  for (const field of coldMaps) for (const [id, value] of Object.entries(claimMaps.includes(field) ? rules.recordChanges(state[field]) : rules.recordObject(state[field]))) ops.push({ space: 'replay/' + field, id, value });
  for (const [field, values] of Object.entries(state.mints ?? {})) for (const [id, value] of Object.entries(values)) ops.push({ space: field === 'finished' ? 'mintFinished' : 'replay/mints/' + field, id, value });
  return ops;
}
export function hotState(state) {
  return { ...state, ...Object.fromEntries(claimMaps.map(k => [k, {}])), balances: {}, finds: {}, types: {}, usedNonces: {}, receiptSeals: {}, linkPayments: {}, links: {}, mints: {} };
}
export async function archiveState(store, state, pageRows = 256) {
  const operations = coldOperations(state);
  for (let i = 0; i < operations.length; i += pageRows) await store.transact(operations.slice(i, i + pageRows));
  return operations.length;
}
export function hydrateState(store, state, observations, settings = {}) {
  const clock = rules.ordinalCodec(!!settings.document);
  const findId = (block, number) => rules.claimSlotId(settings, block, number);
  if (state.batchVersion === 2 && !settings.document) {
    const read = (field, key) => { state[field] ??= {}; const row = store.get('replay/' + field, key); if (row !== null) state[field][key] = row; };
    const claim = (window, agent, plots) => {
      read('claimAgents', `${window}/${agent}`);
      read('headerTickets', `${window}/${agent}`);
      for (const plot of plots) {
        read('headerAwards', plot.block);
        const draw = state.headerAwards[plot.block];
        if (draw && BigInt(draw.senderCount) > 0n) for (const p of plot.patterns) {
          const index = rules.headerSenderIndex(draw, findId(plot.block, p));
          read('headerPools', `${draw.window}/${BigInt(index) / BigInt(draw.senderPageRows)}`);
        }
        for (const p of plot.patterns) { const id = findId(plot.block, p); read('claimSlots', `${window}/${id}`); read('claimReservations', id); const f = store.get('finds', id); if (f) { state.finds ??= {}; state.finds[id] = f; } }
      }
    };
    for (const observation of observations) {
      read('receiptSegments', `${observation.tip}/${observation.hash}`);
      for (const { value: { move: original } } of store.list('intake/' + observation.id, { limit: 1000 })) {
        const move = original.t === 'claim-v2' ? { ...original, t: 'claim', p: { window: original.p.window, plots: original.p.plots.map(p => ({ block: p.block, patterns: p.patterns })) } } : original.t === 'header-v2' ? { ...original, t: 'header', p: { height: original.p.height } } : original;
        if (move.t === 'claim') claim(move.p.window, move.a, move.p.plots);
        if (move.t === 'header') read('headerTickets', `${move.p.height}/${move.a}`);
      }
    }
    for (const round of state.rounds ?? []) {
      if (round.closed) {
        const through = clock.min(round.pages, clock.add(round.cursor, rules.batchSettings(settings).settlementPagesPerObservation * observations.length));
        for (let page = round.cursor; clock.compare(page, through) < 0; page = clock.add(page)) read('settlementPages', `${round.window}/${page}`);
        continue;
      }
      if (!observations.some(o => clock.compare(o.tip, clock.add(round.window, 2)) >= 0 && clock.compare(o.counted, clock.add(round.window, 2)) >= 0)) continue;
      for (let i = clock.zero; clock.compare(i, round.headerCount ?? 0) < 0; i = clock.add(i)) read('headerInputs', `${round.window}/${i}`);
      for (let i = clock.zero; clock.compare(i, round.inputPages) < 0; i = clock.add(i)) {
        const key = `${round.window}/${i}`; read('claimInputs', key);
        for (const c of state.claimInputs[key]?.claims ?? []) claim(round.window, c.agent, [c]);
      }
    }
  }
  state.receiptSeals ??= {};
  for (const o of observations) {
    const key = `${o.tip}/${o.hash}`, root = store.get('replay/receiptSeals', key);
    if (root) state.receiptSeals[key] = root;
    for (const { value: { move } } of store.list('intake/' + o.id, { limit: 1000 })) if (move.t === 'craft') {
      state.types ??= {};
      for (const [asset] of [...move.p.request.in, ...move.p.request.out]) {
        const type = store.get('types', asset);
        if (type) state.types[asset] = type;
      }
    }
  }
  return state;
}
