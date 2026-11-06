import { rules } from './rules.mjs';

const eligible = t => ['public-scan', 'fund', 'consume', 'bulk-fund', 'bulk-consume'].includes(t.type) ||
  t.type === 'lifecycle' && ['deployment-open', 'deployment-add', 'capacity-finish'].includes(t.action?.type);
const encoded = value => rules.stableJSON(value ?? null);
export const financialRecordProjection = (value, fields) => !fields || value == null ? value :
  Object.fromEntries(fields.map(field => [field, value[field] ?? null]));

// Speculate only on source evidence, never on application. A bounded window
// finishes before the caller applies anything. Reuse requires every observed
// record and reservation to still match the sequential simulation; otherwise
// reconstruct against the new predecessor. Failed speculation is also retried
// at its original position, preserving sequential rejection behavior.
export function financialEvidencePrefetch({ transitions, reads, sources, record, reservations, at, concurrency = 4, canStart = () => true }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw Error('financial_evidence_concurrency');
  const ready = new Map();
  const sequential = transition => sources.financialEvidence(transition, at);
  return async transition => {
    if (concurrency === 1 || !reads.financialScope || !eligible(transition)) return sequential(transition);
    if (!ready.size) {
      const index = transitions.indexOf(transition), selected = [], ids = new Set();
      for (const candidate of index < 0 ? [transition] : transitions.slice(index)) {
        if (selected.length >= concurrency || selected.length && !canStart()) break;
        if (!eligible(candidate) || ids.has(candidate.id)) continue;
        selected.push(candidate); ids.add(candidate.id);
      }
      await Promise.all(selected.map(async candidate => {
        const dependencies = [], saved = new Map(reservations);
        try {
          const scoped = reads.financialScope({ reservations: saved, record: async (key, _at, fields) => {
            const value = await record(key);
            dependencies.push([key, fields, encoded(financialRecordProjection(value, fields))]);
            return value;
          } });
          const evidence = await scoped.financialEvidence(candidate, at);
          ready.set(candidate, { evidence, dependencies, reservations: encoded([...saved]) });
        } catch { ready.set(candidate, null); }
      }));
    }
    const result = ready.get(transition); ready.delete(transition);
    if (result && result.reservations === encoded([...reservations])) {
      let valid = true;
      for (const [key, fields, value] of result.dependencies) if (encoded(financialRecordProjection(await record(key), fields)) !== value) { valid = false; break; }
      if (valid) return result.evidence;
    }
    return sequential(transition);
  };
}
