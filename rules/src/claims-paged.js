import { assert, compare, findId, hex, randomIndex, stableJSON, utf8, hash } from './core.js';
import { recordGet, recordSet } from './record-index.js';
import { slotsFor } from './claims.js';
import { encodeBinary } from './binary.js';
import { merkleRoot } from './merkle.js';
import { batchSettings } from './batch-settings.js';
import { findIdV2, patternAssetV2, ordinalCodec, compareOrdinal } from './integers-v2.js';
import { patternCount } from './patterns.js';

export const claimSlotId = (settings, block, number) => settings.document ? findIdV2(String(block), String(number)) : findId(block, number);

const put = (state, field, key, value) => { state[field] = recordSet(state[field], key, value); };
export const namedPattern = (patterns, number) => {
  const p = typeof patterns?.get === 'function' ? patterns.get(number) : recordGet(patterns, number);
  assert(p?.number === number, 'pattern_unknown'); return p;
};
export function claimRound(window, hash, claimableHeight, catalog) {
  const zero = typeof window === 'string' ? '0' : 0;
  return { window, windowHash: hash, claimableHeight, catalog, inputPages: zero, headerSenders: [], closed: false, cursor: zero, offset: 0 };
}
// Each acknowledged segment becomes an immutable input page. Counters contain
// only this agent's distinct selections; no catalog or other-agent scan.
export function enterClaims({ state, event, agent, plots, patterns, history, settings = {} }) {
  const s = batchSettings(settings), key = `${event.window}/${agent}`;
  const findId = (block, number) => claimSlotId(s, block, number);
  const prior = recordGet(state.claimAgents, key) ?? { pairs: [], exceeded: false };
  const pairs = new Set(prior.pairs);
  for (const plot of plots) for (const number of plot.patterns) pairs.add(findId(plot.block, number));
  const exceeded = prior.exceeded || pairs.size > (event.policy?.claimsPerWindow ?? s.claimsPerWindow);
  // After overflow only the invalidation flag is needed, never an unbounded set.
  const slots = [];
  for (const plot of plots) {
    assert(compareOrdinal(plot.block, event.claimableHeight) <= 0 || plot.block === event.window, 'not_counted');
    assert(plot.patterns.every(number => !recordGet(state.finds, findId(plot.block, number)) && !recordGet(state.claimReservations, findId(plot.block, number))), 'already_found');
  }
  if (!exceeded) for (const plot of plots) {
    assert(compareOrdinal(plot.block, event.claimableHeight) <= 0 || plot.block === event.window, 'not_counted');
    const missing = [];
    for (const number of plot.patterns) {
      const known = recordGet(state.claimSlots, `${event.window}/${findId(plot.block, number)}`);
      if (known) slots.push(known); else missing.push(namedPattern(patterns, number));
    }
    if (missing.length) {
      const row = history.get(plot.block);
      slots.push(...(s.document ? missing.flatMap(p => {
        const count = patternCount(p, row); return count > 0 ? [{ id: findId(plot.block, p.number), block: plot.block,
          pattern: p.number, asset: p.legacy?.asset ?? patternAssetV2(String(p.number)), count }] : [];
      }) : slotsFor(row, missing)));
    }
  }
  const claims = plots.map(plot => ({ agent, window: event.window, ...plot }));
  if (s.closureWorkBudget) {
    event.closurePairs = String(BigInt(event.closurePairs ?? 0) + BigInt(plots.reduce((n, p) => n + p.patterns.length, 0)));
    event.closureBytes = String(BigInt(event.closureBytes ?? 0) + BigInt(utf8(stableJSON(claims)).length));
  }
  // Packet admission is bounded separately. The page builder can split a large
  // packet without changing any selection or the resulting window draw.
  const pages = boundedPages(claims, 'claims', s);
  put(state, 'claimAgents', key, { pairs: exceeded ? [] : [...pairs].sort(compare), exceeded });
  for (const page of pages) { put(state, 'claimInputs', `${event.window}/${event.inputPages}`, page); event.inputPages = ordinalCodec(!!s.document).add(event.inputPages); }
  for (const slot of slots) put(state, 'claimSlots', `${event.window}/${slot.id}`, slot);
  return { exceeded, slots };
}
export function boundedPages(rows, field, settings = {}) {
  const s = batchSettings(settings), pages = []; let page = [], bytes = 0;
  const emit = rows => {
    if (encodeBinary({ [field]: rows }).length <= s.auditPageBytes) { pages.push({ [field]: rows }); return; }
    assert(rows.length > 1, 'settlement_row_budget');
    const middle = Math.floor(rows.length / 2); emit(rows.slice(0, middle)); emit(rows.slice(middle));
  };
  for (const row of rows) {
    const size = encodeBinary({ [field]: [row] }).length;
    assert(size <= s.auditPageBytes, 'settlement_row_budget');
    if (page.length && (page.length === s.settlementPageRows || bytes + size > s.auditPageBytes)) { emit(page); page = []; bytes = 0; }
    page.push(row); bytes += size;
  }
  if (page.length) emit(page); return pages;
}

