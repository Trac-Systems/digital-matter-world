import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.mjs';
import { projectPublicRecord } from '../src/public-projection-index.mjs';
import { projectRevision } from '../src/projection-state.mjs';

// Explicit offline rebuild on an exclusively opened store. Ordinary startup
// and page reads never enumerate existing records to construct these indexes.
export async function migratePublicProjections(store, { pageRows = 128 } = {}) {
  if (!Number.isSafeInteger(pageRows) || pageRows <= 0) throw Error('public_import_settings');
  let cursor = store.db.prepare('SELECT cursor FROM projectionControl WHERE id=1').get()?.cursor;
  if (!cursor) store.db.exec(`BEGIN IMMEDIATE; UPDATE projectionControl SET ready=0,cursor='["",""]' WHERE id=1;
    DELETE FROM projectionPending; DELETE FROM projectionAttribution; DELETE FROM publicItemsV2; DELETE FROM publicItemCountsV2; DELETE FROM publicOrderV2; DELETE FROM publicBlocksV2; DELETE FROM publicRightsV2; DELETE FROM publicBalancesV2; DELETE FROM publicBitmapV2; DELETE FROM publicRanksV2;
    DELETE FROM publicPatternMintBlocks; DELETE FROM publicPatternMintCounts; COMMIT`);
  cursor = JSON.parse(cursor ?? '["",""]');
  // Header caches have no public projection handlers. Their canonical records
  // remain untouched; avoid parsing two lifetime header copies during rebuild.
  for (;;) {
    const rows = store.db.prepare("SELECT space,id,value FROM records WHERE (space,id)>(?,?) AND space NOT IN ('headers','headerObjects') ORDER BY space,id LIMIT ?").all(...cursor, pageRows);
    if (!rows.length) break;
    store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) { const op = { ...row, value: JSON.parse(row.value) }; projectRevision(store, op); projectPublicRecord(store, op, null); }
      cursor = [rows.at(-1).space, rows.at(-1).id];
      store.db.prepare('UPDATE projectionControl SET cursor=? WHERE id=1').run(JSON.stringify(cursor)); store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    await new Promise(resolve => setImmediate(resolve));
  }
  store.db.exec('UPDATE projectionControl SET ready=1,cursor=NULL WHERE id=1');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = await Store.open(process.argv[2]);
  try { await migratePublicProjections(store); console.log('Public projections rebuilt.'); } finally { await store.close(); }
}
