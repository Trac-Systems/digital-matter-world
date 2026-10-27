import { readFile } from 'node:fs/promises';
import { atomicWrite } from './util.mjs';
import { Store } from './store.mjs';

// Shared cross-process lock for fee changes and deployment registration.
// Reuse the store's process-identity lock and stale-writer recovery so a crash
// immediately before/after the atomic registry rename cannot strand the queue.
export async function updateRegistry(path, update) {
  const lock = await Store.open(path + '.fee-update');
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    const next = await update(current);
    await atomicWrite(path, JSON.stringify(next) + '\n'); return next;
  } finally { await lock.close(); }
}