export function implicitHeaderFind({ state, slot, pattern, materializedAt }) {
  const draw = recordGet(state.headerAwards, slot.block);
  if (!draw || BigInt(draw.senderCount) === 0n || compareOrdinal(pattern.number, draw.catalog.nextNumber) >= 0 || recordGet(state.claimReservations, slot.id)) return null;
  const index = headerSenderIndex(draw, slot.id), page = String(BigInt(index) / BigInt(draw.senderPageRows)), offset = Number(BigInt(index) % BigInt(draw.senderPageRows));
  const pool = recordGet(state.headerPools, `${draw.window}/${page}`);
  assert(pool && pool[offset], 'header_pool_missing');
  return { ...slot, winner: pool[offset],
    source: 'header', tickets: draw.senderCount, window: draw.window, determinedAt: draw.determinedAt, findHeight: draw.determinedAt,
    materializedAt, reason: 'won', drawRoot: draw.root };
}

export function queueHeaderFind({ state, slot, pattern, height, settings }) {
  const w = implicitHeaderFind({ state, slot, pattern, materializedAt: height });
  if (!w || recordGet(state.finds, slot.id)) return;
  const clock = ordinalCodec(!!settings.document), draw = recordGet(state.headerAwards, slot.block);
  put(state, 'claimReservations', slot.id, { window: w.window, winner: w.winner });
  const lazyKey = `lazy/${slot.id}`, page = { winners: [w] }, root = merkleRoot([encodeBinary(page)]);
  put(state, 'settlementPages', `${lazyKey}/0`, page);
  state.rounds = [...state.rounds, { window: lazyKey, originalWindow: w.window, seed: draw.seed, root, inputRoot: w.drawRoot,
    total: clock.one, pages: clock.one, cursor: clock.zero, offset: 0, closed: true, headerSenders: [],
    ...(draw.policy ? { policy: draw.policy } : {}) }];
}

export function headerSenderIndex(draw, id) {
  const n = BigInt(draw.senderCount), domain = `header-find-v2:${draw.window}:${id}`;
  assert(n > 0n && hex(draw.seed, 32), 'random_input');
  const chunks = Math.max(1, Math.ceil(n.toString(2).length / 256)), range = 1n << BigInt(chunks * 256), limit = range - range % n;
  for (let counter = 0; ; counter++) {
    let bytes = hash(stableJSON([domain, draw.seed, counter]));
    for (let chunk = 1; chunk < chunks; chunk++) bytes += hash(stableJSON([domain, draw.seed, counter, chunk]));
    const value = BigInt('0x' + bytes); if (value < limit) return String(value % n);
  }
}

