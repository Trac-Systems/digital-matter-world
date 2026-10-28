import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { R3_RESOURCES } from './r3-settings.mjs';

// A durable page cursor over the registry's treasury-address index. Ordinary
// pages only read the published row; they never trigger this source work.
export class PublicSummaries {
  constructor({ store, reads, rows = R3_RESOURCES.ownerRefreshRows, refreshMs = R3_RESOURCES.ownerRefreshMs, now = Date.now }) {
    check(Number.isSafeInteger(rows) && rows > 0 && Number.isSafeInteger(refreshMs) && refreshMs > 0, 'public_summary_settings');
    Object.assign(this, { store, reads, rows, refreshMs, now });
  }
  async tick() {
    if (this.store.get('meta', 'ruleState')?.batchVersion !== 2 || !this.reads.publicTreasuryAccount || !this.reads.publicExternalSupply) return;
    const registry = await this.reads.registry(); check(typeof registry.page === 'function', 'registry_migration_required');
    const revision = String(registry.revision), now = this.now();
    let cursor = this.store.get('meta', 'publicSummaryCursor');
    if (cursor?.revision === revision && cursor.complete && now - cursor.completedAt < this.refreshMs) return;
    if (!cursor || cursor.revision !== revision || cursor.complete) cursor = { revision, phase: 0, after: '', tap: '0', erc20: '0',
      bitcoin: null, ethereum: null, startedAt: now, accounts: '0', complete: false };
    const rail = ['tap', 'ethereum'][cursor.phase], field = rail === 'tap' ? 'tap' : 'erc20';
    const page = registry.page('treasury/' + rail, { after: cursor.after, limit: Math.min(this.rows, registry.settings.pageRows) });
    const writes = [];
    for (const { id } of page) {
      const fact = await this.reads.publicTreasuryAccount(rail, id);
      check(fact.rail === rail && fact.address === id && typeof fact.balance === 'string' && /^(0|[1-9][0-9]*)$/.test(fact.balance) && fact.anchor, 'public_treasury_fact');
      cursor[field] = String(BigInt(cursor[field]) + BigInt(fact.balance)); cursor.accounts = rules.nextUint(cursor.accounts);
      cursor[rail === 'tap' ? 'bitcoin' : 'ethereum'] ??= id; cursor.after = id;
      writes.push({ space: 'publicTreasuryFacts', id: rail + '/' + id, value: { ...fact, registryRevision: revision, checkedAt: now } });
    }
    if (page.length < Math.min(this.rows, registry.settings.pageRows)) { cursor.phase++; cursor.after = ''; }
    if (cursor.phase === 2) {
      const supply = await this.reads.publicExternalSupply();
      check(typeof supply.ethereum === 'string' && /^(0|[1-9][0-9]*)$/.test(supply.ethereum) && supply.anchor, 'public_supply_fact');
      cursor.complete = true; cursor.completedAt = now;
      writes.push({ space: 'publicSummaries', id: 'treasury', value: { tap: cursor.tap, erc20: cursor.erc20,
        bitcoin: cursor.bitcoin, ethereum: cursor.ethereum, accounts: cursor.accounts, registryRevision: revision,
        startedAt: cursor.startedAt, checkedAt: now, meaning: 'independently_verified_address_balances' } },
      { space: 'publicSummaries', id: 'externalSupply', value: { ...supply, checkedAt: now } });
    }
    check(String((await this.reads.registry()).revision) === revision, 'public_registry_changed');
    writes.push({ space: 'meta', id: 'publicSummaryCursor', value: cursor });
    await this.store.transact(writes);
  }
}
