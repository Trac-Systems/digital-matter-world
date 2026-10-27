import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
// Optional read-only evidence run, using the test's already locked browser.
export async function captureLive(browser) {
  const base = 'http://127.0.0.1:58911';
  const out = process.env.DMW_WEB_OUTPUT ?? new URL('../.data/public-pages/', import.meta.url).pathname;
  const get = async path => { const response = await fetch(base + path, { headers: { accept: 'application/json' } }); assert.ok(response.ok, path); return response.json(); };
  const [agents, patterns, compounds, batches, mints, events] = await Promise.all(['/agents?limit=1', '/patterns?limit=1', '/compounds?limit=1', '/records/batches?limit=1', '/results/mints?limit=1', '/events?limit=1'].map(get));
  const routes = ['/', '/explore', '/blocks', '/block/1', '/plot/1', '/table', '/patterns', '/compounds', '/agents', '/feed', '/records', '/results',
    ...['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links', 'treasury', 'burn'].map(k => '/results/' + k),
    '/explore?collection=/finds&key=finds', '/explore?collection=/results/mints&key=mints', '/mint', '/link', '/bind-payout'];
  if (agents.agents?.[0]) routes.push('/agents/' + agents.agents[0].address);
  if (patterns.patterns?.[0]) routes.push('/pattern/' + patterns.patterns[0].asset);
  if (compounds.compounds?.[0]) routes.push('/compound/' + compounds.compounds[0].id);
  if (batches.batches?.[0]) routes.push('/records/batches/' + batches.batches[0].n);
  if (mints.mints?.[0]) routes.push('/mint/' + mints.mints[0].id);
  if (events.events?.[0]) routes.push('/events/' + events.events[0].sequence);
  routes.push('/link/' + 'ab'.repeat(32), '/bind-payout/' + 'cd'.repeat(32));
  await mkdir(out, { recursive: true });
  const report = [];
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    for (const [i, route] of routes.entries()) {
      await page.goto(base + route, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.locator('h1').waitFor();
      const visible = await page.evaluate(() => [document.title, document.body.innerText,
        ...Array.from(document.querySelectorAll('[aria-label], [title], [data-tip], a[href]')).flatMap(e => ['aria-label', 'title', 'data-tip', 'href'].map(a => e.getAttribute(a) ?? ''))].join('\n'));
      const words = visible.match(/\b(?:local|regtest|anvil|devnet|testnet|playground|mainnet|network)\b|31337|0x7a69|https?:\/\/(?:localhost|127\.|0\.0\.0\.0|\[::1\])/ig) ?? [];
      const file = `${String(i + 1).padStart(2, '0')}-${route.replace(/[^a-z0-9]+/gi, '_').slice(0, 90) || 'root'}.png`;
      await page.screenshot({ path: out + '/' + file, fullPage: true });
      report.push({ route, file, words, heading: await page.locator('h1').innerText(), errors: [...errors] });
      console.log(JSON.stringify(report.at(-1)));
    }
    await writeFile(out + '/check-report.json', JSON.stringify(report, null, 2));
    assert.ok(report.every(r => r.words.length === 0), 'No network wording on every route');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}
