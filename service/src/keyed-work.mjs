import { check } from './util.mjs';

// Only the same identity excludes another operation. Browser requests never
// queue behind a background operation; an identical retry can read its state.
export class KeyedWork {
  pending = new Map();
  constructor({ concurrency = Infinity, capacity = Infinity } = {}) {
    check(concurrency > 0 && capacity >= concurrency, 'work_capacity');
    Object.assign(this, { concurrency, capacity }); this.active = 0; this.waiting = [];
  }
  run(key, task, { join = false } = {}) {
    const active = this.pending.get(key);
    if (active) {
      if (join) return active;
      return Promise.reject(Object.assign(Error('resource_busy'), { status: 503, retryAfterMs: 1000 }));
    }
    if (this.pending.size >= this.capacity) return Promise.reject(Object.assign(Error('resource_busy'), { status: 503, retryAfterMs: 1000 }));
    const slot = this.active < this.concurrency ? (this.active++, Promise.resolve()) : new Promise(resolve => this.waiting.push(resolve));
    const work = slot.then(task).finally(() => {
      this.pending.delete(key);
      const next = this.waiting.shift(); if (next) next(); else this.active--;
    });
    this.pending.set(key, work); return work;
  }
  async drain() { await Promise.allSettled([...this.pending.values()]); }
}

export async function parallelPage(rows, task, concurrency = 4) {
  check(Number.isSafeInteger(concurrency) && concurrency > 0, 'work_concurrency');
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (next < rows.length) await task(rows[next++]);
  }));
  const failure = results.find(r => r.status === 'rejected');
  if (failure) throw failure.reason;
}
