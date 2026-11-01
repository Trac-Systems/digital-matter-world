import { check } from './util.mjs';

// Only the operator's local keyed registry is read. Source verification stays
// with registration/admission. Page/cursor publication shares one transaction.
export class PublicRegistry {
  constructor({ store, registry, rows = 128 }) {
    check(Number.isSafeInteger(rows) && rows > 0, 'public_registry_rows');
    Object.assign(this, { store, registry, rows });
  }
  async tick() {
    if (this.store.get('meta', 'ruleState')?.batchVersion !== 2) return;
    const registry = await this.registry();
    check(typeof registry.page === 'function', 'registry_migration_required');
    const revision = String(registry.revision), saved = this.store.get('meta', 'publicTickerRegistryCursor');
    if (saved?.revision === revision && saved.complete) return;
    const after = saved?.revision === revision ? saved.after : '';
    const rows = registry.page('assets', { after, limit: Math.min(this.rows, registry.settings.pageRows) });
    // Additional tickers, so reads can answer for a registered ticker before its first mint opens it on Trac.
    const tickers = [];
    for (const { id: asset } of rows) for (let next = ''; ;) {
      const page = registry.page('deployments/' + asset, { after: next, limit: registry.settings.pageRows });
      tickers.push(...page.map(({ id }) => ({ space: 'publicTickerDeployments', id, value: { asset, registryRevision: revision } })));
      if (page.length < registry.settings.pageRows) break; next = page.at(-1).id;
    }
    await this.store.transact([...tickers,
      { space: 'meta', id: 'publicRegistryRevision', value: revision },
      ...rows.map(({ id, value }) => ({ space: 'publicDeployments', id, value: {
        id: value.id, generation: value.generation, suspended: !!value.suspended, registryRevision: revision,
        source: 'registered_deployment', authorization: 'recheck_named_deployment',
      } })),
      { space: 'meta', id: 'publicTickerRegistryCursor', value: { revision, after: rows.at(-1)?.id ?? after, complete: !rows.length } },
    ]);
  }
}
