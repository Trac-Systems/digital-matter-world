#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, lstat, realpath, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, need, privateDirectory } from './target.mjs';
const exec = promisify(execFile), sha = b => createHash('sha256').update(b).digest('hex');
const directories = new Set(['committee', 'contract', 'deploy', 'eth', 'kit', 'local', 'playground', 'rules', 'service']);
const rootFiles = new Set(['.gitignore', '.gitleaks.toml', 'README.md', 'LICENSE', 'node-version.mjs']);
const forbidden = /(^|\/)(world|\.local|node_modules|__pycache__|\.git|\.data|\.charters|\.rehearsal|secrets|target|reports|briefs|handoffs)(\/|$)|\.local\.json$|(^|\/)\.env(?:\.|$)|\.(?:key|pem|enc|log|sqlite|db|pyc)$/i;
export function reviewPublicFile(name, bytes) {
  need(!forbidden.test(name) && (directories.has(name.split('/')[0]) || rootFiles.has(name)), 'release_file_allowlist');
  const text = bytes.toString('utf8');
  need(!/(?:\/Applications\/MAMP\/|\/Users\/[^/\s]+\/|[A-Z]:\\Users\\)/.test(text), 'release_machine_path');
  need(!/(?:quiknode\.pro|quicknode\.com)/i.test(text), 'release_private_provider');
  need(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text), 'release_private_key');
  return { path: name, bytes: bytes.length, sha256: sha(bytes) };
}
export async function dryRunRelease(output, { serverBundle = false } = {}) {
  output = resolve(output); await privateDirectory(dirname(output));
  // mkdir is exclusive: do not reuse or clean up a previous review tree.
  await mkdir(output, { mode: 0o700 }); need(await realpath(output) === output, 'release_symlink');
  const inventory = (await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, maxBuffer: 8000000 })).stdout.split('\0').filter(Boolean);
  // The server does not need the operator's Mac/Playbay guide. A server bundle
  // omits that entire document; every included byte retains the public checks.
  // The default public-source export still reviews the complete inventory.
  const rows = [], omitted = [];
  for (const name of [...new Set(inventory)].sort()) {
    need(!name.startsWith('/') && !name.split('/').includes('..'), 'release_path');
    if (serverBundle && name === 'deploy/GO-LIVE-TODAY.md') { omitted.push(name); continue; }
    if (forbidden.test(name)) throw Error('release_private_inventory');
    const path = join(ROOT, name), st = await lstat(path); need(st.isFile() && !st.isSymbolicLink(), 'release_regular_file');
    const bytes = await readFile(path); rows.push(reviewPublicFile(name, bytes));
    await mkdir(dirname(join(output, name)), { recursive: true, mode: 0o700 }); await copyFile(path, join(output, name));
  }
  // A scanner failure leaves the exact review tree in place and never publishes.
  await exec('gitleaks', ['dir', '--redact=100', '--no-banner', '--config', join(ROOT, '.gitleaks.toml'), output], { maxBuffer: 2000000 }).catch(() => { throw Error('release_secret_scan_failed'); });
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim();
  const result = { dryRun: true, serverBundle, omitted, sourceRevision: revision, includesUncommittedWork: true, author: 'Markus Bopp', authorEmail: 'OWNER_INPUT_REQUIRED',
    files: rows, treeSHA256: sha(JSON.stringify(rows)), commitsCreated: 0, pushes: 0 };
  await writeFile(join(dirname(output), output.split('/').at(-1) + '.manifest.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { need([5,6].includes(process.argv.length) && process.argv[2] === '--dry-run' && process.argv[3] === '--output' && (process.argv.length === 5 || process.argv[5] === '--server-bundle'), 'Usage: squash-release.mjs --dry-run --output NEW_DIRECTORY [--server-bundle]');
    const r = await dryRunRelease(process.argv[4], { serverBundle: process.argv[5] === '--server-bundle' }); console.log(`Reviewed ${r.files.length} public files; omitted ${r.omitted.length} local operator guides; no commit or push. Tree ${r.treeSHA256}`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
