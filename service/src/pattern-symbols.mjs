import { projectionStatement } from './projection-state.mjs';

// Display metadata only: never part of the pattern's committed definition or
// evidence. Keep reservations even if a public catalog row is removed/rebuilt.
export function patternSymbolSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS publicPatternSymbols(
    asset TEXT PRIMARY KEY,symbol TEXT NOT NULL UNIQUE) WITHOUT ROWID;`);
}

// Shortest spelling first, then increasing positions in the name (not alphabet
// order). Skipping repeated characters at each depth avoids enumerating the
// same spelling exponentially often for names such as "mmmmmmmmmmmmmmmmmm".
export function* patternSymbolCandidates(name) {
  const letters = [...String(name ?? '').replace(/^dmw/, '').toLowerCase()];
  if (letters.length < 2) return;
  function* later(start, left, prefix) {
    if (!left) { yield prefix; return; }
    const seen = new Set();
    for (let i = start; i <= letters.length - left; i++) {
      if (seen.has(letters[i])) continue;
      seen.add(letters[i]);
      yield* later(i + 1, left - 1, prefix + letters[i]);
    }
  }
  // Spellings stay short (at most four letters, a bounded number of lookups);
  // after that a number is appended, so a symbol can always be assigned.
  for (let length = 2; length <= Math.min(4, letters.length); length++) yield* later(1, length - 1, letters[0].toUpperCase());
  const base = letters[0].toUpperCase() + letters[1];
  for (let n = 2; ; n++) yield base + n;
}

export function patternSymbol(store, asset) {
  return projectionStatement(store.db, 'SELECT symbol FROM publicPatternSymbols WHERE asset=?').get(asset)?.symbol;
}

// Called inside the projection's SQLite transaction. Each candidate is a point
// lookup in the UNIQUE symbol index; no catalog or discovery history is read.
export function assignPatternSymbol(store, asset, name) {
  const previous = patternSymbol(store, asset);
  if (previous !== undefined) return previous;
  const occupied = projectionStatement(store.db, 'SELECT 1 FROM publicPatternSymbols WHERE symbol=?');
  for (const symbol of patternSymbolCandidates(name)) {
    if (occupied.get(symbol)) continue;
    projectionStatement(store.db, 'INSERT INTO publicPatternSymbols VALUES(?,?)').run(asset, symbol);
    return symbol;
  }
}
