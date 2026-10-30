import { patternCatalogId } from './mint-assets.mjs';
import { rules } from './rules.mjs';
import { check } from './util.mjs';

const statements = new WeakMap();
// Only fixed projection SQL is cached; connections own their statement lifetime.
export function projectionStatement(db, sql) {
  let cache = statements.get(db);
  if (!cache) statements.set(db, cache = new Map());
  let statement = cache.get(sql);
  if (!statement) cache.set(sql, statement = db.prepare(sql));
  return statement;
}
export function flushProjectionRevisions(store) {
  for (const [scope, revision] of store.projectionRevisions ?? []) writeRevision(store, scope, revision);
  store.projectionRevisions?.clear();
}
const writeRevision = (store, scope, revision) => projectionStatement(store.db,
  'INSERT INTO projectionRevisions VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision').run(scope, revision);

// These indexes share the journal transaction's SQLite commit. They never
// advance before the records they describe, including during crash recovery.
export function projectionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS projectionRevisions(scope TEXT PRIMARY KEY,revision TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS projectionPending(scope TEXT,event TEXT,PRIMARY KEY(scope,event)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS projectionPendingEvent ON projectionPending(event,scope);
    CREATE TABLE IF NOT EXISTS projectionAttribution(asset TEXT PRIMARY KEY,owner TEXT) WITHOUT ROWID;`);
  db.exec('CREATE TABLE IF NOT EXISTS projectionControl(id INTEGER PRIMARY KEY,ready INTEGER NOT NULL,cursor TEXT)');
  projectionStatement(db, `INSERT OR IGNORE INTO projectionControl VALUES(1,?,NULL)`).run(
    projectionStatement(db, "SELECT 1 FROM records WHERE space='meta' AND id='ruleState' AND json_extract(value,'$.batchVersion')=2").get() ? 0 : 1);
}
export const projectionRevision = (store, scope) => store.projectionRevisions?.get(scope) ?? projectionStatement(store.db, 'SELECT revision FROM projectionRevisions WHERE scope=?').get(scope)?.revision ?? '0';
export function bumpProjection(store, scope) {
  const revision = rules.nextUint(projectionRevision(store, scope));
  if (store.projectionRevisions) {
    if (store.projectionRevisions.size >= 256) flushProjectionRevisions(store);
    store.projectionRevisions.set(scope, revision);
  } else writeRevision(store, scope, revision);
}
export function projectionReady(store, ...scopes) {
  check(projectionStatement(store.db, 'SELECT ready FROM projectionControl WHERE id=1').get()?.ready === 1, 'public_projection_migration_required', 503);
  for (const scope of scopes) check(!projectionStatement(store.db, 'SELECT 1 FROM projectionPending WHERE scope=? LIMIT 1').get(scope), 'public_projection_pending', 503);
}
const values = x => Array.isArray(x) ? x : Object.values(x ?? {});
export function eventScopes(event, get) {
  const scopes = new Set(['publicEvents']);
  const add = (...names) => names.forEach(x => scopes.add(x));
  for (const row of [...values(event.occurrences), ...values(event.finds)]) {
    const asset = row.pattern != null ? rules.patternAssetV2(rules.decimalV2(row.pattern)) : row.asset, height = rules.decimalV2(row.block);
    add('claimed2/' + asset, 'claimedAt2/' + rules.uintKeyV2(height), 'world', 'block/' + height);
    if (row.finder) add('catalogAgents', 'agent/' + row.finder, 'findsByAgent/' + row.finder, 'agentAssets/' + row.finder, 'rankings');
  }
  for (const { record } of values(event.discoveries)) {
    const asset = rules.patternAssetV2(record.number), previous = get('catalogPatterns', asset);
    add('catalogPatterns', 'pattern/' + asset);
    for (const owner of [record.discoverer, previous?.discoverer, get('queuedAttribution', asset)].filter(Boolean))
      add('catalogAgents', 'agent/' + owner, 'discoveriesByAgent/' + owner);
  }
  if (values(event.types).length || values(event.refinements).length) add('catalogTypes', 'rankings');
  for (const row of event.agents ?? []) add('agentAssets/' + row.owner, 'agent/' + row.owner);
  for (const row of event.crafts ?? []) add('catalogAgents', 'agent/' + (row.action?.owner ?? row.agent));
  for (const row of event.financial ?? []) if (row.data?.owner) add('catalogAgents', 'agent/' + row.data.owner);
  for (const height of event.links ?? []) add('world', 'block/' + rules.decimalV2(height));
  return scopes;
}
export function projectRevision(store, op) {
  const { db } = store, id = String(op.id);
  const bump = scope => bumpProjection(store, scope);
  bump(op.space);
  // Point readers need not invalidate on another member of the collection.
  bump(op.space + '/' + id);
  if (op.space === 'accountRecords' && (id.startsWith('fq/') || id === 'fr/active') ||
    op.space === 'meta' && id === 'financialRecoveryActive') bump('financialHealth');
  if (op.space === 'feedBlockChanges') {
    const event = 'block-change/' + id;
    const old = projectionStatement(db, 'SELECT scope FROM projectionPending WHERE event=?').all(event);
    projectionStatement(db, 'DELETE FROM projectionPending WHERE event=?').run(event);
    for (const { scope } of old) bump(scope);
    if (op.value) {
      const scopes = ['world', 'block/' + rules.decimalV2(op.value.block), ...(op.value.asset ? ['claimed2/' + (patternCatalogId(op.value.asset) ?? op.value.asset)] : ['links'])];
      for (const scope of scopes) { projectionStatement(db, 'INSERT OR IGNORE INTO projectionPending VALUES(?,?)').run(scope, event); bump(scope); }
    }
  }
  if (op.space === 'feedEvents') {
    // Replacement is supported, but an event's new fence is always installed
    // atomically with its contents. Deletion releases exactly its own scopes.
    const old = projectionStatement(db, 'SELECT scope FROM projectionPending WHERE event=?').all(id);
    projectionStatement(db, 'DELETE FROM projectionPending WHERE event=?').run(id);
    for (const { scope } of old) bump(scope);
    if (op.value && store.get('meta', 'ruleState')?.batchVersion === 2)
      for (const scope of eventScopes(op.value, (space, key) => space === 'queuedAttribution' ? projectionStatement(db, 'SELECT owner FROM projectionAttribution WHERE asset=?').get(key)?.owner : store.get(space, key))) {
        projectionStatement(db, 'INSERT OR IGNORE INTO projectionPending VALUES(?,?)').run(scope, id); bump(scope);
      }
    for (const { record } of values(op.value?.discoveries)) projectionStatement(db, 'INSERT OR REPLACE INTO projectionAttribution VALUES(?,?)').run(rules.patternAssetV2(record.number), record.discoverer ?? null);
  }
}
