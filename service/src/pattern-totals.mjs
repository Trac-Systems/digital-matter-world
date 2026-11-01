import { patternCatalogId } from './mint-assets.mjs';
import { projectionStatement } from './projection-state.mjs';
import { check } from './util.mjs';

export function patternTotalsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS publicPatternMintCounts(asset TEXT PRIMARY KEY,n TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS publicPatternMintBlocks(asset TEXT,block TEXT,ledgers TEXT NOT NULL,PRIMARY KEY(asset,block)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS publicPatternTotalsFill(id INTEGER PRIMARY KEY,phase TEXT,cursor TEXT);`);
}

// An unscoped marker predates independent ticker supply or belongs to the
// official ticker. Older additional tickers also used that key: inspect their
// accepted deployment before counting them. Legacy markers without deployment
// metadata predate additional tickers and retain their official meaning.
function officialMint(store, row) {
  if (!row) return false;
  const capacity = row.id && store.get('accountRecords', 'dc/' + row.id);
  if (capacity?.supplyScope) return false;
  const deployment = capacity?.deployment && store.get('accountRecords', 'fd/' + capacity.deployment);
  if (deployment) return !deployment.official;
  const mint = row.id && store.get('mints', row.id);
  return !mint?.context?.deployment?.officialDeployment && !mint?.request?.supplyScope && !mint?.intent?.supplyScope;
}

// Point writes only. Keep membership as well as the decimal counter so retries,
// deletion, journal replay and pN/p2:N aliases cannot count a block twice.
export function projectPatternMint(store, id, row) {
  const [ledger, block, scope] = id.split('/'), asset = patternCatalogId(ledger);
  if (!asset || scope !== undefined || !/^(0|[1-9][0-9]*)$/.test(block ?? '')) return null;
  const sql = text => projectionStatement(store.db, text);
  const prior = sql('SELECT ledgers FROM publicPatternMintBlocks WHERE asset=? AND block=?').get(asset, block);
  const ledgers = new Set(prior ? JSON.parse(prior.ledgers) : []), before = ledgers.size > 0;
  if (officialMint(store, row)) ledgers.add(ledger); else ledgers.delete(ledger);
  const after = ledgers.size > 0;
  if (after) sql('INSERT INTO publicPatternMintBlocks VALUES(?,?,?) ON CONFLICT(asset,block) DO UPDATE SET ledgers=excluded.ledgers')
    .run(asset, block, JSON.stringify([...ledgers].sort()));
  else sql('DELETE FROM publicPatternMintBlocks WHERE asset=? AND block=?').run(asset, block);
  if (before === after) return null;
  const n = BigInt(sql('SELECT n FROM publicPatternMintCounts WHERE asset=?').get(asset)?.n ?? '0') + (after ? 1n : -1n);
  check(n >= 0n, 'pattern_mint_count');
  sql('INSERT INTO publicPatternMintCounts VALUES(?,?) ON CONFLICT(asset) DO UPDATE SET n=excluded.n').run(asset, String(n));
  return asset;
}

export function patternTotals(store, asset, pattern, supplyWrite) {
  const ledger = pattern.legacy?.asset ?? store.get('patternsByAsset', asset)?.legacy?.asset ?? asset;
  const supply = supplyWrite?.id === ledger ? supplyWrite.value : store.get('publicSupply', ledger);
  // Same meaning as compounds: issued minus burned, including held units.
  return { supply: supply?.outstanding ?? '0', minted: projectionStatement(store.db,
    'SELECT n FROM publicPatternMintCounts WHERE asset=?').get(asset)?.n ?? '0' };
}
