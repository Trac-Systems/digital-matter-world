import { publicIdentities } from '../../rules/src/trac-address.js';

// The envelope starts with an empty array and two null cursors. JSON arrays
// add only row encodings and commas; a cursor replaces each four-byte null.
// Size presentation copies, preserving the original rows returned to callers.
export function publicPageBytes(envelope, key) {
  const base = Buffer.byteLength(JSON.stringify(publicIdentities(envelope)));
  let rows = 0, count = 0;
  return (value, cursor, maxBytes) => {
    const bytes = Buffer.byteLength(JSON.stringify(publicIdentities(value, key)) ?? 'null') + (count ? 1 : 0);
    const total = base + rows + bytes + 2 * (Buffer.byteLength(JSON.stringify(cursor)) - 4);
    if (total > maxBytes) return false;
    rows += bytes; count++; return true;
  };
}
