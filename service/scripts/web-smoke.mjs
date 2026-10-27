import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const origin = process.env.DMW_WEB_ORIGIN ?? 'http://127.0.0.1:58911';
const get = path => fetch(origin + path, { headers: { accept: 'application/json' } }).then(r => r.json());
const [agents, patterns, compounds, batches, mints, events] = await Promise.all(['/agents?limit=1', '/patterns?limit=1', '/compounds?limit=1', '/records/batches?limit=1', '/results/mints?limit=1', '/events?limit=1'].map(get));
const paths = ['/', '/explore', '/block/1', '/plot/1', '/table', '/patterns', '/compounds', '/agents', '/records', '/results', ...['mints','payments','ethereum','payouts','owed','paid','links','treasury','burn'].map(k => '/results/'+k), '/mint','/link','/bind-payout'];
if (agents.agents?.[0]) paths.push('/agents/' + agents.agents[0].address);
if (patterns.patterns?.[0]) paths.push('/pattern/' + patterns.patterns[0].asset);
if (compounds.compounds?.[0]) paths.push('/compound/' + compounds.compounds[0].id);
if (batches.batches?.[0]) paths.push('/records/batches/' + batches.batches[0].n);
if (mints.mints?.[0]) paths.push('/mint/' + mints.mints[0].id);
if (events.events?.[0]) paths.push('/events/' + events.events[0].sequence);
if (process.env.DMW_WEB_LINK_ID) paths.push('/link/' + process.env.DMW_WEB_LINK_ID);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const path of paths) {
    const response = await page.goto(origin + path); assert.equal(response.status(), 200, path);
    await page.waitForLoadState('networkidle');
    const text = await page.locator('main').innerText();
    assert.doesNotMatch(text, /Unable to load:|Could not load:|Page not found/, path + ': ' + text.slice(0, 900));
    assert.doesNotMatch(text, /\b22600000000000000000\b/, path);
    console.log('PASS ' + path);
  }
  assert.deepEqual(errors, []);
  await page.goto(origin + '/explore'); await page.waitForLoadState('networkidle');
  const frontier = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Frontier and plots', exact: true }) });
  const before = await frontier.locator('tbody').innerText(); await frontier.getByRole('button', { name: 'Next', exact: true }).click();
  await frontier.locator('.collection-status').filter({ hasText: 'page 2.' }).waitFor(); assert.notEqual(await frontier.locator('tbody').innerText(), before);
  assert.ok(await frontier.locator('tbody tr').count() <= 25); console.log('PASS bounded live cursor paging');
} finally { await browser.close(); }
