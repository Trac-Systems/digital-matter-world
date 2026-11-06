// Reuse one successful read for an identical key (which names its batch
// snapshot) for a short time. Failed reads are never kept, so a retry always
// reads the source again. Bounded: the oldest entry leaves first.
export function snapshotMemo({ ttlMs = 60000, limit = 256, maxBytes = 8 * 1024 * 1024, now = Date.now, cacheable = value => value !== null && value !== undefined } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = (key, entry) => { if (entries.get(key) === entry) { entries.delete(key); bytes -= entry.bytes; } };
  const trim = () => { while (entries.size > limit || bytes > maxBytes) { const key = entries.keys().next().value; remove(key, entries.get(key)); } };
  const memo = (key, read) => {
    const at = now(), hit = entries.get(key);
    if (hit && at - hit.at < ttlMs) return hit.value;
    const value = Promise.resolve().then(read);
    if (hit) remove(key, hit);
    const entry = { at, value, bytes: Buffer.byteLength(String(key)) };
    entries.set(key, entry); bytes += entry.bytes;
    value.then(result => {
      if (entries.get(key) !== entry) return;
      try {
        if (!cacheable(result)) { remove(key, entry); return; }
        const size = Buffer.byteLength(JSON.stringify(result) ?? ''); entry.bytes += size; bytes += size; trim();
      } catch { remove(key, entry); }
    }, () => remove(key, entry));
    trim();
    return value;
  };
  memo.clear = () => { entries.clear(); bytes = 0; };
  return memo;
}
