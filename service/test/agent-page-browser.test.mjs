import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { PublicViews } from '../src/public-views.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { Store } from '../src/store.mjs';
import { fixtureHistory, temp } from './helpers.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';

test('agent panel renders its unchanged sections before bitmaps, then updates the existing inspector', async t => {
  const owner = '12'.repeat(32), address = encodeTracAddress(owner), store = await Store.open(await temp('agent-browser-'));
  let browser, server, release, bitmapStarted = false, sealed = { state: 'sealed', opensAt: 92, revealUntil: 234 };
  t.after(async () => { release?.(); await browser?.close(); await server?.close(); await store.close(); });
  const gate = new Promise(resolve => { release = resolve; });
  const reads = { head: async () => ({ counted: 0, tip: { height: 0, hash: 'ab'.repeat(32) } }), balance: async () => '0', registry: async () => ({ assets: {} }),
    bitmapSnapshot: async () => { bitmapStarted = true; await gate; return { bitmaps: [{ height: 10, inscription: 'fixture', linked: false }], bitmapContext: { state: 'snapshot', tip: { height: 100, hash: 'ab'.repeat(32) }, checkedAt: 1000 } }; } };
  const views = new PublicViews({ store, history: fixtureHistory(0), reads }), api = createPublicAPI({ views });
  await views.readIndex.available(); views.refreshOnRead = false;
  const empty = key => ({ [key]: [], total: 0, next: null });
  server = await serve({ intake: { store }, files: { serve: async () => false }, web: createWeb(),
    bindings: { read: () => ({ binding: null }) }, publicAPI: { handles: () => true, read: path => {
      const p = new URL(path, 'http://local').pathname;
      if (p === '/status') return { tip: 100, counted: 94 };
      if (p.endsWith('/discoveries') && new URL(path, 'http://local').searchParams.get('state') === 'sealed') return { discoveries: [sealed], total: 1, next: null };
      if (['/patterns', '/compounds', '/feed', '/results/mints'].includes(p)) return empty(p === '/feed' ? 'events' : p.split('/').at(-1));
      return api.read(path);
    } } });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(8000);
  const at = performance.now(); await page.goto(server.url + '/agents/' + address);
  for (const name of ['Agent', 'Wallet balances', 'Discoveries', 'Recent actions', 'Compounds first made', 'Blocks made real', 'Payout wallets'])
    await page.getByRole('heading', { name, exact: true }).waitFor();
  assert.equal(bitmapStarted, true);
  await page.getByText('No spendable matter yet.', { exact: true }).waitFor();
  await page.getByText('1 sealed discovery, can be revealed now, until block 234', { exact: true }).waitFor();
  const panelMs = performance.now() - at;
  const summary = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Agent', exact: true }) });
  await summary.getByRole('button', { name: 'Inspect', exact: true }).click();
  let json = JSON.parse(await page.getByRole('dialog', { name: 'Inspect Agent profile' }).locator('pre').innerText());
  assert.equal(json.bitmapStatus.state, 'deferred'); assert.equal(json.bitmaps, null);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const geometry = () => page.locator('#main section.panel').evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(); return { heading: node.querySelector('h2')?.textContent, x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  const before = await geometry();
  const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/bitmaps'));
  release(); await response;
  // The browser's fetch callback runs after the network response event.
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(r => r.name.includes('/bitmaps?')));
  await summary.getByRole('button', { name: 'Inspect', exact: true }).click();
  json = JSON.parse(await page.getByRole('dialog', { name: 'Inspect Agent profile' }).locator('pre').innerText());
  assert.equal(json.bitmapStatus.state, 'loaded'); assert.equal(json.bitmaps[0].height, 10);
  assert.deepEqual(json.bitmapContext.tip, { height: 100, hash: 'ab'.repeat(32) });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(await geometry(), before, 'no layout changes when bitmaps finish');
  assert.deepEqual(errors, []);
  t.diagnostic(JSON.stringify({ panelMs, bitmapHeldUntilPanelVisible: true, layoutUnchanged: true }));
  await page.route('**/api/**', route => route.continue()); // Disable the one-second HTTP cache for fixture changes.
  sealed = { state: 'sealed', opensAt: 102, revealUntil: 244 }; await page.reload();
  await page.getByText('1 sealed discovery, opens at block 102', { exact: true }).waitFor();
  sealed = { state: 'sealed', opensAt: 2, revealUntil: 99 }; await page.reload();
  await page.getByText('1 sealed discovery, reveal window ended at block 99', { exact: true }).waitFor();
});
