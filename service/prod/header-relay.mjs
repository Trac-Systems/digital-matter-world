import { ordinalCodec } from '../../rules/src/integers-v2.js';
import { check, heightKey } from '../src/util.mjs';

// The cursor is the end of the durable queue, not an unverified Bitcoin tip.
// Each message depends on acceptance of its predecessor, including fork headers
// that have not yet accumulated enough work to become the contract's best chain.
export class HeaderRelay {
  constructor({ reads, store }) { Object.assign(this, { reads, store }); }
  async tick(outbox) {
    const { client, views, trac } = this.reads;
    const tip = await client.tip(), branch = await views.view(tip.height, tip.hash);
    const head = await trac('head'), deployment = await trac('deployment'), { beacon } = deployment, clock = ordinalCodec(!!deployment.v2);
    check(branch.hashAt(beacon.checkpoint.height) === beacon.checkpoint.hash, 'bitcoin_relay_checkpoint');
    const floor = clock.max(beacon.checkpoint.height, clock.add(head.counted, -Math.max(beacon.params.interval, beacon.params.branchDepth, beacon.params.confirmations)));
    let height = clock.min(head.tip.height, tip.height);
    while (clock.compare(height, floor) >= 0 && branch.hashAt(height) !== (clock.compare(height, head.tip.height) === 0 ? head.tip.hash : await trac('hashAt', [height]))) height = clock.add(height, -1);
    check(clock.compare(height, floor) >= 0, 'bitcoin_relay_reorg_window');

    const pending = this.store.list('outbox', { limit: outbox.maxJobs }).filter(r => r.value.op === 'hd');
    // Retire unsent/retrying work on the abandoned branch before sending again.
    for (const { id, value: job } of pending) if (branch.hashAt(job.height) !== job.hash) await this.store.put('outbox', id);
    let after;
    const cursor = this.store.get('meta', 'headerRelay');
    if (cursor && clock.compare(cursor.height, height) > 0 && branch.hashAt(cursor.height) === cursor.hash
      && (this.store.get('outbox', cursor.id) || this.store.get('sent', cursor.id))) { height = cursor.height; after = cursor.id; }
    // Recover a crash between persisting a message and advancing the cursor.
    for (const { id, value: job } of pending) if (clock.compare(job.height, height) > 0 && branch.hashAt(job.height) === job.hash) { height = job.height; after = id; }
    while (clock.compare(height, tip.height) < 0 && BigInt(this.store.countUint('outbox')) < BigInt(outbox.maxJobs)) {
      const end = clock.min(clock.add(height, 20), tip.height), hash = branch.hashAt(end), id = `header/${heightKey(end)}/${hash}`;
      const headers = Array.from({ length: Number(BigInt(end) - BigInt(height)) }, (_, i) => branch.raw(clock.add(height, i + 1)));
      await outbox.enqueue(id, 'hd', { headers }, { height: end, hash, ...(after ? { after } : {}) });
      await this.store.put('meta', 'headerRelay', { id, height: end, hash });
      height = end; after = id;
    }
  }
}
