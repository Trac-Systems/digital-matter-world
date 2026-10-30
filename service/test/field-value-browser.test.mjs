import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';

test('site shows field-value mode, full block units, exact large supply and unchanged block rarity', async t => {
  const pattern = { asset: 'p2:0', number: '0', name: 'dmwvalue', pat: '[0-9]', fld: 10, dt: 'n', amountMode: 'field-value',
    tier: 5, rarity: '3', knownMatchCount: '3', countMeaning: 'verified_submitted_blocks', supply: '9007199254740993' };
  const server = await serve({ files: { serve: async () => false }, web: createWeb({ target: {}, records: async () => ({}) }),
    publicAPI: { handles: () => true, read(path) {
      const url = new URL(path, 'http://local');
      if (url.pathname === '/status') return { tip: '973506', counted: '973506' };
      if (url.pathname === '/patterns') return { patterns: [pattern], total: 1, next: null };
      if (url.pathname === '/patterns/p2:0/claimed-blocks') return { rows: [{ block: '973506', count: '3789512813', found: true }], total: 1, next: null };
      const key = url.pathname === '/feed' ? 'events' : url.pathname.slice(1);
      return { [key]: [], total: 0, next: null };
    } } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(10000);
  await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  await page.goto(server.url + '/table');
  await page.locator('button.el').first().click();
  await page.getByText('Nonce · field value', { exact: true }).waitFor();
  await page.getByText('3,789,512,813', { exact: true }).waitFor();
  await page.getByText('9,007,199,254,740,993', { exact: true }).waitFor();
  assert.ok((await page.locator('body').innerText()).includes('5 of 5'));
  assert.deepEqual(errors, []);
});
