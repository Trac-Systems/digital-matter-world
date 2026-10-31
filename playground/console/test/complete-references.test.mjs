import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../../../service/src/http.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { encodeTracAddress, shortTracAddress } from '../../../rules/src/trac-address.js';
import { COMPOUND_IDENTITY_V4_MERGES } from '../../../rules/src/compound-merge-manifest.js';
const { chromium } = await import('playwright');

// The pages are explorers: every pattern, compound, agent and block they mention is named and links to its page.
const owner = encodeTracAddress('11'.repeat(32)), other = encodeTracAddress('22'.repeat(32));
const wallet = 'bc1pldtajcf7mwvgajk4ar5t8xnfrqksmu9zlcfvqw8dcrnwmd4sskksmct2rw';
const compound = 'c2:e9f0843ea3da981ce457b38b35170e16e2448c9f93581c48c50c366013d34729';
const merged = 'c2:2b91a38746504080d048ec76ed4234f22ab8555bcda7daffa925869a6d62552f';
const inscription = 'ab'.repeat(32) + 'i0';
const patterns = [['1', 'nullspar', 4], ['2', 'muffinite', 10], ['3', 'natural', 11]].map(([n, name, fld]) =>
  ({ asset: 'p2:' + n, number: n, name, pat: '[0-9]', fld, dt: 'n', tier: 4, rarity: '3', supply: '10', discoverer: owner }));
const compounds = [{ id: compound, recipe: 'fusion', tier: 5, supply: '11', madeReal: '0', firstMaker: owner, properties: { generation: '1' },
  inputs: [{ asset: 'p2:1', amount: '1' }, { asset: 'p2:2', amount: '1' }] }];
