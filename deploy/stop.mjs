import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BUILD } from './safety.mjs';
const argv = process.argv.slice(2);
assert(argv.length === 3 && argv[1] === '--dry-run' && argv[2] === '--regtest', 'Usage: node deploy/stop.mjs ABSOLUTE_RUN --dry-run --regtest');
const directory = resolve(argv[0]); assert(directory.startsWith(BUILD + '/deploy/run-')); assert.equal(await realpath(directory), directory);
const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
assert.equal(result.mode, 'regtest'); assert.equal(result.directory, directory);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const supervisor = JSON.parse(await readFile(join(directory, 'supervisor.json'), 'utf8'));
assert(Number.isSafeInteger(supervisor.pid) && supervisor.pid > 1);
assert(!alive(supervisor.pid), 'Supervisor PID is still alive or reused; inspect it before recovery. Use Ctrl-C on a running rehearsal.');
const exec = promisify(execFile), records = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8')), stopped = [];
const identity = async pid => (await exec('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='])).stdout.trim();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const row of records.toReversed()) {
  assert(Number.isSafeInteger(row.pid) && row.pid > 1 && typeof row.identity === 'string' && row.identity.length > 0);
  if (!alive(row.pid)) { stopped.push({ pid: row.pid, state: 'already stopped' }); continue; }
  assert.equal(await identity(row.pid), row.identity, 'PID identity changed; refusing to signal it');
  process.kill(row.pid, 'SIGTERM');
  for (let i = 0; i < 100 && alive(row.pid); i++) await wait(100);
  if (alive(row.pid)) {
    assert.equal(await identity(row.pid), row.identity); process.kill(row.pid, 'SIGKILL');
    for (let i = 0; i < 100 && alive(row.pid); i++) await wait(100);
  }
  assert(!alive(row.pid), 'Recorded child did not stop'); stopped.push({ pid: row.pid, state: 'stopped' });
}
await writeFile(join(directory, 'recovery-stop.json'), JSON.stringify({ stopped, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
console.log(`Verified ${stopped.length} recorded processes stopped; retained all evidence.`);
