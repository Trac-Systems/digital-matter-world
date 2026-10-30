import { setImmediate as yieldIO } from 'node:timers/promises';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { projectPublicRecord } from './public-projection-index.mjs';
import { projectRevision, projectionStatement } from './projection-state.mjs';

const fix = 'pattern-symbols-v1';
export function patternSymbolFillSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS public_projection_fixes(name TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS publicPatternSymbolFill(id INTEGER PRIMARY KEY,phase TEXT,cursor TEXT);
    CREATE TABLE IF NOT EXISTS publicPatternSymbolQueue(numberKey TEXT,asset TEXT,PRIMARY KEY(numberKey,asset)) WITHOUT ROWID;`);
}

// One bounded, restartable transaction. First index only catalog identities,
// then visit that queue in numeric order. Lexical p2:10 must not precede p2:2.
// Neither phase enumerates headers, finds, evidence or discovery history.
export function fillPatternSymbolsPage(store, { pageRows = Math.min(128, store.storePageRows) } = {}) {
  check(Number.isSafeInteger(pageRows) && pageRows > 0 && pageRows <= store.storePageRows, 'pattern_symbol_fill_settings');
  const sql = text => projectionStatement(store.db, text);
  if (sql('SELECT 1 FROM public_projection_fixes WHERE name=?').get(fix)) return true;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    sql("INSERT OR IGNORE INTO publicPatternSymbolFill VALUES(1,'catalog','')").run();
    const state = sql('SELECT phase,cursor FROM publicPatternSymbolFill WHERE id=1').get();
    let done = false;
    if (state.phase === 'catalog') {
      const rows = sql("SELECT id,value FROM records WHERE space='catalogPatterns' AND id>? ORDER BY id LIMIT ?").all(state.cursor, pageRows);
      for (const row of rows) sql('INSERT OR IGNORE INTO publicPatternSymbolQueue VALUES(?,?)').run(rules.uintKeyV2(rules.decimalV2(JSON.parse(row.value).number)), row.id);
      sql('UPDATE publicPatternSymbolFill SET phase=?,cursor=? WHERE id=1').run(rows.length < pageRows ? 'symbols' : 'catalog', rows.at(-1)?.id ?? state.cursor);
    } else {
      const rows = sql('SELECT numberKey,asset FROM publicPatternSymbolQueue ORDER BY numberKey,asset LIMIT ?').all(pageRows);
      const project = (space, id, value) => {
        const op = { space, id, value }, projected = projectPublicRecord(store, op, value);
        store.putStmt.run(space, id, JSON.stringify(projected.value));
        projectRevision(store, projected);
      };
      for (const { numberKey, asset } of rows) {
        const record = store.get('catalogPatterns', asset);
        if (record) {
          project('catalogPatterns', asset, record);
          if (record.discoverer) {
            const space = 'discoveriesByAgent/' + record.discoverer, discovery = store.get(space, asset);
            if (discovery) project(space, asset, discovery);
          }
        }
        sql('DELETE FROM publicPatternSymbolQueue WHERE numberKey=? AND asset=?').run(numberKey, asset);
      }
      if (rows.length < pageRows) {
        sql('INSERT INTO public_projection_fixes VALUES(?)').run(fix);
        sql('DELETE FROM publicPatternSymbolFill WHERE id=1').run(); done = true;
      }
    }
    store.db.exec('COMMIT'); return done;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

export async function fillPatternSymbols(store, options) {
  while (!fillPatternSymbolsPage(store, options)) await yieldIO();
}