const events = [
  { sequence: 6, id: 'e6', at: 1, type: 'discovery', data: { state: 'accepted', name: 'natural', tier: 5, asset: 'p2:3', agent: owner, knownMatchCount: '3', anchor: { height: '973882' } } },
  { sequence: 5, id: 'e5', at: 1, type: 'find', data: { asset: 'p2:1', block: '508822', count: 1, finder: owner, findHeight: '973868' } },
  { sequence: 4, id: 'e4', at: 1, type: 'find', data: { asset: 'p2:1', block: '699416', count: 1, finder: owner, findHeight: '973868' } },
  { sequence: 3, id: 'e3', at: 1, type: 'craft', data: { owner, amount: '10', id: merged } },
  { sequence: 2, id: 'e2', at: 1, type: 'transfer', data: { from: owner, to: other, assets: [['p2:2', '3']] } },
  { sequence: 1, id: 'e1', at: 1, type: 'mint_complete', data: { owner, amount: '1', asset: 'p2:1', block: 500009 } },
];
const mints = [{ id: 'cd'.repeat(32), asset: 'p2:1', block: 500009, amount: 1, price: '1000', kind: 'tap', state: 'minted', inscription, receiver: wallet }];
function pageRows(key, rows, u) {
  const at = Number(u.searchParams.get('cursor') ?? 0), limit = Number(u.searchParams.get('limit') ?? 50);
  return { [key]: rows.slice(at, at + limit), total: rows.length, next: at + limit < rows.length ? String(at + limit) : null };
}
function read(path) {
  const u = new URL(path, 'http://local'), p = u.pathname, q = k => u.searchParams.get(k);
  if (p === '/status') return { tip: 973900, counted: 973900, feePolicy: { baseFee: '1000', unit: { decimals: 0 } } };
  if (p === '/patterns') return pageRows('patterns', patterns.filter(r => !q('asset') || r.asset === q('asset')), u);
  if (p === '/compounds') return pageRows('compounds', compounds.filter(c => (!q('asset') || c.id === q('asset')) && (!q('firstMaker') || c.firstMaker === q('firstMaker'))), u);
  if (p === '/agents') return pageRows('agents', [{ address: owner, finds: 2, discoveries: 1, crafts: 1, mints: 1 }, { address: other, finds: 0 }], u);
  if (p === `/agents/${owner}`) return { address: owner, scores: { finds: 2 } };
  if (p === `/agents/${owner}/balances`) return pageRows('balances', [{ asset: compound, amount: '11' }, { asset: 'p2:1', amount: '159' }], u);
  if (p === `/agents/${owner}/history` || p === '/feed') return pageRows(p === '/feed' ? 'events' : 'history', p === '/feed' && q('since') ? [] : events, u);
  if (p === `/agents/${owner}/discoveries`) return pageRows('discoveries', q('state') === 'accepted' ? [patterns[2]] : [], u);
  if (p === '/results/mints') return pageRows('mints', mints, u);
  if (p === '/results') return { counts: {}, treasury: {}, burn: {}, outstandingSupply: {} };
  if (p === '/finds') return pageRows('finds', [{ asset: 'p2:1', block: 500009, count: 1, finder: owner }], u);
  if (p === '/world/map') return { from: '500000', to: '500010', tip: '973900', marks: [], next: null };
  if (p === '/blocks/500009') return { height: 500009, header: { hash: 'ef'.repeat(32), prev: '01'.repeat(32), nonce: 1, bits: 1, time: 1 } };
  if (p === '/blocks/500009/matches') return pageRows('matches', [{ asset: 'p2:1', count: 1, finder: owner }], u);
  if (p === '/blocks/500009/claims') return pageRows('claims', [{ window: 973866, agent: owner, patterns: ['1'] }], u);
  return pageRows(p.split('/').at(-1), [], u);
}
let browser, server;
before(async () => {
  server = await serve({ intake: { store: {} }, files: { serve: async () => false },
    web: createWeb({ records: async () => ({ rarestFinds: { ever: { asset: 'p2:3', block: 500009, rarity: { numerator: 1, denominator: 3 } } }, highestTierCompound: { ...compounds[0], asset: compound } }) }),
    publicAPI: { handles: () => true, read },
    bindings: { wallets: () => ({ players: [], more: false }), read: () => ({ binding: { request: { address: wallet }, acceptedAt: 1 } }) } });
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

// Every visible text naming a known thing must sit inside a link; no raw key may show. `own` is the page's subject.
async function walk(t, path, { own = [], expect = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage();
  t.after(() => context.close());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  await page.goto(server.url + path);
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(400);
  const names = ['Nullspar', 'Muffinite', 'Natural', 'Nullspar + Muffinite fusion', shortTracAddress(owner), shortTracAddress(other)];
  const found = await page.evaluate(({ names, own }) => {
    const bad = [], seen = [];
    const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement, text = n.textContent;
      if (!text.trim() || !el.checkVisibility() || el.closest('code, pre, option, input, select, .ptable, .drawer')) continue;
      if (/\b(?:p2:[0-9]+|c2:[0-9a-f]{6,})|trac1[0-9a-z]{30,}/.test(text)) bad.push(`raw key: ${text}`);
      const own_ = el.closest('h1, h2, .hash') && own.some(o => text.includes(o));
      for (const name of names) if (new RegExp(`(^|[^A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z])`).test(text)) {
        seen.push(name);
        if (!el.closest('a[href]') && !own_) bad.push(`not linked: "${text.trim()}" in <${el.tagName.toLowerCase()} class="${el.className}">`);
      }
    }
    // Block columns link every block they show.
    for (const table of document.querySelectorAll('main table')) {
      const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
      for (const tr of table.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => {
        if (/^(Block|Bitcoin block|Bitmap|Linked at block)$/.test(heads[i] ?? '') && /\d/.test(td.textContent) && !td.querySelector('a[href]')) bad.push(`block not linked: ${td.textContent}`);
      });
    }
    return { bad, seen };
  }, { names, own });
  assert.deepEqual(found.bad, [], path);
  for (const name of expect) assert.ok(found.seen.includes(name) || (await page.locator('main a[href]', { hasText: name }).count()) > 0, `${path} shows ${name}`);
  assert.deepEqual(errors, [], 'no script errors');
  return page;
}

test('the merged compound ids the site names are exactly the rules merge manifest', async () => {
  const { MERGED_COMPOUNDS } = await import('../js/words.js');
  assert.deepEqual([...MERGED_COMPOUNDS], COMPOUND_IDENTITY_V4_MERGES.rows.map(r => [r.oldId, r.newId]));
});

test('agent page: balances, discoveries, actions, compounds, mints and payout wallets all link', async t => {
  const page = await walk(t, `/agents/${owner}`, { own: [shortTracAddress(owner).slice(0, 8)], expect: ['Nullspar + Muffinite fusion', 'Natural'] });
  const actions = page.locator('section.panel', { hasText: 'Recent actions' });
  assert.equal(await actions.locator('a', { hasText: 'Natural' }).getAttribute('href'), '/pattern/p2:3');
  assert.match(await actions.innerText(), /discovered Natural: tier 5, 3 blocks/);
  // The merged compound id is named and linked as the compound it became.
  assert.equal(await actions.locator('a', { hasText: 'Nullspar + Muffinite fusion' }).getAttribute('href'), '/compound/' + compound);
  assert.equal(await actions.locator('a', { hasText: '508,822' }).getAttribute('href'), '/block/508822');
  assert.equal(await actions.locator('a', { hasText: shortTracAddress(other) }).getAttribute('href'), '/agents/' + other);
  assert.equal(await page.locator('section.panel', { hasText: 'Compounds first made' }).locator('a', { hasText: 'Nullspar + Muffinite fusion' }).getAttribute('href'), '/compound/' + compound);
  assert.equal(await page.locator('section.panel', { hasText: 'Wallet balances' }).locator('a', { hasText: 'Nullspar' }).first().getAttribute('href'), '/compound/' + compound);
  assert.equal(await page.locator('section.panel', { hasText: 'Payout wallets' }).locator('a').first().getAttribute('href'), 'https://mempool.space/address/' + wallet);
  assert.equal(await page.locator('section.panel', { hasText: 'Blocks made real' }).locator('a[href^="https://ordinals.com/inscription/"]').count(), 1);
  assert.equal(await page.locator('section.panel', { hasText: 'Leaderboard' }).locator(`a[href="/agents/${other}"]`).count(), 1);
});

test('feed, table, pattern, compound, block, results and records pages link every reference', async t => {
  await walk(t, '/feed', { expect: ['Natural', 'Nullspar'] });
  await walk(t, '/table');
  await walk(t, '/pattern/p2:3', { own: ['Natural'] });
  await walk(t, '/compound/' + compound, { own: ['Nullspar + Muffinite fusion'], expect: ['Nullspar', 'Muffinite'] });
  // An old merged id opens the compound it became.
  await walk(t, '/compound/' + merged, { own: ['Nullspar + Muffinite fusion'], expect: ['Muffinite'] });
  await walk(t, '/block/500009', { expect: ['Nullspar'] });
  await walk(t, '/results/mints', { expect: ['Nullspar'] });
  await walk(t, '/records', { expect: ['Natural'] });
});
