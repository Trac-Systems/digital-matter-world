import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// The host discards the gateway's stdout and stderr, so timing lines go to timing.log in its state directory
// (kept under about 1 MB: the previous file is kept as timing.log.1). Elsewhere they go to stderr.
const TIMING_FILE = process.env.DMW157_STATE ? join(process.env.DMW157_STATE, 'timing.log') : null;
export function timingLog(value) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n';
  if (!TIMING_FILE) { process.stderr.write(line); return; }
  try {
    try { if (statSync(TIMING_FILE).size > 1_000_000) renameSync(TIMING_FILE, TIMING_FILE + '.1'); } catch {}
    appendFileSync(TIMING_FILE, line, { mode: 0o600 });
  } catch {}
}

// Times the reads one quote or mint request makes, without changing them. Outside a timed call the
// wrapper only passes through. The log names the slowest reads, so a slow mint shows what it waited on.
const current = new AsyncLocalStorage();
const wrap = (target, prefix) => new Proxy(target, {
  get(object, prop, receiver) {
    const value = Reflect.get(object, prop, receiver);
    if (typeof prop !== 'string') return value;
    if (typeof value === 'function') return function (...args) {
      const steps = current.getStore();
      if (!steps) return value.apply(this === receiver ? object : this, args);
      const at = Date.now(), result = value.apply(this === receiver ? object : this, args);
      if (!result || typeof result.then !== 'function') return result;
      return result.finally(() => { const name = prefix + prop; steps.set(name, (steps.get(name) ?? 0) + Date.now() - at); });
    };
    return value && typeof value === 'object' && !Array.isArray(value) && prop === 'feeQuotes' ? wrap(value, prefix + prop + '.') : value;
  },
});
export const timedReads = reads => wrap(reads, '');
// Adds an already measured wait (e.g. for a lock) to the current timed call, if any.
export function addStep(name, ms) { const steps = current.getStore(); if (steps) steps.set(name, (steps.get(name) ?? 0) + ms); }
// One named step inside a timed read, e.g. the parts of an asset context. Outside a timed call it only awaits.
export async function timeStep(name, value) {
  const steps = current.getStore();
  if (!steps) return value;
  const at = Date.now();
  try { return await value; } finally { steps.set(name, (steps.get(name) ?? 0) + Date.now() - at); }
}
export async function timeReads(event, fields, fn, { always = false } = {}) {
  const steps = new Map(), started = Date.now();
  try { return await current.run(steps, fn); }
  finally {
    const ms = Date.now() - started;
    if (always || ms >= 1000) timingLog({ event, ...fields, ms, reads: Object.fromEntries([...steps].sort((a, b) => b[1] - a[1]).slice(0, always ? undefined : 12)) });
  }
}
