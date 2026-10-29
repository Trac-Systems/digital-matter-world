import { AsyncLocalStorage } from 'node:async_hooks';

// Runtime-only context: never persisted in a configuration or release binding.
// Sources retain the signal when constructed; HTTP callbacks also enter it.
const scope = new AsyncLocalStorage();
export const lifecycleSignal = () => scope.getStore()?.signal;
export const withLifecycle = (options, work) => scope.run({ ...scope.getStore(), ...options }, work);
export function bindLifecycle(work) {
  const context = scope.getStore();
  return (...args) => scope.run(context, () => work(...args));
}
export async function phase(name, work) {
  const start = performance.now();
  try { return await work(); }
  finally { scope.getStore()?.onPhase?.({ phase: name, ms: performance.now() - start }); }
}

export async function boundedClose(work, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// For libraries without AbortSignal support. Callers must stop the underlying
// transport too; this only releases reads waiting on that transport.
export function abortable(work, signal = lifecycleSignal()) {
  if (!signal) return Promise.resolve(work);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
