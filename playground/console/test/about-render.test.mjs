import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAbout, renderMarkdown, parseFlow } from '../scripts/build-about.mjs';

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
  assert.match(html, /<span data-fee-kind="find" data-fee-tier="3">current fee<\/span>/);
  assert.match(html, /tabindex="0" role="region" aria-labelledby="about-heading-0"/);
});

test('a link inside bold text is rendered as a clickable link, and leftover Markdown fails the build', () => {
  const html = renderMarkdown('See **[the repo](https://github.com/x/y)** now.');
  assert.match(html, /<strong><a href="https:\/\/github\.com\/x\/y" target="_blank" rel="noopener">the repo<\/a><\/strong>/);
  assert.throws(() => renderMarkdown('A [link](http://plain.example) only https is supported.'), /unrendered/);
});

test('every topic link resolves to a section heading, in page order, and every section is listed', async () => {
  const markdown = await readFile(new URL('../content/about.md', import.meta.url), 'utf8');
  const html = renderMarkdown(markdown);
  const nav = /<nav class="about-topics" aria-label="Topics on this page">(.*?)<\/nav>/.exec(html);
  assert.ok(nav, 'topic navigation at the top');
  assert.ok(html.indexOf(nav[0]) < html.indexOf('<h2 '), 'the topics come before the first section');
  const links = [...nav[1].matchAll(/<a class="pill" href="#([a-z][a-z0-9-]*)">([^<]+)<\/a>/g)].map(m => m[1]);
  const sections = [...html.matchAll(/<h2 id="([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual(links, sections);
  assert.ok(links.includes('steps') && links.includes('without-agent'));
  for (const id of links) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, `one target for #${id}`);
  assert.throws(() => renderMarkdown('## A {#a}\n\n## B {#a}'), /repeat/);
  assert.throws(() => renderMarkdown('### A {#a}'), /Only ## headings/);
});

test('the diagram is drawn twice from one source, with real text, Bitmap, both chains and the full split', async () => {
  const markdown = await readFile(new URL('../content/about.md', import.meta.url), 'utf8');
  const html = renderMarkdown(markdown);
  const figure = /<figure class="about-flow" id="about-flow-0">(.*?)<\/figure>/.exec(html)?.[1];
  assert.ok(figure, 'diagram present');
  const svgs = [...figure.matchAll(/<svg class="(fl-wide|fl-narrow)" viewBox="0 0 (\d+) (\d+)"[^>]*>(.*?)<\/svg>/g)];
  assert.deepEqual(svgs.map(m => m[1]), ['fl-wide', 'fl-narrow']);
  assert.ok(Number(svgs[1][2]) <= 396, 'the phone drawing fits a 390 px screen at its natural size');
  for (const [, , , , body] of svgs) {
    const text = [...body.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map(m => m[1]).join(' ');
    for (const word of ['Bitcoin block', 'Bitmap', 'Claim on Trac', 'finder', 'ticker', 'Every mint pays', 'Treasury', 'Burned', 'Pattern discoverer'])
      assert.ok(text.includes(word), `${word} in the drawing`);
    assert.doesNotMatch(body, /style=|<style|<path[^>]*class="fl-t/);
    assert.equal((body.match(/class="fl-stage /g) ?? []).length, 6);
  }
  // No inline styles anywhere: the site's CSP allows only its stylesheet.
  assert.doesNotMatch(html, /style=|<style/);
  const flow = parseFlow(['::: Title', '- A | Bitcoin | x', '- B | Agent | x', '- C | Trac | x', '- D | Trac | x', '- E | Trac | x', '- F | Bitcoin | x', '= Pays', '30 % | Finder | finder', 'rest | Treasury | treasury']);
  assert.deepEqual(flow.shares.map(s => s.percent), [30, 70]);
  assert.throws(() => parseFlow(['::: Title', '- A | Bitcoin | x', '= Pays', 'rest | T | treasury']), /six stages/);
});

test('prices are settings: About never states a TAP amount, only live price placeholders', async () => {
  const markdown = await readFile(new URL('../content/about.md', import.meta.url), 'utf8');
  const html = renderMarkdown(markdown);
  assert.doesNotMatch(markdown, /\d[\d.,]*\s*(?:bridged\s+)?TAP\b|\bTAP\s*\d/);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ' '), /\d[\d.,]*\s*(?:bridged\s+)?TAP\b/);
  assert.match(html, /<span data-ticker-fee>the current fee<\/span>/);
  assert.match(html, /<span data-ticker-burn-share>a part<\/span>/);
  assert.match(html, /<span data-fee-kind="link" data-fee-tier="1">current fee<\/span>/);
});

test('site links open in place and other sites in a new tab', () => {
  const html = renderMarkdown('[Mint](/mint) and [repo](https://github.com/x/y).');
  assert.match(html, /<a href="\/mint">Mint<\/a>/);
  assert.match(html, /<a href="https:\/\/github\.com\/x\/y" target="_blank" rel="noopener">repo<\/a>/);
  assert.throws(() => renderMarkdown('[bad](//evil.example)'), /unrendered/);
});
