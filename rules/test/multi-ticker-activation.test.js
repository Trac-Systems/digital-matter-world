import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('changing only the multi-ticker activation declaration moves fee and link admission together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'multi-ticker-activation-'));
  try {
    const loader = join(directory, 'activation.mjs');
    await writeFile(loader, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith('/rules/src/multi-ticker-activation.js')) {
    const source = String(result.source);
    if (!/export const MULTI_TICKER_HEIGHT = '[0-9]+';/.test(source)) throw Error('activation_declaration');
    return { ...result, source: source.replace(/export const MULTI_TICKER_HEIGHT = '[0-9]+';/, "export const MULTI_TICKER_HEIGHT = '973900';") };
  }
  return result;
} });\n`);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', loader, '--test', '--test-reporter=tap',
      'rules/test/ticker-fees.test.js', 'rules/test/link-payments.test.js', 'service/test/link-fees.test.mjs', 'service/test/ticker-payments.test.mjs'],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), env, maxBuffer: 2_000_000 });
    assert.match(stdout, /# fail 0/); assert.doesNotMatch(stdout, /not ok/);
  } finally { await rm(directory, { recursive: true }); }
});
