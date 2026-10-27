// Existing-sender checks mutate fixed numeric slots without allocating buckets.
export class Limiter {
  constructor({ capacity = 8192, burst = 8, perSecond = 2, ttl = 120000 } = {}) {
    Object.assign(this, { capacity, burst, perSecond, ttl }); this.keys = new Map(); this.names = new Array(capacity);
    this.tokens = new Float64Array(capacity); this.seen = new Float64Array(capacity); this.cursor = 0;
  }
  take(key, now = performance.now()) {
    let slot = this.keys.get(key);
    if (slot === undefined) {
      slot = this.cursor;
      if (this.names[slot] !== undefined && now - this.seen[slot] < this.ttl) return false;
      if (this.names[slot] !== undefined) this.keys.delete(this.names[slot]);
      this.names[slot] = key; this.keys.set(key, slot); this.tokens[slot] = this.burst; this.seen[slot] = now;
      this.cursor = (slot + 1) % this.capacity;
    }
    this.tokens[slot] = Math.min(this.burst, this.tokens[slot] + Math.max(0, now - this.seen[slot]) * this.perSecond / 1000);
    this.seen[slot] = now;
    if (this.tokens[slot] < 1) return false;
    this.tokens[slot]--; return true;
  }
}
