import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('changing only the shared activation declaration enables the same mint and replay checks at a reviewed-height fixture', async () => {
  const hook = `import {registerHooks} from 'node:module';
    registerHooks({load(url, context, next) {
      const loaded = next(url, context);
      if (url.endsWith('/rules/src/legacy-deploy-share.js')) loaded.source = String(loaded.source).replace(
        /export const LEGACY_DEPLOY_SHARE_HEIGHT = '[0-9]+';/, "export const LEGACY_DEPLOY_SHARE_HEIGHT = '973900';");
      return loaded;
    }});`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(hook),
    '--test', '--test-reporter=tap', '--test-concurrency=1',
    '--test-name-pattern=legacy deploy share|batch execution height|identical accepted financial|public pattern quotes',
    fileURLToPath(new URL('./financial-sources.test.mjs', import.meta.url)), fileURLToPath(new URL('./public-mint-sources.test.mjs', import.meta.url))],
  { env, maxBuffer: 1024 * 1024, timeout: 60000 });
  assert.match(stdout, /# tests 6\b/); assert.match(stdout, /# pass 6\b/); assert.match(stdout, /# fail 0\b/);
});
