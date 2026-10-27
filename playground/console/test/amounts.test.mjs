import { decodeTracAddress, tracIdentityFields } from '../../../rules/src/trac-address.js';
// Renders every console screen against fixture data (atomic 18-decimal amounts) in headless Chromium and fails if
// any number with 13 or more digits is visible outside the Inspect drawer.
// Run: node --test playground/console/test/amounts.test.mjs   (SHOTS=DIR also saves a screenshot per screen)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lists, reads, quote } from './fixtures.mjs';

const { chromium } = await import('playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

// Paged like the documented contract: limit, opaque cursor (an offset here), total, next.
const identityKeys = new Set();
function checkIdentities(value, key = '') {
  if (typeof value === 'string' && tracIdentityFields.has(key)) {
    assert.ok(!/^[0-9a-f]{64}$/.test(value), `Raw Trac identity in fixture ${key}`);
    if (value.startsWith('trac1')) identityKeys.add(decodeTracAddress(value));
  } else if (Array.isArray(value)) value.forEach(v => checkIdentities(v, key));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (!['split', 'amounts'].includes(k)) checkIdentities(v, k);
}
checkIdentities({ lists, reads, quote });
const requests = [];
function page(res, key, all, url) {
  // Exact filters on fields the rows actually have, like the gateway's simple filters.
  const skip = new Set(['limit', 'cursor', 'sort', 'order', 'q', 'category', 'actor', 'since', 'nonzero', 'positive', 'whoMayMint']);
  let rows = all;
  for (const [k, v] of url.searchParams) if (!skip.has(k)) rows = rows.filter(r => r[k] === undefined || String(r[k]) === v);
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50)), at = Number(url.searchParams.get('cursor') ?? 0);
  const next = at + limit < rows.length ? String(at + limit) : null;
  res.end(JSON.stringify({ [key]: rows.slice(at, at + limit), total: rows.length, next, limit, sort: url.searchParams.get('sort'), order: url.searchParams.get('order') }));
}
function api(req, res) {
  const url = new URL(req.url, 'http://x'), path = url.pathname.replace(/^\/api\//, '');
  res.setHeader('Content-Type', 'application/json');
  requests.push(url.pathname + url.search);
  if (path === 'events' || path === 'lab/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': open\n\n'); return; }
  if (req.method === 'POST') { res.statusCode = 202; res.end(JSON.stringify({ id: 'q1', state: 'complete', type: path, result: path.endsWith('mint/quote') ? quote : {} })); return; }
  if (path.startsWith('jobs/')) { res.end(JSON.stringify({ id: 'q1', state: 'complete', result: quote })); return; }
  if (lists[path]) { page(res, lists[path][0], lists[path][1], url); return; }
  if (reads[path]) { res.end(JSON.stringify(reads[path])); return; }
  res.statusCode = 404; res.end(JSON.stringify({ error: 'not_found' }));
}
async function serve() {
  const server = createServer(async (req, res) => {
    if (req.url === '/rules/src/trac-address.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(await readFile(new URL('../../../rules/src/trac-address.js', import.meta.url))); }
    if (req.url.startsWith('/api/')) return api(req, res);
    const file = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname === '/' ? 'index.html' : new URL(req.url, 'http://x').pathname)));
    if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
    try { res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream'); res.end(await readFile(file)); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}

// Visible text outside the Inspect drawer, plus tooltips, which are visible on hover.
const visible = p => p.evaluate(() => {
  const parts = [];
  for (const el of document.querySelectorAll('body *')) if (el.closest('.drawer') === null && el.dataset?.tip) parts.push(el.dataset.tip);
  const clone = document.body.cloneNode(true); clone.querySelectorAll('.drawer, script').forEach(n => n.remove());
  return clone.innerText + '\n' + parts.join('\n');
});
const LONG = /\d(?:[,.]?\d){12,}/g;

const SCREENS = [
  ['about', '#/about', 'article.page'],
  ['pattern detail', '#/table?p=p0', '.el'],
  ['world block', '#/world?b=7', '[data-h="7"]'],
  ['periodic table', '#/table', '.el'],
  ['periodic list', '#/table', '.el', async p => { await p.click('#pt-mode button:nth-child(2)'); await p.waitForTimeout(300); }],
  ['player', '#/player', '.figures'],
  ['player bitmap', '#/player?do=bitmap', '.figures'],
  ['mint choose', '#/player?do=mint', '.figures', async p => { await p.click('text=Choose a block to mint'); await p.getByRole('heading',{name:'Mint from your wallet'}).waitFor(); await p.waitForTimeout(300); }],
  ['mint quote', '#/player?do=mint', '.figures', async p => { await p.click('text=Choose a block to mint'); await p.locator('.modal button:has-text("Choose")').first().click(); await p.getByRole('button',{name:'Connect wallet and get quote'}).waitFor(); }],
  ['feed live', '#/feed', '.feed-row'],
  ['feed history', '#/feed', '.feed-row', async p => { await p.click('button:has-text("History")'); await p.waitForTimeout(400); }],
  ['agents', '#/agents', '.figures'],
  ['lab', '#/lab', '.health-grid'],
  ['lab fee confirm', '#/lab', '.health-grid', async p => { await p.click('button:has-text("Set")'); await p.waitForSelector('.modal'); }],
  ...['mints', 'payments', 'ethereum', 'payouts', 'owed', 'links'].map((t, i) => [`results ${t}`, '#/results', '.figures', async p => { await p.locator('.tabs button').nth(i).click(); await p.waitForTimeout(300); }]),
];

test('no screen shows a raw atomic amount (13+ digit number) outside Inspect', async () => {
  const server = await serve(), base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const failures = [], errors = [];
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      for (const [name, hash, ready, act] of SCREENS) {
        const ctx = await browser.newContext({ viewport }), p = await ctx.newPage();
        p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
        await p.goto(base + hash); await p.waitForSelector(ready, { timeout: 15000 }); await p.waitForTimeout(500);
        if (act) await act(p);
        if (name.startsWith('results ')) assert.match(await visible(p), /Outstanding supply[\s\S]*Bridged TAP supply now/);
        if (name === 'feed live') assert.match(await visible(p), /Index caught up/);
        if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/${name.replace(/\s+/g, '-')}-${viewport.width}.png` });
        const text = await visible(p);
        for (const key of identityKeys) assert.ok(!text.includes(key), `${name}: raw Trac identity in text or tooltip`);
        const hits = text.match(LONG);
        if (hits) failures.push(`${name} @${viewport.width}: ${[...new Set(hits)].join(', ')}`);
        await ctx.close();
      }
    }
  } finally { await browser.close(); server.close(); }
  assert.deepEqual(errors, [], 'page errors');
  assert.deepEqual(failures, [], 'raw atomic amounts on screen');
});

test('paged tables: total, cursor pages, sort and filter go to the server', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ asset: i % 2 ? 'p1' : 'p0', block: 1000 - i, amount: '1', allowed: true, reason: 'public', minted: false, pending: null }));
  const saved = lists['player/mintRights']; lists['player/mintRights'] = ['mintRights', many];
  const server = await serve(), base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await p.goto(base + '#/player'); await p.waitForSelector('.figures');
    const panel = p.locator('section.panel', { has: p.locator('h2', { hasText: 'Mint rights' }) });
    await panel.locator('.pager-foot', { hasText: '1–25 of 60' }).waitFor();
    assert.equal(await panel.locator('tbody tr').count(), 25, 'only one page rendered');
    await panel.locator('button:has-text("Next")').click();
    await panel.locator('.pager-foot', { hasText: '26–50 of 60' }).waitFor();
    assert.ok(requests.some(r => r.startsWith('/api/player/mintRights') && r.includes('cursor=25')), 'next page uses the cursor');
    await panel.locator('select[aria-label="Sort"]').selectOption('amount:desc');
    await panel.locator('.pager-foot', { hasText: '1–25 of 60' }).waitFor();
    assert.ok(requests.some(r => r.includes('/api/player/mintRights') && r.includes('sort=amount') && r.includes('order=desc')), 'sort and order sent');
    await panel.locator('select[aria-label="Show"]').selectOption('me');
    await p.waitForTimeout(300);
    assert.ok(requests.some(r => r.includes('/api/player/mintRights') && r.includes('whoMayMint=me')), 'filter sent');
  } finally { lists['player/mintRights'] = saved; await browser.close(); server.close(); }
});