export function freezeClaimWindow({ state, event, decidingHash, counted, settings = {} }) {
  const s = batchSettings(settings), clock = ordinalCodec(!!s.document);
  const findId = (block, number) => claimSlotId(s, block, number);
  assert(!event.closed && clock.compare(counted, clock.add(event.window, event.policy?.claimWindowBlocks ?? s.claimWindowBlocks)) >= 0 && hex(decidingHash, 32), 'draw_not_ready');
  const byPlot = new Map(), inputs = [];
  for (let page = clock.zero; clock.compare(page, event.inputPages) < 0; page = clock.add(page)) {
    const input = recordGet(state.claimInputs, `${event.window}/${page}`); assert(input, 'claim_input_missing');
    for (const claim of input.claims) {
      const key = `${claim.agent}/${claim.block}`, rows = byPlot.get(key) ?? new Map(); rows.set(stableJSON(claim), claim); byPlot.set(key, rows);
    }
  }
  const tickets = new Map(), outcomes = [];
  for (const [key, rows] of [...byPlot].sort(([a], [b]) => compare(a, b))) {
    const distinct = [...rows].sort(([a], [b]) => compare(a, b)).map(([, c]) => c), c = distinct[0];
    const agent = recordGet(state.claimAgents, `${event.window}/${c.agent}`);
    let reason = agent?.exceeded ? 'claim_budget' : distinct.length > 1 ? 'conflicting_claims' : null;
    const slots = c.patterns.map(n => recordGet(state.claimSlots, `${event.window}/${findId(c.block, n)}`));
    if (!reason && slots.some(s => !s)) reason = 'not_a_slot';
    if (!reason && slots.some(slot => recordGet(state.finds, slot.id) || recordGet(state.claimReservations, slot.id))) reason = 'already_found';
    if (!reason && slots.some(slot => {
      const draw = recordGet(state.headerAwards, slot.block);
      return draw && BigInt(draw.senderCount) > 0n && compareOrdinal(slot.pattern, draw.catalog.nextNumber) < 0;
    })) reason = 'header_awarded';
    for (const row of distinct) { inputs.push(row); outcomes.push({ ...row, reason: reason ?? 'entered' }); }
    if (reason) continue;
    for (const slot of slots) { const pool = tickets.get(slot.id) ?? { slot, agents: new Set() }; pool.agents.add(c.agent); tickets.set(slot.id, pool); }
  }
  const winners = [...tickets].sort(([a], [b]) => compare(a, b)).map(([id, { slot, agents: pool }]) => {
    const agents = [...pool].sort(compare);
    const winner = { ...slot, winner: agents[randomIndex(decidingHash, `claim-v2:${event.window}:${id}`, agents.length)], source: 'claim', tickets: clock.value(agents.length), reason: 'won' };
    put(state, 'claimReservations', id, { window: event.window, winner: winner.winner }); return winner;
  });
  const senders = [...event.headerSenders];
  for (let i = clock.zero; clock.compare(i, event.headerCount ?? 0) < 0; i = clock.add(i)) { const agent = recordGet(state.headerInputs, `${event.window}/${i}`); assert(agent, 'header_input_missing'); senders.push(agent); }
  const pool = [...new Set(senders)].sort(compare), headerPages = boundedPages(pool, 'headers', s);
  // Header identities have a fixed encoded size, so sender-page addressing is
  // deterministic. Their archive is independent of settlement delivery.
  const senderPageRows = headerPages[0]?.headers.length ?? s.settlementPageRows;
  for (let i = 0; i < headerPages.length; i++) put(state, 'headerPools', `${event.window}/${i}`, headerPages[i].headers);
  const pages = [...headerPages, ...boundedPages(outcomes, 'claims', s), ...boundedPages(winners, 'winners', s)];
  event.root = merkleRoot(pages.map(encodeBinary)); event.inputRoot = merkleRoot(inputs.map(stableJSON));
  event.pages = clock.value(pages.length); event.closed = true; event.seed = decidingHash; event.total = clock.value(winners.length); event.claimCount = clock.value(outcomes.length);
  for (let i = 0; i < pages.length; i++) put(state, 'settlementPages', `${event.window}/${i}`, pages[i]);
  const draw = { window: event.window, windowHash: event.windowHash, determinedAt: clock.add(event.window, event.policy?.claimWindowBlocks ?? s.claimWindowBlocks),
    seed: decidingHash, senderCount: clock.value(pool.length), senderRoot: merkleRoot(headerPages.map(encodeBinary)), senderPageRows, catalog: event.catalog,
    receiptChains: event.receiptChains ?? {}, explicitRoot: merkleRoot(winners.map(w => stableJSON(w.id))), root: event.root,
    ...(event.policy ? { policy: event.policy } : {}) };
  put(state, 'headerAwards', event.window, draw);
  return { window: event.window, root: event.root, inputRoot: event.inputRoot, pages: event.pages, claims: event.claimCount, winners: event.total, draw };
}

