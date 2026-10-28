import { rules } from './rules.mjs';
import { check } from './util.mjs';

// These indexes share the journal transaction's SQLite commit. They never
// advance before the records they describe, including during crash recovery.
export function projectionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS projectionRevisions(scope TEXT PRIMARY KEY,revision TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS projectionPending(scope TEXT,event TEXT,PRIMARY KEY(scope,event)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS projectionPendingEvent ON projectionPending(event,scope);
    CREATE TABLE IF NOT EXISTS projectionAttribution(asset TEXT PRIMARY KEY,owner TEXT) WITHOUT ROWID;`);
  db.exec('CREATE TABLE IF NOT EXISTS projectionControl(id INTEGER PRIMARY KEY,ready INTEGER NOT NULL,cursor TEXT)');
  db.prepare(`INSERT OR IGNORE INTO projectionControl VALUES(1,?,NULL)`).run(
    db.prepare("SELECT 1 FROM records WHERE space='meta' AND id='ruleState' AND json_extract(value,'$.batchVersion')=2").get() ? 0 : 1);
}
export const projectionRevision = (store, scope) => store.db.prepare('SELECT revision FROM projectionRevisions WHERE scope=?').get(scope)?.revision ?? '0';
export function bumpProjection(store, scope) {
  const revision = rules.nextUint(projectionRevision(store, scope));
  store.db.prepare('INSERT INTO projectionRevisions VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision').run(scope, revision);
}
export function projectionReady(store, ...scopes) {
  check(store.db.prepare('SELECT ready FROM projectionControl WHERE id=1').get()?.ready === 1, 'public_projection_migration_required', 503);
  for (const scope of scopes) check(!store.db.prepare('SELECT 1 FROM projectionPending WHERE scope=? LIMIT 1').get(scope), 'public_projection_pending', 503);
}
const values = x => Array.isArray(x) ? x : Object.values(x ?? {});
export function eventScopes(event, get) {
  const scopes = new Set(['publicEvents']);
  const add = (...names) => names.forEach(x => scopes.add(x));
  for (const row of [...values(event.occurrences), ...values(event.finds)]) {
    const asset = row.asset ?? rules.patternAssetV2(rules.decimalV2(row.pattern)), height = rules.decimalV2(row.block);
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
    const old = db.prepare('SELECT scope FROM projectionPending WHERE event=?').all(event);
    db.prepare('DELETE FROM projectionPending WHERE event=?').run(event);
    for (const { scope } of old) bump(scope);
    if (op.value) {
      const scopes = ['world', 'block/' + rules.decimalV2(op.value.block), ...(op.value.asset ? ['claimed2/' + op.value.asset] : ['links'])];
      for (const scope of scopes) { db.prepare('INSERT OR IGNORE INTO projectionPending VALUES(?,?)').run(scope, event); bump(scope); }
    }
  }
  if (op.space === 'feedEvents') {
    // Replacement is supported, but an event's new fence is always installed
    // atomically with its contents. Deletion releases exactly its own scopes.
    const old = db.prepare('SELECT scope FROM projectionPending WHERE event=?').all(id);
    db.prepare('DELETE FROM projectionPending WHERE event=?').run(id);
    for (const { scope } of old) bump(scope);
    if (op.value && store.get('meta', 'ruleState')?.batchVersion === 2)
      for (const scope of eventScopes(op.value, (space, key) => space === 'queuedAttribution' ? db.prepare('SELECT owner FROM projectionAttribution WHERE asset=?').get(key)?.owner : store.get(space, key))) {
        db.prepare('INSERT OR IGNORE INTO projectionPending VALUES(?,?)').run(scope, id); bump(scope);
      }
    for (const { record } of values(op.value?.discoveries)) db.prepare('INSERT OR REPLACE INTO projectionAttribution VALUES(?,?)').run(rules.patternAssetV2(record.number), record.discoverer ?? null);
  }
}
