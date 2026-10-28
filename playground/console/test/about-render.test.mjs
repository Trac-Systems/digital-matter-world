import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAbout, renderMarkdown } from '../scripts/build-about.mjs';

test('the shipped About view is built from the complete approved Markdown', async () => {
  const markdown = await readFile(new URL('../content/about.md', import.meta.url), 'utf8');
  assert.equal(await readFile(new URL('../js/views/about.js', import.meta.url), 'utf8'), buildAbout(markdown));
  const html = renderMarkdown(markdown);
  assert.equal((html.match(/<table /g) ?? []).length, 8);
  assert.equal((html.match(/class="tablewrap"/g) ?? []).length, 8);
  assert.equal((html.match(/<h[1-6] /g) ?? []).length, (markdown.match(/^#{1,6} /gm) ?? []).length);
});

test('the Markdown subset escapes source text, including bold and inline code', () => {
  const html = renderMarkdown('# Heading\n\n**<strong>** and `<script>` & plain.\n\n| Item | Price |\n|---|---|\n| <img> | {{price:find:3}} |');
  assert.match(html, /<strong>&lt;strong&gt;<\/strong>/);
  assert.match(html, /<code>&lt;script&gt;<\/code> &amp; plain\./);
  assert.match(html, /<td>&lt;img&gt;<\/td>/);
  assert.doesNotMatch(html, /<(?:script|img)>/);
  assert.match(html, /<span data-fee-kind="find" data-fee-tier="3">current price<\/span>/);
  assert.match(html, /tabindex="0" role="region" aria-labelledby="about-heading-0"/);
});
