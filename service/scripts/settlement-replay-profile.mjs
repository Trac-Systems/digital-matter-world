import { registerHooks } from 'node:module';

// Benchmark-only instrumentation, inherited by workers through --import. No
// production imports or consensus objects depend on these measurements.
export function createReplayProfile(now = () => performance.now()) {
  let current;
  const reset = () => { current = { started: now(), phase: null, phases: {}, operations: {} }; };
  const measure = (name, action) => {
    const start = now(); let result;
    try { return result = action(); }
    finally {
      const ms = now() - start;
      for (const operations of [current.operations, ...(current.phase ? [current.phases[current.phase].operations] : [])]) {
        const row = operations[name] ??= { calls: 0, ms: 0 };
        row.calls++; row.ms += ms;
        if (name.startsWith('sqlite')) row.rows = (row.rows ?? 0) + (Array.isArray(result) ? result.length : result ? 1 : 0);
      }
    }
  };
  reset();
  return { reset, measure,
    phase(name, budget, action) {
      const prior = current.phase, start = now(), reads = budget.reads, bytes = budget.bytes;
      const row = current.phases[name] ??= { units: 0, ms: 0, reads: 0, bytes: 0, operations: {} };
      current.phase = name;
      try { return action(); }
      finally {
        row.units++; row.ms += now() - start; row.reads += budget.reads - reads; row.bytes += budget.bytes - bytes;
        current.phase = prior;
      }
    },
    snapshot() { return { workerMs: now() - current.started, phases: current.phases, operations: current.operations }; }
  };
}
const key = Symbol.for('dmw.settlementReplayProfile');
globalThis[key] = createReplayProfile();
const profile = "globalThis[Symbol.for('dmw.settlementReplayProfile')]";
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw Error('benchmark_profile_source: ' + before);
  return source.replace(before, after);
}
export function instrumentReplay(url, source) {
  if (url.endsWith('/rules/src/claim-closure.js')) {
    return replace(source, 'budget.run(action);', `${profile}.phase(c.phase, budget, () => budget.run(action));`);
  }
  if (url.endsWith('/committee/signer/replay-worker.mjs')) {
    source = replace(source, 'const flag = new Int32Array(signal);', `${profile}.reset(); const flag = new Int32Array(signal);`);
    source = replace(source, 'const call = (view, method, args) => {', 'const originalCall = (view, method, args) => {');
    source = replace(source, 'const snapshot = JSON.stringify(', `const call = (view, method, args) => ${profile}.measure('rpc.' + method, () => originalCall(view, method, args));
    const snapshot = JSON.stringify(`);
    return replace(source, 'parentPort.postMessage({ result });', `parentPort.postMessage({ result, replayProfile: ${profile}.snapshot() });`);
  }
  if (url.endsWith('/service/src/replay-worker.mjs')) {
    source = replace(source, 'let db, claimDb;', `${profile}.reset(); let db, claimDb;`);
    source = replace(source, 'const output = processObservation(', `const output = ${profile}.measure('observation', () => processObservation(`);
    source = replace(source, '{ claimNodeGet, namedNodeGet, publicMintGet });', '{ claimNodeGet, namedNodeGet, publicMintGet }));');
    return replace(source, 'parentPort.postMessage({ id, output:', `parentPort.postMessage({ id, replayProfile: ${profile}.snapshot(), output:`);
  }
  if (url.endsWith('/service/src/replay-node-reader.mjs')) {
    // Retained baselines use pages; newer readers can use direct point reads.
    const queries = [['this.pages[space].all(JSON.stringify([...ids]))', 'sqlite'], ['this.points[space].get(id)', 'sqlitePoint']];
    if (!queries.some(([query]) => source.includes(query))) throw Error('benchmark_profile_source: replay node queries');
    for (const [query, name] of queries) if (source.includes(query)) source = replace(source, query, `${profile}.measure('${name}.' + space, () => ${query})`);
    return source;
  }
  return source;
}
if (process.env.BENCH_PROFILE === '1') registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (['/rules/src/claim-closure.js', '/committee/signer/replay-worker.mjs', '/service/src/replay-worker.mjs', '/service/src/replay-node-reader.mjs'].some(suffix => url.endsWith(suffix))) {
    return { ...result, source: instrumentReplay(url, typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source)) };
  }
  return result;
} });
