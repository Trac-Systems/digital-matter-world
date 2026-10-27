import { assert, hash, stableJSON, hex, integer, compare } from './core.js';
import { validateDefinition, PATTERN_LIMITS, countWith, tierFor } from './patterns.js';
import { recordGet, recordSet, recordDelete } from './record-index.js';
export const DISCOVERY_LIMITS = Object.freeze({ work: 4096, queue: 64, registry: 256, lifetime: 144 });
export function discoveryCommitment(proposal, salt, agent) {
  validateDefinition(proposal); assert(hex(salt, 32) && hex(agent, 32), 'discovery_commitment');
  return hash(stableJSON(['dmw-discovery-v1', proposal, salt, agent]));
}
export const discoveryOrder = (a, b) => a.tip - b.tip || compare(a.commitment, b.commitment) || compare(a.agent, b.agent);
export function queueDiscovery(state, move, tip, height, table, snapshotHash) {
  const p = move.p;
  if (move.t === 'discovery-commit') {
    const commitments = (state.discoveryCommits ?? []).filter(c => tip <= c.tip + DISCOVERY_LIMITS.lifetime);
    assert(commitments.length < DISCOVERY_LIMITS.queue && !commitments.some(c => c.agent === move.a && c.commitment === p.commitment), 'discovery_commit_budget');
    state.discoveryCommits = [...commitments, { agent: move.a, commitment: p.commitment, tip }].sort(discoveryOrder);
    return;
  }
  assert(move.t === 'discovery-reveal', 'discovery_commit_required');
  const commitment = discoveryCommitment(p.proposal, p.salt, move.a);
  const c = (state.discoveryCommits ?? []).find(c => c.agent === move.a && c.commitment === commitment);
  assert(c && tip >= c.tip + 2 && tip <= c.tip + DISCOVERY_LIMITS.lifetime, 'discovery_reveal_window');
  assert(!new RegExp(p.proposal.pat).test(''), 'pattern_nullable');
  assert(table.length < DISCOVERY_LIMITS.registry && (state.discoveryQueue ?? []).length < DISCOVERY_LIMITS.queue, 'discovery_queue_budget');
  assert(!table.some(r => r.name === p.proposal.name), 'pattern_exists');
  assert(hex(snapshotHash, 32), 'discovery_snapshot');
  state.discoveryCommits = state.discoveryCommits.filter(x => x !== c);
  state.discoveryQueue = [...(state.discoveryQueue ?? []), { ...c, proposal: p.proposal, height, snapshotHash }].sort(discoveryOrder);
}
const keyFor = p => hash(stableJSON([p.pat, p.fld, p.dt]));
// Each call performs at most work count evaluations. Cached indexes extend only
// over new headers. A changed boundary hash invalidates a branch's index.
export function advanceDiscovery(state, table, history, height, maxAccept = 1, work = DISCOVERY_LIMITS.work) {
  assert(integer(work, DISCOVERY_LIMITS.work) && work > 0, 'discovery_work');
  let remaining = work, indexes = state.discoveryIndexes ?? {}, queue = [...(state.discoveryQueue ?? [])];
  const accepted = [], rejected = [];
  while (queue.length && accepted.length < maxAccept) {
    const job = queue[0];
    // Wait for earlier unrevealed commitments, preventing a later fast reveal
    // from taking attribution. Expired commitments cannot stall the queue.
    if ((state.discoveryCommits ?? []).some(c => state.highestTip <= c.tip + DISCOVERY_LIMITS.lifetime && discoveryOrder(c, job) < 0)) break;
    const snapshotHeight = job.height, snapshotHash = history.get(snapshotHeight).hash;
    if (job.snapshotHash && job.snapshotHash !== snapshotHash) { queue.shift(); rejected.push({ commitment: job.commitment, reason: 'discovery_snapshot_reorg' }); if (!table.some(p => keyFor(p) === keyFor(job.proposal))) indexes = recordDelete(indexes, keyFor(job.proposal)); continue; }
    const definitions = [job.proposal, ...table];
    let ready = true;
    for (const definition of definitions) {
      const key = keyFor(definition);
      let entry = recordGet(indexes, key);
      if (entry && (entry.length > snapshotHeight + 1 || history.get(entry.length - 1).hash !== entry.hash)) entry = null;
      entry = { ...(entry ?? { length: 0, fingerprint: hash('dmw-count-vector-v1'), rarity: 0, total: 0, first: null, varies: false }) };
      const re = new RegExp(definition.pat, 'g');
      while (entry.length <= snapshotHeight && remaining) {
        const n = countWith(re, history.field(entry.length, definition.fld, definition.dt));
        entry.first ??= n; entry.varies ||= n !== entry.first; entry.rarity += n ? 1 : 0; entry.total += n;
        entry.fingerprint = hash(`${entry.fingerprint}:${n}`); entry.length++; remaining--;
      }
      if (entry.length) entry.hash = history.get(entry.length - 1).hash;
      indexes = recordSet(indexes, key, entry);
      if (entry.length !== snapshotHeight + 1) { ready = false; break; }
    }
    if (!ready) break;
    const a = recordGet(indexes, keyFor(job.proposal));
    const reason = table.length >= DISCOVERY_LIMITS.registry ? 'discovery_registry_budget' : !a.varies ? 'pattern_constant' : a.rarity < PATTERN_LIMITS.minMatchingBlocks ? 'pattern_too_rare' :
      table.some(p => p.name === job.proposal.name) ? 'pattern_exists' :
      table.some(p => recordGet(indexes, keyFor(p)).fingerprint === a.fingerprint) ? 'pattern_duplicate' : null;
    queue.shift();
    if (reason) { rejected.push({ commitment: job.commitment, reason }); if (!table.some(p => keyFor(p) === keyFor(job.proposal))) indexes = recordDelete(indexes, keyFor(job.proposal)); }
    else {
      const number = table.reduce((n, p) => Math.max(n, p.number + 1), 0);
      const record = { ...job.proposal, number, discoverer: job.agent, rarity: a.rarity, total: a.total, tier: tierFor(a.rarity),
        historyHeight: snapshotHeight, historyHash: snapshotHash, fingerprint: a.fingerprint };
      table.push(record); accepted.push({ record, commitment: job.commitment });
    }
    if (!remaining) break;
  }
  state.discoveryIndexes = indexes; state.discoveryQueue = queue;
  return { accepted, rejected, work: work - remaining, queued: queue.length };
}
