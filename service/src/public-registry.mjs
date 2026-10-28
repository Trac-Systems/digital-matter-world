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
    const revision = String(registry.revision), saved = this.store.get('meta', 'publicRegistryCursor');
    if (saved?.revision === revision && saved.complete) return;
    const after = saved?.revision === revision ? saved.after : '';
    const rows = registry.page('assets', { after, limit: Math.min(this.rows, registry.settings.pageRows) });
    await this.store.transact([
      { space: 'meta', id: 'publicRegistryRevision', value: revision },
      ...rows.map(({ id, value }) => ({ space: 'publicDeployments', id, value: {
        id: value.id, generation: value.generation, suspended: !!value.suspended, registryRevision: revision,
        source: 'registered_deployment', authorization: 'recheck_named_deployment',
      } })),
      { space: 'meta', id: 'publicRegistryCursor', value: { revision, after: rows.at(-1)?.id ?? after, complete: !rows.length } },
    ]);
  }
}
