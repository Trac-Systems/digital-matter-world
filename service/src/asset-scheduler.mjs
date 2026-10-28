// Independent bounded lanes: a slow paid/source task cannot delay a ready
// reveal's next attempt. Each lane has one in-flight call; signing itself stays
// serialized by Committee.signatureGate. No unbounded Promise fanout.
export class AssetScheduler {
  constructor({ intervalMs = 1000, onError = async () => {}, onSuccess = async () => {} } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw Error('scheduler_interval');
    Object.assign(this, { intervalMs, onError, onSuccess }); this.lanes = new Map(); this.closed = false;
  }
  add(name, task, intervalMs = this.intervalMs) {
    if (this.closed || this.lanes.has(name) || !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw Error('scheduler_lane');
    const lane = { name, task, intervalMs, timer: null, work: Promise.resolve() }; this.lanes.set(name, lane);
    const run = async () => {
      try { await task(); await this.onSuccess(name); }
      catch (error) { try { await this.onError(error, name); } catch { /* Retry the lane even if its status store is unavailable. */ } }
      finally { if (!this.closed) lane.timer = setTimeout(() => { lane.work = run(); }, intervalMs); }
    };
    lane.work = run(); return this;
  }
  async close() {
    this.closed = true;
    for (const lane of this.lanes.values()) clearTimeout(lane.timer);
    await Promise.allSettled([...this.lanes.values()].map(lane => lane.work));
  }
}
