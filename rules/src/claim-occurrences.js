import { namedGet } from './named-index.js';
import { submitOccurrences } from './named-discovery.js';
import { compareOrdinal } from './integers-v2.js';

// One occurrence page per named pattern, rather than one catalog revision per
// selected slot. Work still visits only this packet's positive named matches.
export function recordClaimOccurrences(named, { slots, agent, height, history, hashAt, settings }) {
  const groups = new Map(), records = [];
  for (const slot of slots) {
    const matches = groups.get(slot.pattern) ?? new Map();
    matches.set(slot.block, { height: String(slot.block), hash: history.get(slot.block).hash, count: String(slot.count) }); groups.set(slot.pattern, matches);
  }
  for (const [number, rows] of groups) {
    const patternKey = namedGet(named.records, `number/${number}`), matches = [...rows].sort(([a], [b]) => compareOrdinal(a, b)).map(([, m]) => m);
    for (let i = 0; i < matches.length; i += settings.values.occurrencePageSize) {
      const result = submitOccurrences(named, { patternKey, agent, anchor: { height: String(height), hash: hashAt(height) },
        matches: matches.slice(i, i + settings.values.occurrencePageSize), settings, history, counted: String(height) });
      named = result.state; records.push(result.record);
    }
  }
  return { state: named, records };
}
