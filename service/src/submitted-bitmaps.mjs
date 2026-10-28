import { check, heightKey, serial } from './util.mjs';
import { rules } from './rules.mjs';

// The service verifies one named block. Wallet discovery belongs to the agent;
// neither a read nor maintenance creates a historical wallet-list subscription.
export class SubmittedBitmaps {
  constructor({ store, verify, settings = {} }) {
    Object.assign(this, { store, verify, settings }); this.gate = serial();
  }
  submit(input) { return this.gate(async () => {
    check(input && Object.keys(input).every(k => ['block', 'inscription'].includes(k)), 'bitmap_submission');
    const block = rules.decimalV2(input.block);
    check(input.inscription === undefined || /^[0-9a-f]{64}i(0|[1-9][0-9]*)$/.test(input.inscription), 'bitmap_inscription');
    const value = await this.verify(block, input.inscription);
    check(value && value.block === block && /^[0-9a-f]{64}$/.test(value.agent) &&
      /^[0-9a-f]{64}i(0|[1-9][0-9]*)$/.test(value.inscription) && typeof value.address === 'string' &&
      /^[0-9a-f]{64}$/.test(value.snapshot?.hash), 'bitmap_verification');
    rules.decimalV2(value.snapshot.height);
    await this.store.put('submittedBitmaps', rules.uintKeyV2(block), value);
    return { ...value, completeness: 'submitted_items_only', authorization: 'recheck_named_item' };
  }); }
  async tick() {
    const after = this.store.get('meta', 'submittedBitmapCursor') ?? '';
    const rows = this.store.list('submittedBitmaps', { after, limit: this.settings.walletItemsPerTick ?? 16 });
    for (const { id, value } of rows) {
      try { await this.submit({ block: value.block, inscription: value.inscription }); }
      catch { await this.gate(async () => {
        if (JSON.stringify(this.store.get('submittedBitmaps', id)) === JSON.stringify(value)) await this.store.put('submittedBitmaps', id, { ...value, stale: true });
      }); }
      await this.store.put('meta', 'submittedBitmapCursor', id);
    }
    if (!rows.length && after) await this.store.put('meta', 'submittedBitmapCursor', '');
  }
}

export function bitmapFresh(store, row) {
  if (!row || row.stale) return false;
  const head = store.get('meta', 'head');
  if (!head || String(head.tip) !== String(row.snapshot.height) || head.hash !== row.snapshot.hash) return false;
  return store.get('headers', heightKey(row.snapshot.height))?.hash === row.snapshot.hash;
}
