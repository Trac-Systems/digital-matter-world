import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { serveDashboard } from '../../kit/lib/dashboard.mjs';

test('site and kit dashboard show server symbols and fall back only for old records', async t => {
  const patterns = [
    { asset: 'p2:0', number: '0', name: 'dmwmuffinite' },
    { asset: 'p2:1', number: '1', name: 'dmwmudstone', symbol: 'Md' },
    { asset: 'p2:2', number: '2', name: 'dmwmuddite', symbol: 'Mud' },
  ].map(p => ({ ...p, fld: 4, dt: 'n', pat: '1', tier: 1, rarity: '1' }));
  const reads = [];
  const server = await serve({ files: { serve: async () => false }, web: createWeb({ target: {}, records: async () => ({}) }),
    publicAPI: { handles: () => true, read(path) {
      reads.push(path);
      const url = new URL(path, 'http://local');
      if (url.pathname === '/status') return { tip: '0', counted: '0' };
      const key = url.pathname === '/feed' ? 'events' : url.pathname.slice(1);
      return { [key]: key === 'patterns' ? patterns : [], next: null, total: key === 'patterns' ? patterns.length : 0 };
    } } });
  t.after(() => server.close());
  const dashboard = await serveDashboard({}, { state: { agent: { paymentOrigin: server.url }, activate() {}, async close() {},
    async info() { return { address: 'local-player' }; } } });
  t.after(() => dashboard.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  // Even incidental browser requests stay on these two disposable servers.
  await context.route('**/*', route => [server.url, dashboard.origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  const check = async origin => {
    await page.goto(origin + '/table');
    await page.locator('button.el .sym').nth(2).waitFor();
    assert.deepEqual(await page.locator('button.el .sym').allTextContents(), ['Mu', 'Md', 'Mud']);
    await page.reload();
    await page.locator('button.el .sym').nth(2).waitFor();
    assert.deepEqual(await page.locator('button.el .sym').allTextContents(), ['Mu', 'Md', 'Mud']);
  };
  await check(server.url);
  const login = await context.request.post(dashboard.origin + '/login', {
    headers: { origin: dashboard.origin }, data: { token: new URL(dashboard.loginLink).hash.slice(1) },
  });
  assert.equal(login.status(), 200);
  await check(dashboard.origin);
  assert.ok(reads.some(path => path.startsWith('/patterns?')));
  assert.deepEqual(errors, []);
});
