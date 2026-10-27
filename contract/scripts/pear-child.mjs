import PearRuntime from 'pear-runtime';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../index.js', import.meta.url));
const child = PearRuntime.run(entry, process.argv.slice(2));
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error', error => { if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) throw error; });
let stopped = false;
const stop = () => { if (!stopped) { stopped = true; child._process?.kill('SIGTERM'); } };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
process.once('exit', stop);
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); process.stdin.unpipe(child.stdin); process.stdin.pause(); });
