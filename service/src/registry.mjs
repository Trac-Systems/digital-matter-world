import { readFile, mkdir, chmod, lstat, realpath, open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { atomicWrite, check } from './util.mjs';
import { Store } from './store.mjs';
import { validateFeePolicy, changeFeePolicy } from './fees.mjs';
import { rules } from './rules.mjs';

export const REGISTRY_DEFAULTS = Object.freeze({ pageRows: 128, recordBytes: 2_000_000, pageBytes: 4_000_000, manifestBytes: 65536 });
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
function settingsFor(settings = {}) {
  check(Object.keys(settings).every(k => Object.hasOwn(REGISTRY_DEFAULTS, k)), 'registry_settings');
  const result = { ...REGISTRY_DEFAULTS, ...settings };
  check(Object.values(result).every(n => Number.isSafeInteger(n) && n > 0), 'registry_settings'); return result;
}
function schema(db) {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS registry_records(space TEXT,id TEXT,value TEXT,PRIMARY KEY(space,id)) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS registry_revision(id INTEGER PRIMARY KEY,n INTEGER); INSERT OR IGNORE INTO registry_revision VALUES(1,0)');
}
function put(db, space, id, value, settings, immutable = false) {
  const encoded = JSON.stringify(value); check(Buffer.byteLength(encoded) <= settings.recordBytes, 'registry_record_bytes');
  if (immutable) {
    const old = db.prepare('SELECT value FROM registry_records WHERE space=? AND id=?').get(space, id);
    if (old) { check(same(JSON.parse(old.value), value), 'registry_history_changed'); return; }
  }
  db.prepare('INSERT OR REPLACE INTO registry_records VALUES(?,?,?)').run(space, id, encoded);
}
function get(db, space, id) { const row = db.prepare('SELECT value FROM registry_records WHERE space=? AND id=?').get(space, id); return row ? JSON.parse(row.value) : null; }
const databasePath = path => path + '.records/index.sqlite';

export class KeyedRegistry {
  constructor(path, settings = {}) {
    this.path = path; this.settings = settingsFor(settings);
    const db = new DatabaseSync(databasePath(path), { readOnly: true });
    try { this.revision = db.prepare('SELECT n FROM registry_revision WHERE id=1').get().n; this.metadata = get(db, 'meta', 'root'); }
    finally { db.close(); }
    this.link = this.metadata.fields.link; this.operator = this.metadata.fields.operator;
    // Existing named reads retain their API. Enumerating requires an explicit
    // page and cannot accidentally reconstitute the lifetime registry.
    this.assets = new Proxy({}, { get: (_, asset) => typeof asset === 'string' ? this.asset(asset) : undefined,
      ownKeys: () => { throw Error('registry_page_required'); } });
  }
  read(fn) {
    const db = new DatabaseSync(databasePath(this.path), { readOnly: true });
    try {
      db.exec('BEGIN'); check(db.prepare('SELECT n FROM registry_revision WHERE id=1').get().n === this.revision, 'registry_snapshot_changed'); return fn(db);
    } finally { db.close(); }
  }
  asset(asset, deploymentId) { return this.read(db => deploymentId ? get(db, 'generations/' + asset, deploymentId) : get(db, 'assets', asset)); }
  deployment(asset, selector) {
    if (!selector) return this.asset(asset);
    return this.read(db => {
      const current = get(db, 'assets', asset);
      if ([current?.id, current?.tick?.toLowerCase(), current?.indexTick?.toLowerCase()].includes(selector.toLowerCase())) return current;
      const key = /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(selector) ? selector :
        get(db, 'tickerByAsset/' + asset, selector.toLowerCase());
      const selected = key ? get(db, 'deployments/' + asset, key) : null;
      return selected ?? (['official', '1'].includes(selector.toLowerCase()) ? current : null);
    });
  }
  officialName(name) { return this.read(db => get(db, 'officialNames', name.toLowerCase())); }
  feeRevision(id) { return this.read(db => get(db, 'fees', id)); }
  currentFee() { const fee = this.feeRevision(this.metadata.feeCurrent); validateFeePolicy({ feePolicy: { current: fee?.id, revisions: [fee] } }); return fee; }
  page(space, { after = '', limit = this.settings.pageRows } = {}) {
    check(typeof after === 'string' && Number.isSafeInteger(limit) && limit > 0 && limit <= this.settings.pageRows && (['assets','fees','treasury/tap','treasury/ethereum'].includes(space) || space.startsWith('generations/') || space.startsWith('deployments/')), 'registry_page');
    return this.read(db => {
      const rows = db.prepare('SELECT id,value FROM registry_records WHERE space=? AND id>? ORDER BY id LIMIT ?').all(space, after, limit);
      check(rows.reduce((n, r) => n + Buffer.byteLength(r.value) + Buffer.byteLength(r.id), 0) <= this.settings.pageBytes, 'registry_page_bytes');
      return rows.map(r => ({ id: r.id, value: JSON.parse(r.value) }));
    });
  }
}
export async function readRegistry(path, settings = {}) {
  const limits = settingsFor(settings), stat = await lstat(path);
  check(stat.isFile() && !stat.isSymbolicLink(), 'registry_file');
  // Legacy data remains readable until the explicit offline conversion. Once
  // converted this file is only a small version marker, never a growing list.
  const descriptor = JSON.parse(await readFile(path, 'utf8'));
  if (descriptor.version !== 2) { validateFeePolicy(descriptor); return descriptor; }
  check(stat.size <= limits.manifestBytes && Object.keys(descriptor).join(',') === 'version', 'registry_manifest');
  const dbStat = await lstat(databasePath(path)), directory = await lstat(path + '.records');
  check(await realpath(databasePath(path)) === databasePath(path) && directory.isDirectory() && (directory.mode & 0o777) === 0o700 && dbStat.isFile() && !dbStat.isSymbolicLink() && dbStat.uid === process.getuid() && (dbStat.mode & 0o777) === 0o600, 'registry_permissions');
  const registry = new KeyedRegistry(path, settings); registry.currentFee(); return registry;
}
export function* registryPages(registry, space = 'assets') {
  if (!(registry instanceof KeyedRegistry)) {
    const rows = space === 'assets' ? registry.assets : space === 'fees' ? Object.fromEntries(registry.feePolicy.revisions.map(r => [r.id, r])) : {};
    yield Object.entries(rows ?? {}).map(([id, value]) => ({ id, value })); return;
  }
  let after = '';
  for (;;) { const page = registry.page(space, { after }); yield page; if (page.length < registry.settings.pageRows) return; after = page.at(-1).id; }
}
function officialNames(db, asset, entry, settings) {
  for (const name of [entry.tick, entry.indexTick, entry.pattern?.name, entry.displayLabel].filter(n => typeof n === 'string'))
    put(db, 'officialNames', name.toLowerCase(), asset, settings);
}

function treasury(db, entry, settings) {
  for (const rail of ['tap', 'ethereum']) if (entry?.[rail]?.treasury) put(db, 'treasury/' + rail, entry[rail].treasury, true, settings);
}

// Conversion is explicit and atomic at the tiny marker rename. A crash before
// that rename leaves the legacy document authoritative and can be retried.
export async function migrateRegistry(path, settings = {}) {
  const lock = await Store.open(path + '.fee-update'), limits = settingsFor(settings);
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.version === 2) return readRegistry(path, settings);
    validateFeePolicy(current);
    await mkdir(path + '.records', { recursive: true, mode: 0o700 });
    const fd = await open(databasePath(path), 'a', 0o600); await fd.close();
    const db = new DatabaseSync(databasePath(path));
    try {
      schema(db); await chmod(databasePath(path), 0o600); db.exec('BEGIN IMMEDIATE; DELETE FROM registry_records');
      const { assets = {}, generations = {}, feePolicy, ...fields } = current;
      for (const [asset, entries] of Object.entries(generations)) for (const entry of entries) put(db, 'generations/' + asset, entry.id, entry, limits, true);
      for (const [asset, entry] of Object.entries(assets)) {
        put(db, 'assets', asset, entry, limits); officialNames(db, asset, entry, limits);
        // Older registries may retain the first observation of a generation;
        // preserve it exactly rather than replace it with mutable liveness.
        if (!get(db, 'generations/' + asset, entry.id)) put(db, 'generations/' + asset, entry.id, entry, limits, true);
        treasury(db, entry, limits);
      }
      if (fields.link?.treasury) put(db, 'treasury/tap', fields.link.treasury, true, limits);
      for (const revision of feePolicy.revisions) put(db, 'fees', revision.id, revision, limits, true);
      put(db, 'meta', 'root', { fields, feeCurrent: feePolicy.current }, limits);
      db.exec('UPDATE registry_revision SET n=n+1 WHERE id=1; COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; } finally { db.close(); }
    await atomicWrite(path + '.legacy', JSON.stringify(current) + '\n');
    await atomicWrite(path, JSON.stringify({ version: 2 }) + '\n'); return readRegistry(path, settings);
  } finally { await lock.close(); }
}
async function mutateKeyed(path, settings, fn) {
  const limits = settingsFor(settings), db = new DatabaseSync(databasePath(path));
  try { db.exec('BEGIN IMMEDIATE'); const result = fn(db, limits); db.exec('UPDATE registry_revision SET n=n+1 WHERE id=1; COMMIT'); return result; }
  catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; } finally { db.close(); }
}
export async function updateRegistryAsset(path, asset, update, settings = {}) {
  const lock = await Store.open(path + '.fee-update');
  try {
    const marker = JSON.parse(await readFile(path, 'utf8'));
    if (marker.version !== 2) {
      const next = await update(marker.assets[asset]); marker.generations ??= {}; const history = marker.generations[asset] ??= [];
      for (const entry of [marker.assets[asset], next].filter(Boolean)) if (!history.some(e => e.id === entry.id)) history.push(entry);
      marker.assets[asset] = next; await atomicWrite(path, JSON.stringify(marker) + '\n'); return next;
    }
    return mutateKeyed(path, settings, (db, limits) => {
      const old = get(db, 'assets', asset), next = update(old); check(next && !next.then && typeof next.id === 'string' && !Object.hasOwn(next, 'baseFee'), 'registry_asset');
      for (const entry of [old, next].filter(Boolean)) if (!get(db, 'generations/' + asset, entry.id)) put(db, 'generations/' + asset, entry.id, entry, limits, true);
      put(db, 'assets', asset, next, limits); officialNames(db, asset, next, limits); treasury(db, next, limits); return next;
    });
  } finally { await lock.close(); }
}
export async function updateRegistryFees(path, changes, now, settings = {}) {
  const lock = await Store.open(path + '.fee-update');
  try {
    const marker = JSON.parse(await readFile(path, 'utf8'));
    if (marker.version !== 2) { const next = changeFeePolicy(marker, changes, now); await atomicWrite(path, JSON.stringify(next) + '\n'); return next; }
    await mutateKeyed(path, settings, (db, limits) => {
      const root = get(db, 'meta', 'root'), old = get(db, 'fees', root.feeCurrent);
      const next = changeFeePolicy({ feePolicy: { current: old.id, revisions: [old] } }, changes, now).feePolicy;
      for (const revision of next.revisions) put(db, 'fees', revision.id, revision, limits);
      put(db, 'meta', 'root', { ...root, feeCurrent: next.current }, limits);
    });
    return readRegistry(path, settings);
  } finally { await lock.close(); }
}
export async function retainRegistryGeneration(path, asset, entry, settings = {}) {
  const lock = await Store.open(path + '.fee-update');
  try {
    const marker = JSON.parse(await readFile(path, 'utf8'));
    check(marker.version === 2, 'registry_migration_required');
    await mutateKeyed(path, settings, (db, limits) => put(db, 'generations/' + asset, entry.id, entry, limits, true));
  } finally { await lock.close(); }
}

