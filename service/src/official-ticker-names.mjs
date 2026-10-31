import { rules } from './rules.mjs';
import { check } from './util.mjs';

// Derived catalog index. The explicit offline rebuild seeds retained catalogs;
// accepted catalog writes maintain it thereafter. Runtime readers never scan.
export function officialCatalogNames(space, asset, row) {
  if (!row || !['patternsByAsset', 'compoundTypes', 'types'].includes(space)) return [];
  // v2 compounds have no automatic ticker: their first maker's choice is indexed when made.
  return [...new Set([row.name, space === 'types' ? rules.compoundTicker(asset) : row.name]
    .filter(name => typeof name === 'string').map(name => name.toLowerCase()))];
}
export function indexOfficialNames(store, { space, id, value }) {
  const names = officialCatalogNames(space, id, value);
  for (const name of names) {
    const row = { asset: id, name };
    store.putStmt.run('officialCatalogNames', name, JSON.stringify(row));
    if (store.evidenceReady) store.indexEvidence({ space: 'officialCatalogNames', id: name, value: row });
  }
}
export async function officialName(reads, store, name) {
  name = name.toLowerCase().replace(/^dmt-/, '');
  const context = await reads.rulesContext();
  check(context?.ready && rules.multiTickerActive(await reads.counted()), 'multi_ticker_inactive');
  check(await store.get('officialCatalogNameIndex', 'ready'), 'ticker_name_index_required');
  return await store.get('officialCatalogNames', name) ?? null;
}

// Operator maintenance only; no runtime caller imports or invokes a rebuild.
export async function rebuildOfficialNames(store) {
  for (const space of ['patternsByAsset', 'compoundTypes', 'types']) {
    let after = '';
    for (;;) {
      const rows = store.list(space, { after, limit: 128 });
      for (const { id, value } of rows) for (const name of officialCatalogNames(space, id, value))
        await store.put('officialCatalogNames', name, { asset: id, name });
      if (!rows.length) break; after = rows.at(-1).id;
    }
  }
  for (let after = ''; ;) {
    const rows = store.list('provisioning', { after, limit: 128 });
    for (const { id, value } of rows) if (value.chosenTicker?.tick) await store.put('officialCatalogNames', value.chosenTicker.tick, { asset: id, name: value.chosenTicker.tick });
    if (!rows.length) break; after = rows.at(-1).id;
  }
  await store.put('officialCatalogNameIndex', 'ready', { version: 1 });
}
