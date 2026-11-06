// Optional Node --import hook: run the identical benchmark against an older
// implementation without checking out files or retaining any data copies.
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url)), revision = process.env.PAYMENT_BASELINE;
if (!revision || !/^[0-9a-f]{7,40}$/.test(revision)) throw Error('PAYMENT_BASELINE must be a commit hash');
const paths = ['service/src/', 'service/prod/', 'committee/signer/'];
const existing = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', ...paths], { cwd: root, encoding: 'utf8' }).trim().split('\n'));
const sources = new Map();
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    const path = fileURLToPath(url), relative = path.startsWith(root) ? path.slice(root.length) : null;
    if (relative?.endsWith('.mjs') && existing.has(relative) && !relative.includes('/test/')) {
      if (!sources.has(relative)) sources.set(relative, execFileSync('git', ['show', revision + ':' + relative], { cwd: root, encoding: 'utf8' }));
      return { format: 'module', source: sources.get(relative), shortCircuit: true };
    }
  }
  return nextLoad(url, context);
} });
