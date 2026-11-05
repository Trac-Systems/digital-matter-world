// Optional benchmark preload. Count SQLite point/page queries in the actual
// gateway worker without changing its replay result or retained source tree.
import { isMainThread, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
if (!isMainThread) {
  let queries = 0, rows = 0, started;
  parentPort.on('message', () => { queries = 0; rows = 0; started = process.threadCpuUsage(); });
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (...args) {
    const statement = prepare.apply(this, args);
    if (/SELECT/i.test(args[0]) && /claimNodes|namedNodes/.test(args[0])) for (const method of ['get', 'all']) {
      const original = statement[method];
      statement[method] = function (...params) {
        queries++; const result = original.apply(this, params);
        rows += method === 'all' ? result.length : result ? 1 : 0; return result;
      };
    }
    return statement;
  };
  const post = parentPort.postMessage;
  parentPort.postMessage = function (message, ...args) {
    const cpu = message?.output && started && process.threadCpuUsage(started);
    return post.call(this, message?.output ? { ...message, benchmarkReads: { queries, rows,
      cpuMs: (cpu.user + cpu.system) / 1000 } } : message, ...args);
  };
}
