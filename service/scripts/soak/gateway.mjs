import { start } from '../../run.mjs';
import { loadConfig } from '../../src/config.mjs';
import { save } from './common.mjs';
import { join } from 'node:path';
import { getHeapStatistics, writeHeapSnapshot } from 'node:v8';

const config = await loadConfig(process.argv[2]), service = await start(config);
const filename = join(config.data, 'memory.json');
let writing = Promise.resolve();
let diagnostics;
const timer = setInterval(() => {
  writing = writing.then(async () => {
    if (!diagnostics || Date.now() - diagnostics.at >= 25000) {
      const report = process.report.getReport();
      diagnostics = { at: Date.now(), workers: report.workers.map(w => ({ threadId: w.header.threadId, heap: w.javascriptHeap, handles: w.libuv.map(h => h.type) })),
        handles: report.libuv.map(h => ({ type: h.type, active: h.is_active })), resources: process.getActiveResourcesInfo(),
        sqlite: Object.fromEntries(['cache_size', 'mmap_size', 'page_count', 'freelist_count'].map(p => [p, service.store.db.prepare('PRAGMA ' + p).get()])) };
    }
    await save(filename, { pid: process.pid, at: Date.now(), ...process.memoryUsage(), v8: getHeapStatistics(), diagnostics });
  }).catch(() => {});
}, 1000);
// Explicit diagnostic signal; snapshots stay beside the private run data.
process.on('SIGUSR2', () => {
  try { writeHeapSnapshot(join(config.data, `main-${Date.now()}.heapsnapshot`)); } catch {}
});
let closing;
const close = () => closing ??= (async () => { clearInterval(timer); await writing; await service.close(); })();
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
