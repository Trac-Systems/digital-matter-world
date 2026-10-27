import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { lists, reads } from './fixtures.mjs';
import { decodeTracAddress, shortTracAddress } from '../../../rules/src/trac-address.js';
const { chromium } = await import('playwright');

test('agent and feed identities expose the canonical address on hover and copy', async t => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname;
    if (path.startsWith('/api/')) {
      const key = path.slice(5), list = lists[key]; res.setHeader('content-type', 'application/json');
      if (key.endsWith('events')) { res.setHeader('content-type', 'text/event-stream'); res.write(': open\n\n'); return; }
      res.end(JSON.stringify(list ? { [list[0]]: list[1], total: list[1].length, next: null, limit: 200 } : reads[key] ?? {})); return;
    }
    const file = path === '/rules/src/trac-address.js' ? new URL('../../../rules/src/trac-address.js', import.meta.url) : new URL('..' + (path === '/' ? '/index.html' : path), import.meta.url);
    try { res.setHeader('content-type', { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file.pathname)] ?? 'application/octet-stream'); res.end(await readFile(file)); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`, context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), address = reads.player.address;
  for (const route of ['agents', 'feed']) {
    await page.goto(origin + '/#/' + route);
    const identity = page.locator(`[title="${address}"]`).first(); await identity.waitFor();
    assert.equal(await identity.getAttribute('data-tip'), address + '\nClick to copy');
    if (route === 'agents') assert.equal(await identity.textContent(), shortTracAddress(address));
    await identity.click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), address);
    assert.ok(!(await page.locator('body').innerText()).includes(decodeTracAddress(address)));
  }
});
