// Explicit pre-admission cutover step. Resume this before opening v2 reads.
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.mjs';
import { rules as r } from '../src/rules.mjs';
import { check } from '../src/util.mjs';
import { migratePublicProjections } from './migrate-public-projections.mjs';

export async function migrateTerminalPublic(store, { pageRows = 128, pageBytes = 90000 } = {}) {
  check(!store.writer, 'store_maintenance_required');
  check(Number.isSafeInteger(pageRows) && pageRows > 0 && Number.isSafeInteger(pageBytes) && pageBytes > 0, 'public_import_settings');
  const pending = store.get('meta', 'legacyPendingWork'), ready = store.get('meta', 'terminalPublicImport');
  check(store.get('meta', 'v2Activation') && pending?.commitment?.sourceRoot, 'public_import_terminal_required');
  if (ready?.sourceRoot === pending.commitment.sourceRoot && store.db.prepare('SELECT ready FROM projectionControl WHERE id=1').get()?.ready === 1) return ready;
  check(!store.get('meta', 'v2Last'), 'public_import_before_first_acceptance');
  store.db.exec('UPDATE projectionControl SET ready=0 WHERE id=1');
  // Scratch aggregation stays on disk; no array of all agents or events.
  store.db.exec('PRAGMA temp_store=FILE; DROP TABLE IF EXISTS temp.terminalPublicAgents; CREATE TEMP TABLE terminalPublicAgents(id TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID');
  const get = store.db.prepare('SELECT value FROM terminalPublicAgents WHERE id=?'), put = store.db.prepare('INSERT OR REPLACE INTO terminalPublicAgents VALUES(?,?)');
  const score = (address, field) => {
    if (!/^[0-9a-f]{64}$/.test(address ?? '')) return;
    const saved = get.get(address), row = saved ? JSON.parse(saved.value) : { address, findCount: '0', discoveryCount: '0', craftCount: '0', mintCount: '0' };
    if (field) row[field] = r.nextUint(row[field]); put.run(address, JSON.stringify(row));
  };
  for (const p of store.get('meta', 'patterns') ?? []) score(p.discoverer, 'discoveryCount');
  for (const c of store.get('meta', 'ruleState')?.discoveryCommits ?? []) score(c.agent);
  for (const { space, value } of store.db.prepare("SELECT space,value FROM records WHERE space IN ('finds','mints','publicEvents') ORDER BY space,id").iterate()) {
    const row = JSON.parse(value);
    if (space === 'finds') score(row.finder, 'findCount');
    if (space === 'mints') score(row.request?.owner, row.state === 'minted' ? 'mintCount' : null);
    if (space === 'publicEvents') {
      const d = row.data ?? {}; score(d.agent ?? d.owner ?? d.from ?? d.actor, row.type === 'craft' ? 'craftCount' : null);
      if (row.type === 'transfer') score(d.to);
    }
  }
  let operations = [], bytes = 2, agents = 0;
  const flush = async () => { if (operations.length) await store.transact(operations); operations = []; bytes = 2; };
  for (const { id, value } of store.db.prepare('SELECT id,value FROM terminalPublicAgents ORDER BY id').iterate()) {
    const op = { space: 'catalogAgents', id, value: JSON.parse(value) }, size = Buffer.byteLength(JSON.stringify(op)) + 1;
    check(size + 2 <= pageBytes, 'public_import_row_bytes');
    if (operations.length >= pageRows || bytes + size > pageBytes) await flush();
    operations.push(op); bytes += size; agents++;
  }
  await flush();
  // The existing rebuild commits each page with its cursor and refuses reads
  // until completion. Reapplying agent rows sets exact scores, never increments.
  await migratePublicProjections(store, { pageRows });
  const raw = store.db.prepare("SELECT value FROM records WHERE space='batches' ORDER BY id DESC LIMIT 1").get();
  const batch = raw && JSON.parse(raw.value).batch;
  check(batch && r.decimalV2(batch.to) === pending.commitment.counted, 'public_import_head');
  const last = { n: r.decimalV2(batch.n), to: r.decimalV2(batch.to) };
  const result = { version: 1, sourceRoot: pending.commitment.sourceRoot, agents, batch: last };
  await store.transact([{ space: 'meta', id: 'terminalPublicImport', value: result },
    { space: 'meta', id: 'v2Last', value: last },
    { space: 'meta', id: 'v2PublicProgress', value: { batch: last.n, observation: r.uintV2(BigInt(store.get('meta', 'publicObservation') ?? 0).toString()) } }]);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = await Store.openForMaintenance(process.argv[2]);
  try { console.log(JSON.stringify(await migrateTerminalPublic(store))); } finally { await store.close(); }
}
