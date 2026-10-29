import { setTimeout as delay } from 'node:timers/promises';
import { lifecycleSignal } from '../../service/src/lifecycle.mjs';
import { HttpSource } from '../../service/prod/http.mjs';

export async function createReads({ delayMs, url }) {
  await delay(delayMs, undefined, { signal: lifecycleSignal() });
  const source = new HttpSource({ url, timeoutMs: 30000, retries: 2 });
  return { counted: () => source.request('/slow'), tip: async () => ({ tip: 0 }), close: async () => {} };
}
