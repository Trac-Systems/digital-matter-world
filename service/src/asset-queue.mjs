import { check, hash, serial } from './util.mjs';
import { rules } from './rules.mjs';

const stamp = n => { check(Number.isSafeInteger(n) && n >= 0, 'queue_time'); return String(n).padStart(16, '0'); };
// Durable per-class, per-agent round robin. Jobs retain their stable identity
// through retries and expired leases. A lease expiry never releases money.
export class AssetQueue {
  constructor({ store, name, capacity = 2000, perAgent = 8, leaseMs = 30000, visitBudget = 128, now = Date.now }) {
    check(/^[a-z][a-z0-9-]*$/.test(name) && [capacity, perAgent, leaseMs, visitBudget].every(n => Number.isSafeInteger(n) && n > 0), 'queue_settings');
    Object.assign(this, { store, name, capacity, perAgent, leaseMs, visitBudget, now }); this.gate = serial();
    this.jobs = 'queueJobs/' + name; this.agents = 'queueAgents/' + name; this.meta = 'queueMeta/' + name;
  }
  ownerSpace(owner) { return 'queueDue/' + this.name + '/' + hash(owner); }
  enqueue(id, owner, payload, due = this.now()) { return this.gate(async () => {
    check(typeof id === 'string' && id.length > 0 && typeof owner === 'string' && owner.length > 0, 'queue_identity');
    const digest = hash(rules.stableJSON([owner, payload])), old = this.store.get(this.jobs, id);
    if (old) { check(old.digest === digest, 'queue_conflict'); return old; }
    const count = this.store.get(this.meta, 'count') ?? 0, agent = this.store.get(this.agents, owner) ?? 0;
    check(count < this.capacity, 'queue_capacity', 503); check(agent < this.perAgent, 'queue_agent_capacity', 429);
    const key = stamp(due) + '/' + id, row = { id, owner, payload, digest, due, key, revision: '0', state: 'queued', created: this.now() };
    await this.store.transact([{ space: this.jobs, id, value: row }, { space: this.ownerSpace(owner), id: key, value: id },
      { space: this.agents, id: owner, value: agent + 1 }, { space: this.meta, id: 'count', value: count + 1 }]);
    return row;
  }); }
  claim() { return this.gate(async () => {
    let cursor = this.store.get(this.meta, 'cursor') ?? '', visited = 0;
    const now = this.now(), visitedOwners = new Set();
    while (visited++ < this.visitBudget) {
      let agent = this.store.list(this.agents, { after: cursor, limit: 1 })[0];
      if (!agent) agent = this.store.list(this.agents, { limit: 1 })[0];
      if (!agent) return null;
      if (visitedOwners.has(agent.id)) return null;
      visitedOwners.add(agent.id);
      cursor = agent.id;
      const head = this.store.list(this.ownerSpace(cursor), { limit: 1 })[0], row = head && this.store.get(this.jobs, head.value);
      check(!head || row && row.key === head.id && row.owner === cursor, 'queue_index');
      if (!row || row.due > now) { await this.store.put(this.meta, 'cursor', cursor); continue; }
      const due = now + this.leaseMs, key = stamp(due) + '/' + row.id;
      const leased = { ...row, state: 'leased', revision: (BigInt(row.revision) + 1n).toString(), due, key };
      await this.store.transact([{ space: this.jobs, id: row.id, value: leased }, { space: this.ownerSpace(cursor), id: row.key },
        { space: this.ownerSpace(cursor), id: key, value: row.id }, { space: this.meta, id: 'cursor', value: cursor }]);
      return leased;
    }
    return null;
  }); }
  finish(lease, outcome) { return this.gate(async () => {
    const row = this.store.get(this.jobs, lease.id);
    check(row?.state === 'leased' && row.revision === lease.revision && row.digest === lease.digest, 'queue_lease');
    check(['complete', 'credit', 'refunded', 'rejected'].includes(outcome?.state) && typeof outcome.evidence === 'string' && outcome.evidence.length > 0, 'queue_terminal');
    const count = this.store.get(this.meta, 'count'), agent = this.store.get(this.agents, row.owner);
    check(count > 0 && agent > 0, 'queue_count');
    await this.store.transact([{ space: this.jobs, id: row.id, value: { ...row, state: outcome.state, outcome, finished: this.now() } },
      { space: this.ownerSpace(row.owner), id: row.key }, { space: this.agents, id: row.owner, ...(agent > 1 ? { value: agent - 1 } : {}) },
      { space: this.meta, id: 'count', value: count - 1 }]);
  }); }
  retry(lease, due, reason) { return this.gate(async () => {
    const row = this.store.get(this.jobs, lease.id);
    check(row?.state === 'leased' && row.revision === lease.revision && row.digest === lease.digest, 'queue_lease');
    const key = stamp(due) + '/' + row.id;
    await this.store.transact([{ space: this.jobs, id: row.id, value: { ...row, state: 'queued', due, key, reason } },
      { space: this.ownerSpace(row.owner), id: row.key }, { space: this.ownerSpace(row.owner), id: key, value: row.id }]);
  }); }
}