// Shared cross-process lock for fee changes and deployment registration.
// Reuse the store's process-identity lock and stale-writer recovery so a crash
// immediately before/after the atomic registry rename cannot strand the queue.
export async function updateRegistry(path, update) {
  const lock = await Store.open(path + '.fee-update');
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    check(current.version !== 2, 'registry_keyed_update_required');
    const next = await update(current);
    await atomicWrite(path, JSON.stringify(next) + '\n'); return next;
  } finally { await lock.close(); }
}

// Additional tickers never overwrite assets/<asset> or its retained generation.
// The same SQLite transaction selects the next ordinal and claims the ticker.
export async function registerAdditionalDeployment(path, asset, candidate, settings = {}) {
  const lock = await Store.open(path + '.fee-update');
  try {
    check(JSON.parse(await readFile(path, 'utf8')).version === 2, 'registry_migration_required');
    return await mutateKeyed(path, settings, (db, limits) => {
      const official = get(db, 'assets', asset), parent = get(db, 'generations/' + asset, candidate.officialDeployment), tick = (candidate.indexTick ?? candidate.tick).toLowerCase();
      check(official && !official.suspended && parent && !parent.officialDeployment && candidate.asset === asset &&
        candidate.officialDeployment === parent.id && same(candidate.options, parent.options) &&
        candidate.kind === official.kind && candidate.privilege === official.privilege && candidate.authorityKey === official.authorityKey &&
        (candidate.elementId ?? null) === (official.elementId ?? null), 'additional_deployment_binding');
      const old = get(db, 'deployments/' + asset, candidate.id), winner = get(db, 'tickerOwners', tick);
      check(!winner || winner.asset === asset && winner.deployment === candidate.id, 'ticker_registered');
      if (old) { check(old.approval === candidate.approval, 'deployment_submission_conflict'); return old; }
      const lastOrdinal = BigInt(get(db, 'deploymentOrdinal', asset) ?? '1');
      const ordinal = candidate.ordinal ?? String(lastOrdinal + 1n);
      check(typeof ordinal === 'string' && /^[1-9][0-9]*$/.test(ordinal) && BigInt(ordinal) > 1n, 'deployment_ordinal');
      const ordinalOwner = get(db, 'deploymentOrdinals/' + asset, ordinal);
      check(!ordinalOwner || ordinalOwner === candidate.id, 'deployment_ordinal_conflict');
      put(db, 'deploymentOrdinals/' + asset, ordinal, candidate.id, limits, true);
      const entry = { ...candidate, ordinal };
      put(db, 'deployments/' + asset, entry.id, entry, limits, true);
      put(db, 'generations/' + asset, entry.id, entry, limits, true);
      for (const name of [entry.tick, entry.indexTick].filter(Boolean)) put(db, 'tickerByAsset/' + asset, name.toLowerCase(), entry.id, limits);
      put(db, 'tickerOwners', tick, { asset, deployment: entry.id }, limits, true);
      put(db, 'deploymentOrdinal', asset, String(BigInt(ordinal) > lastOrdinal ? BigInt(ordinal) : lastOrdinal), limits); treasury(db, entry, limits);
      return entry;
    });
  } finally { await lock.close(); }
}

// Named lookups only. The legacy fallback can resolve the current official;
// additional deployments require the keyed registry migration.
export function selectedDeployment(registry, asset, selector) {
  if (typeof registry.deployment === 'function') return registry.deployment(asset, selector);
  const current = registry.assets?.[asset];
  return !selector || selector === 'official' || selector === '1' ||
    [current?.id, current?.tick, current?.indexTick].includes(selector) ? current : null;
}

// Explicit offline maintenance for registries that were already keyed before
// multi-ticker admission. Never called by gateway/signer request processing.
export async function rebuildRegistryOfficialNames(path, settings = {}) {
  const lock = await Store.open(path + '.fee-update');
  try {
    check(JSON.parse(await readFile(path, 'utf8')).version === 2, 'registry_migration_required');
    await mutateKeyed(path, settings, (db, limits) => {
      for (const row of db.prepare("SELECT id,value FROM registry_records WHERE space='assets' ORDER BY id").iterate())
        officialNames(db, row.id, JSON.parse(row.value), limits);
      put(db, 'meta', 'officialNamesReady', true, limits);
    });
  } finally { await lock.close(); }
}
