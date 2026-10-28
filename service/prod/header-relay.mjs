import { check, heightKey } from '../src/util.mjs';

// The cursor is the end of the durable queue, not an unverified Bitcoin tip.
// Each message depends on acceptance of its predecessor, including fork headers
// that have not yet accumulated enough work to become the contract's best chain.
export class HeaderRelay {
  constructor({ reads, store }) { Object.assign(this, { reads, store }); }
  async tick(outbox, observation) {
    const { client, views, trac } = this.reads;
    const tip = observation ? { height: observation.tip, hash: observation.tipHash } : await client.tip(), branch = observation?.branch ?? await views.view(tip.height, tip.hash);
    const head = await trac('head'), { beacon } = await trac('deployment');
    check(branch.hashAt(beacon.checkpoint.height) === beacon.checkpoint.hash, 'bitcoin_relay_checkpoint');
    const floor = Math.max(beacon.checkpoint.height, head.counted - Math.max(beacon.params.interval, beacon.params.branchDepth, beacon.params.confirmations));
    let height = Math.min(head.tip.height, tip.height);
    while (height >= floor && branch.hashAt(height) !== (height === head.tip.height ? head.tip.hash : await trac('hashAt', [height]))) height--;
    check(height >= floor, 'bitcoin_relay_reorg_window');

    const pending = this.store.list('outbox', { limit: outbox.maxJobs }).filter(r => r.value.op === 'hd');
    // Retire unsent/retrying work on the abandoned branch before sending again.
    for (const { id, value: job } of pending) if (branch.hashAt(job.height) !== job.hash) await this.store.put('outbox', id);
    let after;
    const cursor = this.store.get('meta', 'headerRelay');
    if (cursor && cursor.height > height && branch.hashAt(cursor.height) === cursor.hash
      && (this.store.get('outbox', cursor.id) || this.store.get('sent', cursor.id))) { height = cursor.height; after = cursor.id; }
    // Recover a crash between persisting a message and advancing the cursor.
    for (const { id, value: job } of pending) if (job.height > height && branch.hashAt(job.height) === job.hash) { height = job.height; after = id; }
    while (height < tip.height && this.store.count('outbox') < outbox.maxJobs) {
      const end = Math.min(height + 20, tip.height), hash = branch.hashAt(end), id = `header/${heightKey(end)}/${hash}`;
      const headers = Array.from({ length: end - height }, (_, i) => branch.raw(height + i + 1));
      await outbox.enqueue(id, 'hd', { headers }, { height: end, hash, ...(after ? { after } : {}) });
      await this.store.put('meta', 'headerRelay', { id, height: end, hash });
      height = end; after = id;
    }
  }
}
