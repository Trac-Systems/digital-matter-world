// Execution resources only: these limits never participate in consensus work
// accounting. Each reader owns its requests and predecessor snapshot.
export const POINT_BATCH_SIZE = 64;
export const POINT_CONCURRENCY = 8;

export async function pointResults(rows, read) {
  const results = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POINT_CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length) {
      const i = next++;
      try { results[i] = { value: await read(rows[i], i) }; }
      catch (error) { results[i] = { error: error?.message || 'point_read_failed' }; }
    }
  }));
  return results;
}

export function pointBatch(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > POINT_BATCH_SIZE ||
    keys.some(key => typeof key !== 'string')) throw Error('point_read_batch');
  return keys;
}
