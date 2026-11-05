import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';

// Archive locations are hints; only the independently accepted notary root
// authenticates the complete ordered set of files.
export function createAcceptedAudits({ store, root: acceptedRoot, archive, limits }) {
  const cache = new Map();
  return async n => {
    const root = await acceptedRoot(n); check(root, 'accepted_batch_missing');
    if (cache.get(n)?.root === root) return cache.get(n).files;
    const batch = await store.get('batches', heightKey(n)); check(batch?.batch.root === root, 'accepted_batch_binding');
    check(Array.isArray(batch.publications) && batch.publications.length <= limits.auditFiles, 'audit_count');
    // A receipt-renewal reservation carries no operations or audit files; the
    // notary accepts it only with this body-derived root.
    if (batch.batch.renewal?.kind === 'reserve' && !batch.publications.length && Array.isArray(batch.batch.ops) && !batch.batch.ops.length &&
      rules.renewalReservationRoot(batch.batch) === root) {
      cache.set(n, { root, files: [] }); return [];
    }
    const bytes = []; let total = 0;
    for (const p of batch.publications) {
      const value = await archive(p.audit.path, p.audit.hash); total += value.length;
      check(total <= limits.auditTotalBytes, 'audit_total_size'); bytes.push(value);
    }
    check(rules.merkleRoot(bytes) === root, 'accepted_audit_root');
    const files = bytes.map(b => rules.decodeBinary(b)); check(files.every(f => f.v === 4 || f.v === 5), 'audit_version');
    if (cache.size >= limits.auditCacheEntries) cache.delete(cache.keys().next().value);
    cache.set(n, { root, files }); return files;
  };
}
