import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { PublicViews } from '../src/public-views.mjs';
import * as r from '../../rules/src/index.js';

const document = r.settingsRevision({ network: 'names', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
test('public name-field activation follows counted height and the one rules constant', async () => {
  let counted = String(BigInt(r.PLAIN_NAMES_HEIGHT) - 1n);
  const view = Object.assign(Object.create(PublicViews.prototype), {
    network: 'names', store: { get: () => null, hasRows: () => false },
    head: async () => ({ tip: { height: r.PLAIN_NAMES_HEIGHT }, counted }),
    reads: { rulesContext: async () => ({ ready: true, settings: document, settingsHash: r.hashObject(document), last: { n: '1', to: counted } }),
      tip: async () => ({ tip: r.PLAIN_NAMES_HEIGHT }) }, feePolicyV2: async () => ({})
  });
  assert.equal((await view.statusV2()).plainNames, false);
  counted = r.PLAIN_NAMES_HEIGHT; assert.equal((await view.statusV2()).plainNames, true);
});

test('discovery input switches text and limits at activation while preserving its DOM and typed value', async t => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    if (path === '/') { res.setHeader('content-type', 'text/html'); res.end('<main></main><div id="toasts"></div>'); return; }
    if (path.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ agents: [], rows: [], next: null })); return; }
    if (/^\/(?:playground\/console\/js|rules\/src|kit\/lib)\/[a-z0-9/.-]+\.(?:js|mjs)$/.test(path) && !path.includes('..')) {
      try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL('../..' + path, import.meta.url))); return; } catch {}
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.evaluate(async () => {
    const { store } = await import('/playground/console/js/api.js');
    store.status = { plainNames: false }; store.refreshPlayer = async () => {}; store.refreshStatus = async () => {}; store.refreshPatterns = async () => {};
    const { mount } = await import('/playground/console/js/views/player.js');
    window.cleanup = mount(document.querySelector('main'), { do: 'discover' });
  });
  const input = page.getByRole('textbox', { name: 'Name after dmw', exact: true });
  await input.fill('florite'); assert.equal(await input.getAttribute('maxlength'), '29');
  await page.getByRole('textbox', { name: 'Rule', exact: true }).fill('7{3}');
  const submitName = async expected => {
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    const submitted = page.waitForRequest(req => req.url() === origin + '/api/player/discovery/commit' && req.method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: 'Commit', exact: true }).click();
    assert.equal((await submitted).postDataJSON().proposal.name, expected);
  };
  await submitName('dmwflorite');
  const shape = await input.evaluate(el => { el.dataset.retained = 'yes'; return el.parentElement.outerHTML.replace(/dmw|Name after dmw|29|florite/g, ''); });
  await page.evaluate(async () => { const { store, bus } = await import('/playground/console/js/api.js'); store.status.plainNames = true; bus.emit('status', store.status); });
  const plain = page.getByRole('textbox', { name: 'Name', exact: true });
  assert.equal(await plain.inputValue(), 'florite'); assert.equal(await plain.getAttribute('maxlength'), '32');
  assert.equal(await plain.getAttribute('data-retained'), 'yes');
  assert.equal(await plain.evaluate(el => el.parentElement.querySelector('span').textContent), '');
  assert.ok(shape.includes('span'), 'prefix node exists before and after the text change');
  await submitName('florite');
  await page.evaluate(() => window.cleanup());
});

test('public name search distinguishes plain and prefixed names without choosing an ambiguous display title', async t => {
  const patterns = ['dmwflorite', 'florite', 'dmw', 'dmwa'].map((name, i) => ({ asset: `p2:${i}`, number: String(i), name, pat: '1', fld: 4, dt: 'n', tier: 1 }));
  const reads = [], server = await serve({ files: { serve: async () => false }, web: createWeb({ target: {}, records: async () => ({}) }),
    publicAPI: { handles: () => true, read(path) {
      reads.push(path); const url = new URL(path, 'http://local');
      if (url.pathname === '/status') return { tip: '0', counted: '0' };
      if (url.pathname === '/patterns') return { patterns: patterns.filter(p => p.name.includes(url.searchParams.get('q') ?? '')), total: null, next: null };
      return { rows: [], [url.pathname === '/feed' ? 'events' : url.pathname.slice(1)]: [], total: 0, next: null };
    } } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  await page.goto(server.url + '/mint');
  const search = page.locator('input[list="public-pattern-names"]');
  await search.fill('flor'); await search.dispatchEvent('change');
  await page.getByText('2 patterns match “flor”. Pick one from the suggestions.', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('#public-pattern-names option').evaluateAll(rows => rows.map(r => r.value)), ['Florite (dmwflorite)', 'Florite (florite)']);
  const choose = async (name, asset) => {
    const request = page.waitForRequest(req => { const url = new URL(req.url()); return url.pathname.endsWith('/public-mints') && url.searchParams.get('asset') === asset; });
    await search.fill(name); await search.dispatchEvent('change'); await request;
  };
  await choose('dmwflorite', 'p2:0');
  await choose('florite', 'p2:1');
  await choose('Florite (dmwflorite)', 'p2:0');
  await choose('FLORITE (FLORITE)', 'p2:1');
  assert.ok(reads.some(path => path.includes('q=dmwflorite')));
  assert.deepEqual(await page.evaluate(async () => { const { title } = await import('/web/console/js/words.js'); return ['dmwflorite', 'florite', 'dmw', 'dmwa'].map(title); }), ['Florite', 'Florite', 'Dmw', 'Dmwa']);
});
