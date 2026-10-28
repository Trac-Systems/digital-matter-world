import { BUILD as configuredBuildRoot } from '../../../local/common.mjs';
import assert from 'node:assert/strict';
import { open, rename, readFile, mkdir, statfs, lstat, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export const build = `${configuredBuildRoot}`;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const json = path => readFile(path, 'utf8').then(JSON.parse);
export const exec = promisify(execFile);
export async function save(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function append(path, value) {
  const fd = await open(path, 'a', 0o600);
  try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync(); } finally { await fd.close(); }
}
export async function diskFloor(path = '/') {
  const s = await statfs(path), freeBytes = s.bavail * s.bsize;
  const minimum = Number(process.env.DMW_LOCAL_MIN_FREE_GIB ?? 100);
  assert.ok(Number.isFinite(minimum) && minimum >= 40, 'invalid_local_disk_reserve');
  assert.ok(freeBytes >= minimum * 1024 ** 3, `disk_floor_${minimum}_GiB`);
  return freeBytes;
}
export function options(args) {
  const out = { blocks: 300, agents: 100, every: 25, seed: 104729, intervalMs: 0, stallMs: 5000, viewers: 60 };
  const names = { '--blocks': 'blocks', '--agents': 'agents', '--every': 'every', '--seed': 'seed', '--interval-ms': 'intervalMs', '--stall-ms': 'stallMs', '--viewers': 'viewers' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--resume' || arg === '--stop') out[arg.slice(2)] = true;
    else if (arg === '--out') { assert.ok(args[++i] && isAbsolute(args[i]), 'out_requires_absolute_path'); out.directory = resolve(args[i]); }
    else { assert.ok(names[arg] && args[i + 1] !== undefined, 'unknown_or_incomplete_option: ' + arg); out[names[arg]] = Number(args[++i]); }
  }
  for (const k of ['blocks', 'agents', 'every', 'seed', 'viewers']) assert.ok(Number.isSafeInteger(out[k]) && out[k] > 0, 'positive_integer: ' + k);
  assert.ok(out.agents <= 500 && out.every <= 1000 && out.blocks <= 1000000 && out.viewers <= 100, 'workload_limit');
  for (const k of ['intervalMs', 'stallMs']) assert.ok(Number.isSafeInteger(out[k]) && out[k] >= 0 && out[k] <= 3600000, 'interval_limit');
  assert.ok(out.stallMs >= 1000, 'stall_at_least_one_second');
  out.directory ??= join(build, 'service', 'soak-' + Date.now());
  assert.ok(out.directory.startsWith(build + '/'), 'output_must_be_under_shared_build');
  assert.ok(!(out.resume && out.stop), 'choose_resume_or_stop');
  assert.ok(!(out.resume || out.stop) || args.includes('--out'), 'resume_or_stop_requires_out');
  return out;
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  assert.ok(!(await lstat(path)).isSymbolicLink() && await realpath(path) === path, 'output_symlink');
}
export async function identity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'pid');
  try { return (await exec('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='])).stdout.trim() || null; }
  catch (e) { if (e.code === 1) return null; throw e; }
}
export async function recorded(pid, name) { return { pid, name, identity: await identity(pid) }; }
export async function stopRecorded(row, grace = 15000) {
  const current = await identity(row.pid); if (!current) return;
  assert.equal(current, row.identity, 'pid_identity_changed: ' + row.name);
  process.kill(row.pid, 'SIGTERM');
  const deadline = Date.now() + grace;
  while (await identity(row.pid)) {
    if (Date.now() >= deadline) { assert.equal(await identity(row.pid), row.identity, 'pid_reused'); process.kill(row.pid, 'SIGKILL'); break; }
    await sleep(100);
  }
}
export function random(seed) { let state = seed >>> 0; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; }; }