// Updating one winner remeasures only its owner's credits, never all previously
// selected winners. The final wire budget is checked again by buildBatchV2.
export class CreditBudget {
  constructor(settings = {}, priorOperations = []) {
    this.settings = batchSettings(settings); this.owners = new Map(); this.bytes = utf8(stableJSON(priorOperations)).length; this.ops = priorOperations.length;
    this.assets = priorOperations.reduce((n, op) => n + (op.assets?.length ?? 0), 0);
  }
  ownerOps(owner, balances) {
    const assets = [...balances].sort(([a], [b]) => compare(a, b)).map(([a, n]) => [a, n.toString()]), ops = [], size = this.settings.creditAssetsPerOperation;
    for (let i = 0; i < assets.length; i += size) ops.push({ op: 'ac', to: owner, assets: assets.slice(i, i + size) });
    return ops;
  }
  add(winner) {
    const old = this.owners.get(winner.winner) ?? { balances: new Map(), bytes: 0, ops: [] };
    const balances = new Map(old.balances); balances.set(winner.asset, (balances.get(winner.asset) ?? 0n) + BigInt(winner.count));
    const ops = this.ownerOps(winner.winner, balances), bytes = ops.reduce((n, op) => n + utf8(stableJSON(op)).length + 1, 0), s = this.settings;
    if (this.bytes - old.bytes + bytes > s.maxBatchBytes - s.batchEnvelopeReserveBytes || this.ops - old.ops.length + ops.length + 2 > s.maxOps || this.assets - old.balances.size + balances.size > s.maxAssets) return false;
    this.bytes += bytes - old.bytes; this.ops += ops.length - old.ops.length; this.assets += balances.size - old.balances.size;
    this.owners.set(winner.winner, { balances, bytes, ops }); return true;
  }
  operations() { return [...this.owners].sort(([a], [b]) => compare(a, b)).flatMap(([, o]) => o.ops); }
}
export function takeSettlementPage({ state, event, height, budget, maxRows = budget.settings.settlementPageRows }) {
  const clock = ordinalCodec(!!budget.settings.document);
  if (clock.compare(event.cursor, event.pages) >= 0) return null;
  const page = recordGet(state.settlementPages, `${event.window}/${event.cursor}`); assert(page, 'settlement_page_missing');
  const field = page.claims ? 'claims' : page.headers ? 'headers' : 'winners', from = event.offset, rows = page[field], taken = [];
  for (let i = from; i < rows.length && taken.length < maxRows; i++) {
    const w = rows[i];
    if (field === 'winners' && !budget.add(w)) break;
    taken.push(w);
    if (field === 'winners') {
      assert(!recordGet(state.finds, w.id), 'duplicate_find');
      const account = { ...(recordGet(state.balances, w.winner) ?? {}) };
      account[w.asset] = ((BigInt(account[w.asset] ?? '0')) + BigInt(w.count)).toString(); put(state, 'balances', w.winner, account);
      put(state, 'finds', w.id, { block: w.block, pattern: w.pattern, asset: w.asset, count: w.count, finder: w.winner,
        findHeight: w.findHeight ?? height, window: event.originalWindow ?? event.window, source: w.source,
        ...(event.policy ? { settingsHash: event.policy.settingsHash, finderUntil: String(BigInt(w.findHeight ?? height) + BigInt(event.policy.finderWindow)) } : {}),
        ...(w.determinedAt === undefined ? {} : { determinedAt: w.determinedAt, materializedAt: height }) });
    }
  }
  if (!taken.length) return null;
  const index = event.cursor; event.offset += taken.length;
  if (event.offset === rows.length) { event.cursor = clock.add(event.cursor); event.offset = 0; }
  return { window: event.window, root: event.root, inputRoot: event.inputRoot, page: index, from, to: from + taken.length,
    claims: field === 'claims' ? taken : [], winners: field === 'winners' ? taken : [], ...(field === 'headers' ? { headers: taken } : {}), complete: clock.compare(event.cursor, event.pages) === 0, total: event.total, seed: event.seed, void: false };
}
