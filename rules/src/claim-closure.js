import { assert, hash, hex, randomIndex, stableJSON, utf8 } from './core.js';
import { recordGet, recordSet } from './record-index.js';
import { encodeBinary } from './binary.js';
import { ordinalCodec, compareOrdinal } from './integers-v2.js';
import { claimSlotId, queueHeaderFind } from './claims-paged.js';
import { merkleRoot } from './merkle.js';
import { orderedIndex } from './closure-index.js';
import { emptyFrontier, appendFrontier, frontierRoot } from './merkle-frontier.js';
import { claimsNeverCloseActive } from './public-mint.js';
import { publicTaken } from './public-claims.js';

const exhausted = () => { throw Error('closure_budget'); };
// Count authenticated row accesses, including cache hits, so local cache size
// cannot change consensus chunk boundaries. Reserve a maximum row before a
// read: the read which stops a chunk cannot overrun the byte budget.
export class ClosureBudget {
  constructor(settings, storage) {
    this.settings = settings; this.storage = storage;
    this.work = 0; this.reads = 0; this.bytes = 0; this.steps = 0;
    this.rowBytes = new WeakMap();
    // Every incoming claim node is already checked against auditMaxBytes by
    // claimEvidenceReader. Reserve that actual accepted row limit, including
    // large per-agent metadata, rather than assuming every row is a page.
    this.rowReserve = settings.auditMaxBytes;
  }
  charge(bytes) { if (this.bytes + bytes > this.settings.closureByteBudget) exhausted(); this.bytes += bytes; }
  run(action) {
    const storage = this.storage, original = storage?.row;
    if (storage) storage.row = (id, ancestors) => {
      if (this.reads === this.settings.closureReadBudget || this.bytes + this.rowReserve > this.settings.closureByteBudget) exhausted();
      const row = original.call(storage, id, ancestors);
      let bytes = this.rowBytes.get(row);
      if (bytes === undefined) { bytes = utf8(stableJSON(row)).length; this.rowBytes.set(row, bytes); }
      assert(bytes <= this.rowReserve, 'closure_row_budget'); this.reads++; this.charge(bytes); return row;
    };
    try { return action(); } finally { if (storage) storage.row = original; }
  }
  snapshot() { return { work: this.work, reads: this.reads, bytes: this.bytes, steps: this.steps }; }
}

