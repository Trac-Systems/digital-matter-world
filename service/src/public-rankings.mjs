import { rules } from './rules.mjs';
import { heightKey, check } from './util.mjs';
import { projectionReady } from './projection-state.mjs';

// Continued fractions alternate comparison direction. Prefix-free integer
// tokens and alternating terminal sentinels preserve exact rational ordering
// in SQLite's byte collation, without floating-point rounding.
export function rationalKey(n, d) {
  n = BigInt(n); d = BigInt(d); check(n >= 0n && d > 0n, 'ranking_fraction');
  let key = '', odd = false;
  for (;;) {
    let token = rules.uintKeyV2(String(n / d));
    if (odd) token = [...token].map(c => String.fromCharCode(159 - c.charCodeAt(0))).join('');
    key += token;
    const remainder = n % d;
    if (!remainder) return key + (odd ? '~' : '!');
    [n, d] = [d, remainder]; odd = !odd;
  }
}
export function rankingSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS publicRanksV2(kind TEXT,id TEXT,score TEXT,expires INTEGER,value TEXT,PRIMARY KEY(kind,id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS publicRanksV2Score ON publicRanksV2(kind,score,id);
    CREATE INDEX IF NOT EXISTS publicRanksV2Expiry ON publicRanksV2(expires,kind,id);`);
}
export function findRankRecord(store, id, find, catalog) {
  if (!catalog?.anchor || !catalog.knownMatchCount) return null;
  const time = store.get('headers', heightKey(find.findHeight))?.fields?.time;
  return { name: catalog.name, at: time == null ? null : time * 1000, catalogRevision: catalog.catalogRevision,
    rarity: { numerator: catalog.knownMatchCount, denominator: rules.nextUint(rules.decimalV2(catalog.anchor.height)) },
    scoreMeaning: 'known_match_fraction_at_find_publication', manifest: '/records/batches/' + store.get('findProvenance', id) };
}
export function rankFind(store, id, find, catalog) {
  const saved = find.ranking ?? findRankRecord(store, id, find, catalog); if (!saved) return;
  const { ranking, ...fields } = find, record = { ...fields, ...saved };
  const at = record.at, now = store.get('meta', 'rankingClock') ?? 0;
  const score = rationalKey(record.rarity.numerator, record.rarity.denominator);
  for (const [kind, expires] of [['ever', null], ['today', at == null ? null : (Math.floor(at / 86400000) + 1) * 86400000], ['week', at == null ? null : at + 7 * 86400000]]) {
    if (kind !== 'ever' && (expires === null || expires <= now)) continue;
    store.db.prepare('INSERT OR IGNORE INTO publicRanksV2 VALUES(?,?,?,?,?)').run(kind, id, score, expires, JSON.stringify(record));
  }
}
export async function expireRankings(store, { now = Date.now(), rows = 128 } = {}) {
  const due = store.db.prepare('SELECT kind,id FROM publicRanksV2 WHERE expires<=? ORDER BY expires,kind,id LIMIT ?').all(now, rows);
  // The deletion queue uses the ordinary journal so a restart cannot restore an
  // expired entry after advancing the published clock.
  if (due.length) await store.transact(due.map(r => ({ space: 'rankExpiry', id: r.kind + '/' + r.id, value: r })));
  if (!store.db.prepare('SELECT 1 FROM publicRanksV2 WHERE expires<=? LIMIT 1').get(now)) await store.put('meta', 'rankingClock', now);
}
export function rankingHighlights(store) {
  projectionReady(store, 'rankings');
  const now = store.get('meta', 'rankingClock') ?? 0, rarestFinds = {};
  for (const kind of ['today', 'week', 'ever']) {
    const row = store.db.prepare('SELECT value FROM publicRanksV2 WHERE kind=? ORDER BY score,id LIMIT 1').get(kind);
    rarestFinds[kind] = row ? JSON.parse(row.value) : null;
  }
  // v2 mass is a commitment, not a size: the standout compound is the highest tier, then generation, then newest.
  const compound = store.db.prepare("SELECT r.value FROM publicOrderV2 o JOIN publicItemsV2 r ON r.kind=o.kind AND r.scope=o.scope AND r.id=o.id WHERE o.kind='compounds' AND o.scope='' AND o.sort='rank' ORDER BY o.key DESC,o.id DESC LIMIT 1").get();
  const c = compound && JSON.parse(compound.value);
  return { v: 3, asOf: now, clock: 'UTC; accepted Bitcoin find timestamps', scoreMeaning: 'known_match_fraction_at_find_publication',
    todayFrom: Math.floor(now / 86400000) * 86400000, weekFrom: now - 7 * 86400000, rarestFinds,
    highestTierCompound: c ? { asset: c.id, tier: c.tier?.value ?? c.tier ?? null, generation: c.properties?.generation ?? null, recipe: c.recipe ?? null,
      inputs: (c.inputs ?? []).map(i => Array.isArray(i) ? { asset: i[0], amount: i[1] } : { asset: i.asset, amount: i.amount }), firstMaker: c.firstMaker ?? null,
      snapshotHeight: c.snapshot?.height ?? null } : null };
}
