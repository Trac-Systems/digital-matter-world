import { openRuntime } from '../service/prod/runtime.mjs';

// The operator installs this only after the launch has emitted host/runtime.json.
// It joins that durable host identity; it never registers a replacement subnet.
const args = process.argv.slice(2);
let runtime;
try {
  if (args.length !== 1 || !args[0].startsWith('/')) throw Error('usage');
  runtime = await openRuntime({ configFile: args[0] });
  console.log('Trac host runtime ready.');
  await new Promise(resolve => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
} catch {
  console.error('STOP: Trac host needs one absolute path to its owned production runtime file. Check private host logs and pins.');
  process.exitCode = 1;
} finally {
  try { await runtime?.close(); }
  catch { console.error('STOP: Trac host shutdown failed; preserve its state.'); process.exitCode = 1; }
}