// Intermediate rows use a disjoint namespace in an existing authenticated map.
// The hot checkpoint commits the phase, counters, current page and frontier;
// restart and independent replay need no scan of earlier windows or chunks.
export function advanceClaimWindow({ state, event, decidingHash, counted, settings: s, budget, voided = false }) {
  const clock = ordinalCodec(!!s.document), window = event.window, prefix = `closure/${window}/`;
  assert(!event.closed && clock.compare(counted, clock.add(window, event.policy?.claimWindowBlocks ?? s.claimWindowBlocks)) >= 0 && (voided || event.closing?.void || hex(decidingHash, 32)), 'draw_not_ready');
  let c = event.closing ? structuredClone(event.closing) : {
    phase: voided ? 'voidScan' : 'scan', seed: decidingHash ?? null, ...(voided ? { void: true } : {}), scanPage: clock.zero, scanRow: 0, groups: '0', group: '0', rows: '0', row: '0', slots: '0', slot: '0',
    header: '0', headerRoot: null, headerCount: '0', pages: clock.zero, winners: clock.zero,
    layout: { rows: s.settlementPageRows, bytes: s.auditPageBytes },
    page: null, pageBytes: 0, pagesTree: emptyFrontier(), inputsTree: emptyFrontier(), winnersTree: emptyFrontier(), headersTree: emptyFrontier()
  };
  c.layout ??= { rows: s.settlementPageRows, bytes: s.auditPageBytes };
  const drawFor = checkpoint => ({ window, windowHash: event.windowHash,
    determinedAt: clock.add(window, event.policy?.claimWindowBlocks ?? s.claimWindowBlocks), seed: checkpoint.seed,
    senderCount: clock.value(checkpoint.headerCount), senderRoot: frontierRoot(checkpoint.headersTree),
    senderPageRows: checkpoint.senderPageRows ?? checkpoint.layout.rows,
    catalog: event.catalog, receiptChains: event.receiptChains ?? {}, explicitRoot: frontierRoot(checkpoint.winnersTree),
    root: frontierRoot(checkpoint.pagesTree), ...(event.policy ? { policy: event.policy } : {}) });
  let completed = null, progressed = false;
  const before = budget.snapshot();
  while (c.phase !== 'done' && budget.work < s.closureWorkBudget) {
    const working = { ...state }, next = structuredClone(c), cache = new Map();
    const get = (field, key) => {
      const id = `${field}/${key}`;
      if (!cache.has(id)) {
        if (!budget.storage) { if (budget.reads === s.closureReadBudget) exhausted(); budget.reads++; }
        const value = recordGet(working[field], key);
        if (!budget.storage && value !== undefined) budget.charge(utf8(stableJSON(value)).length);
        cache.set(id, value);
      }
      return cache.get(id);
    };
    const set = (field, key, value) => {
      budget.charge(utf8(stableJSON(value)).length);
      working[field] = recordSet(working[field], key, value); cache.set(`${field}/${key}`, value);
    };
    const io = { get: key => get('claimInputs', prefix + key), set: (key, value) => set('claimInputs', prefix + key, value) };
    const flush = () => {
      if (!next.page) return;
      set('settlementPages', `${window}/${next.pages}`, next.page);
      const encoded = encodeBinary(next.page); assert(encoded.length <= next.layout.bytes, 'settlement_row_budget');
      next.pagesTree = appendFrontier(next.pagesTree, encoded);
      if (next.page.headers) {
        const page = next.headersTree.count; set('headerPools', `${window}/${page}`, next.page.headers);
        next.headersTree = appendFrontier(next.headersTree, encoded);
        next.senderPageRows ??= next.page.headers.length;
      }
      next.pages = clock.add(next.pages); next.page = null; next.pageBytes = 0;
    };
    const emit = (field, value) => {
      const bytes = encodeBinary({ [field]: [value] }).length;
      assert(bytes <= next.layout.bytes, 'settlement_row_budget');
      if (next.page && (!next.page[field] || next.page[field].length === next.layout.rows || next.pageBytes + bytes > next.layout.bytes)) flush();
      next.page ??= { [field]: [] }; next.page[field].push(value); next.pageBytes += bytes;
    };
    budget.work++;
    try {
      budget.run(() => {
        if (next.phase === 'voidScan') {
          if (clock.compare(next.scanPage, event.inputPages) >= 0) { next.phase = 'done'; return; }
          const page = get('claimInputs', `${window}/${next.scanPage}`); assert(page, 'claim_input_missing');
          next.rows = String(BigInt(next.rows) + BigInt(page.claims.length)); next.scanPage = clock.add(next.scanPage);
        } else if (next.phase === 'scan') {
          if (clock.compare(next.scanPage, event.inputPages) >= 0) { next.phase = 'groups'; return; }
          const page = get('claimInputs', `${window}/${next.scanPage}`); assert(page, 'claim_input_missing');
          const row = page.claims[next.scanRow], identity = stableJSON(row), groupKey = `${row.agent}/${row.block}`, key = hash(groupKey);
          if (!io.get(`seen/${hash(identity)}`)) {
            io.set(`seen/${hash(identity)}`, true);
            const group = io.get(`group/${key}`);
            if (!group) { io.set(`groups/${next.groups}`, key); next.groups = String(BigInt(next.groups) + 1n); }
            io.set(`group/${key}`, { claim: group?.claim ?? row, distinct: String(BigInt(group?.distinct ?? '0') + 1n) });
            io.set(`rows/${next.rows}`, { claim: row, group: key }); next.rows = String(BigInt(next.rows) + 1n);
            next.inputsTree = appendFrontier(next.inputsTree, identity);
          }
          next.scanRow++;
          if (next.scanRow === page.claims.length) { next.scanPage = clock.add(next.scanPage); next.scanRow = 0; }
        } else if (next.phase === 'groups') {
          if (next.group === next.groups) { next.phase = 'headers'; return; }
          const key = io.get(`groups/${next.group}`), group = io.get(`group/${key}`), claim = group.claim;
          const agent = get('claimAgents', `${window}/${claim.agent}`);
          next.current = { key, claim, index: 0, reason: agent?.exceeded ? 'claim_budget' : group.distinct !== '1' ? 'conflicting_claims' : null };
          next.phase = next.current.reason ? 'groupDone' : 'validate';
        } else if (next.phase === 'validate') {
          const current = next.current, claim = current.claim, id = claimSlotId(s, claim.block, claim.patterns[current.index]);
          const slot = get('claimSlots', `${window}/${id}`);
          // Match the existing priority across every slot in the plot.
          const reason = !slot ? 'not_a_slot' : (state.publicMintGet || claimsNeverCloseActive(s, counted)) && publicTaken(working, slot) ? 'public_minted' : get('finds', id) || get('claimReservations', id) ? 'already_found' : (() => {
            const draw = get('headerAwards', slot.block);
            return draw && BigInt(draw.senderCount ?? '0') > 0n && compareOrdinal(slot.pattern, draw.catalog.nextNumber) < 0 ? 'header_awarded' : null;
          })();
          const priority = ['not_a_slot', 'public_minted', 'already_found', 'header_awarded'];
          if (reason && (!current.reason || priority.indexOf(reason) < priority.indexOf(current.reason))) current.reason = reason;
          // A claim admitted while an earlier window was still closing may
          // first learn that header award here. Materialize the original draw,
          // with its original height and policy, just as admission would have.
          if (reason === 'header_awarded') queueHeaderFind({ state: working, slot, pattern: { number: slot.pattern }, height: counted, settings: s });
          current.index++;
          if (current.index === claim.patterns.length) { current.index = 0; next.phase = current.reason ? 'groupDone' : 'tickets'; }
        } else if (next.phase === 'tickets') {
          const current = next.current, claim = current.claim, id = claimSlotId(s, claim.block, claim.patterns[current.index]);
          let pool = io.get(`pool/${id}`);
          if (!pool) {
            io.set(`slots/${next.slots}`, id); next.slots = String(BigInt(next.slots) + 1n); pool = { sole: claim.agent };
          } else if (pool.sole !== claim.agent) {
            const tree = orderedIndex(io, `tickets/${id}`);
            current.ticket ??= tree.insertion(pool.sole ? tree.insert(null, pool.sole) : pool.root, claim.agent);
            const result = tree.insertStep(current.ticket); if (!result) return;
            pool = { root: result.root }; delete current.ticket;
          }
          io.set(`pool/${id}`, pool);
          current.index++; if (current.index === claim.patterns.length) next.phase = 'groupDone';
        } else if (next.phase === 'groupDone') {
          io.set(`reason/${next.current.key}`, next.current.reason ?? 'entered');
          next.group = String(BigInt(next.group) + 1n); delete next.current; next.phase = 'groups';
        } else if (next.phase === 'headers') {
          const old = event.headerSenders ?? [], total = BigInt(old.length) + BigInt(event.headerCount ?? 0);
          if (BigInt(next.header) === total) { next.headerCount = String(orderedIndex(io, 'senders').count(next.headerRoot)); next.header = '0'; next.phase = 'headerPages'; return; }
          const index = BigInt(next.header), agent = index < BigInt(old.length) ? old[Number(index)] : get('headerInputs', `${window}/${index - BigInt(old.length)}`);
          assert(agent, 'header_input_missing'); const tree = orderedIndex(io, 'senders');
          next.headerTask ??= tree.insertion(next.headerRoot, agent);
          const result = tree.insertStep(next.headerTask); if (!result) return;
          next.headerRoot = result.root; delete next.headerTask;
          next.header = String(index + 1n);
        } else if (next.phase === 'headerPages') {
          if (next.header === next.headerCount) { flush(); next.phase = 'outcomes'; return; }
          const tree = orderedIndex(io, 'senders'); next.headerSelection ??= tree.selection(next.headerRoot, next.header);
          const agent = tree.selectStep(next.headerSelection); if (!agent) return;
          emit('headers', agent); next.header = String(BigInt(next.header) + 1n); delete next.headerSelection;
        } else if (next.phase === 'outcomes') {
          if (next.row === next.rows) { flush(); next.phase = 'winners'; return; }
          const row = io.get(`rows/${next.row}`), reason = io.get(`reason/${row.group}`); assert(reason, 'closure_outcome_missing');
          emit('claims', { ...row.claim, reason }); next.row = String(BigInt(next.row) + 1n);
        } else if (next.phase === 'winners') {
          if (next.slot === next.slots) { flush(); next.phase = 'finalize'; return; }
          const id = io.get(`slots/${next.slot}`), pool = io.get(`pool/${id}`), tree = orderedIndex(io, `tickets/${id}`), count = pool.sole ? 1n : tree.count(pool.root);
          assert(count > 0n && count <= BigInt(Number.MAX_SAFE_INTEGER), 'closure_ticket_count');
          let winner = pool.sole;
          if (!winner) {
            next.winnerSelection ??= tree.selection(pool.root, randomIndex(next.seed, `claim-v2:${window}:${id}`, Number(count)));
            winner = tree.selectStep(next.winnerSelection); if (!winner) return; delete next.winnerSelection;
          }
          const slot = get('claimSlots', `${window}/${id}`);
          // A public scan can take the slot between bounded closure chunks.
          if (slot && (state.publicMintGet || claimsNeverCloseActive(s, counted)) && publicTaken(working, slot)) { next.slot = String(BigInt(next.slot) + 1n); return; }
          assert(slot && !get('claimReservations', id), 'closure_reservation');
          set('claimReservations', id, { window, winner });
          emit('winners', { ...slot, winner, source: 'claim', tickets: clock.value(String(count)), reason: 'won' });
          next.winnersTree = appendFrontier(next.winnersTree, stableJSON(id)); next.winners = clock.add(next.winners);
          next.slot = String(BigInt(next.slot) + 1n);
        } else if (next.phase === 'finalize') {
          // The final draw's authenticated path reads and write belong to the
          // same meter as every earlier closure unit.
          set('headerAwards', window, drawFor(next)); next.phase = 'done';
        } else assert(false, 'closure_phase');
      });
    } catch (error) {
      if (error.message !== 'closure_budget') throw error;
      assert(progressed || budget.steps > 0, 'closure_minimum_progress'); break;
    }
    Object.assign(state, working); c = next; progressed = true; budget.steps++;
  }
  event.closing = c;
  if (c.phase === 'done' && c.void) {
    event.closed = true; event.void = true; delete event.closing;
    const inputRoot = merkleRoot(Object.entries(event.receiptChains ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(stableJSON));
    completed = { window, root: merkleRoot([]), inputRoot, pages: clock.zero, claims: clock.value(c.rows), winners: clock.zero,
      void: true, reason: 'chain_mismatch', draw: { window, void: true, reason: 'chain_mismatch' } };
  } else if (c.phase === 'done') {
    event.root = frontierRoot(c.pagesTree); event.inputRoot = frontierRoot(c.inputsTree); event.pages = c.pages;
    event.closed = true; event.seed = c.seed; event.total = c.winners; event.claimCount = clock.value(c.rows);
    const draw = drawFor(c); delete event.closing;
    completed = { window, root: event.root, inputRoot: event.inputRoot, pages: event.pages, claims: event.claimCount, winners: event.total, draw };
  }
  const after = budget.snapshot();
  return { completed, progress: { window, phase: c.phase, ...Object.fromEntries(Object.keys(before).map(k => [k, after[k] - before[k]])) } };
}
