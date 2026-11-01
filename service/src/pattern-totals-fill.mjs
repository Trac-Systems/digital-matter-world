import { setImmediate as yieldIO } from 'node:timers/promises';
import { projectPatternMint } from './pattern-totals.mjs';
import { projectPublicRecord } from './public-projection-index.mjs';
import { projectionStatement } from './projection-state.mjs';
import { check } from './util.mjs';

const fix = 'pattern-totals-v1';
// Old stores have token counts, but no official block count (one block may
// mint many tokens). Bootstrap once from current markers, then catalog rows.
// Startup owns the writer lock; each bounded page and its cursor commit together.
// No headers, batches, account history or owner balances are traversed.
export function fillPatternTotalsPage(store, { pageRows = Math.min(128, store.storePageRows) } = {}) {
  check(Number.isSafeInteger(pageRows) && pageRows > 0 && pageRows <= store.storePageRows, 'pattern_totals_fill_settings');
  const sql = text => projectionStatement(store.db, text);
  if (sql('SELECT 1 FROM public_projection_fixes WHERE name=?').get(fix)) return true;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    sql("INSERT OR IGNORE INTO publicPatternTotalsFill VALUES(1,'minted','')").run();
    const state = sql('SELECT phase,cursor FROM publicPatternTotalsFill WHERE id=1').get();
    const rows = state.phase === 'minted'
      ? sql("SELECT id,value FROM records WHERE space='minted' AND id>? AND id>='p' AND id<'q' ORDER BY id LIMIT ?").all(state.cursor, pageRows)
      : sql("SELECT id,value FROM records WHERE space='catalogPatterns' AND id>? ORDER BY id LIMIT ?").all(state.cursor, pageRows);
    for (const row of rows) {
      const value = JSON.parse(row.value);
      if (state.phase === 'minted') projectPatternMint(store, row.id, value);
      else projectPublicRecord(store, { space: 'catalogPatterns', id: row.id, value }, value);
    }
    const done = rows.length < pageRows && state.phase === 'catalog';
    if (done) {
      sql('INSERT INTO public_projection_fixes VALUES(?)').run(fix);
      sql('DELETE FROM publicPatternTotalsFill WHERE id=1').run();
    } else sql('UPDATE publicPatternTotalsFill SET phase=?,cursor=? WHERE id=1').run(
      rows.length < pageRows ? 'catalog' : state.phase, rows.length < pageRows ? '' : rows.at(-1).id);
    store.db.exec('COMMIT'); return done;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

export async function fillPatternTotals(store, options) {
  while (!fillPatternTotalsPage(store, options)) await yieldIO();
}
