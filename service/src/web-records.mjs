import { rules } from './rules.mjs';
import { heightKey } from './util.mjs';
import { publicIdentities } from '../../rules/src/trac-address.js';
const fraction = r => ({ n: BigInt(r.n ?? r.numerator), d: BigInt(r.d ?? r.denominator) });
const rarer = (a, b) => {
  if (!b) return true;
  const x = fraction(a.rarity), y = fraction(b.rarity), difference = x.n * y.d - y.n * x.d;
  return difference < 0n || difference === 0n && (a.findHeight > b.findHeight || a.findHeight === b.findHeight && a.block < b.block);
};
// Streaming aggregates retain three winners, not an unbounded collection.
// Recompute only when accepted public evidence or the time bucket changes.
export function createRecordHighlights(store, now = Date.now) {
  let cached, pending, key;
  return async () => {
    const at = now(), stamp = `${Math.floor(at / 60000)}/${store.get('meta','publicSequence')}/${store.get('meta','latest')?.audit?.hash}`;
    if (key === stamp && cached) return cached;
    if (pending) return pending;
    pending = (async () => {
      const date = new Date(at), today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()), week = at - 7 * 86400000;
      const patterns = new Map((store.get('meta','patterns') ?? []).map(p => [rules.patternAsset(p), { name: p.name, rarity: rules.patternProperties(p).rarity }]));
      const records = { today: null, week: null, ever: null }; let after = '';
      for (;;) {
        const page = store.list('finds', { after, limit: 200 });
        for (const { id, value: f } of page) {
          const pattern = patterns.get(f.asset); if (!pattern) continue;
          const header = store.get('headers', heightKey(f.findHeight));
          const time = header ? rules.parseHeader(header.raw).time * 1000 : null;
          const batch = store.get('findProvenance', id);
          const record = { asset: f.asset, name: pattern.name, rarity: pattern.rarity, block: f.block, count: f.count,
            finder: f.finder, findHeight: f.findHeight, at: time, ...(batch ? { manifest: '/records/batches/' + batch } : {}) };
          for (const [period, from] of [['today',today],['week',week],['ever',-Infinity]]) if ((period === 'ever' || time !== null && time >= from && time <= at) && rarer(record,records[period])) records[period] = record;
        }
        if (page.length < 200) break; after = page.at(-1).id;
        await new Promise(resolve => setImmediate(resolve));
      }
      let biggest = null; after = '';
      for (;;) {
        const page = store.list('types', { after, limit: 200 });
        for (const { id, value: c } of page) if (!biggest || BigInt(c.properties.mass) > BigInt(biggest.mass) || c.properties.mass === biggest.mass && id < biggest.asset) {
          biggest = { asset: id, mass: c.properties.mass, generation: c.properties.generation, firstMaker: c.firstMaker, created: c.created };
        }
        if (page.length < 200) break; after = page.at(-1).id;
        await new Promise(resolve => setImmediate(resolve));
      }
      cached = publicIdentities({ asOf: at, clock: 'UTC; find times from counted Bitcoin headers', todayFrom: today, weekFrom: week, rarestFinds: records, biggestCompound: biggest }); key = stamp; return cached;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
