// Run after editing content/about.md; --check verifies the checked-in view.
// This deliberately supports only the Markdown used by the approved document.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function inline(text) {
  let html = '', at = 0;
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|\{\{price:(find:[1-5]|compound-minimum|link)\}\}|\{\{(legacy-deploy-share)\}\}|\{\{(deployer-share)\}\}/g)) {
    html += escape(text.slice(at, match.index));
    if (match[7] !== undefined) html += '<span data-deployer-share></span>';
    else if (match[6] !== undefined) html += '<span data-legacy-deploy-share>The older deployment share is inactive.</span>';
    else if (match[5] !== undefined) {
      const [kind, tier = '1'] = match[5].split(':');
      html += `<span data-fee-kind="${kind}" data-fee-tier="${tier}">current fee</span>`;
    } else if (match[3] !== undefined) html += `<a href="${escape(match[4])}" target="_blank" rel="noopener">${escape(match[3])}</a>`;
    else html += match[1] === undefined ? `<code>${escape(match[2])}</code>` : `<strong>${inline(match[1])}</strong>`;
    at = match.index + match[0].length;
  }
  return html + escape(text.slice(at));
}
const cells = line => line.trim().slice(1, -1).split('|').map(cell => cell.trim());
const divider = line => /^\|(?:\s*:?-+:?\s*\|)+$/.test(line ?? '');

export function renderMarkdown(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n'), html = [];
  let i = 0, heading = 0, labelledBy = '';
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const title = /^(#{1,6}) (.+)$/.exec(lines[i]);
    if (title) {
      const level = title[1].length;
      labelledBy = `about-heading-${heading++}`;
      const tag = `<h${level} id="${labelledBy}">${inline(title[2])}</h${level}>`;
      html.push(level === 1 ? `<div class="page-head">${tag}</div>` : tag);
      i++; continue;
    }
    if (lines[i].startsWith('|') && divider(lines[i + 1])) {
      const headers = cells(lines[i]), rows = [];
      if (cells(lines[i + 1]).length !== headers.length) throw Error('About table header width');
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) {
        const row = cells(lines[i++]);
        if (row.length !== headers.length) throw Error('About table row width');
        rows.push(`<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`);
      }
      html.push(`<div class="tablewrap" tabindex="0" role="region" aria-labelledby="${labelledBy}"><table class="t"><thead><tr>${headers.map(cell => `<th scope="col">${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6} /.test(lines[i]) && !(lines[i].startsWith('|') && divider(lines[i + 1]))) {
      paragraph.push(lines[i++]);
    }
    html.push(`<p>${inline(paragraph.join('\n'))}</p>`);
  }
  const out = html.join('\n'), text = out.replace(/<[^>]*>/g, '');
  // Markdown syntax left in the visible text means the renderer missed it; fail the build.
  const raw = /\*\*|\]\(|`/.exec(text);
  if (raw) throw Error(`About markdown left unrendered near: ${text.slice(Math.max(0, raw.index - 40), raw.index + 40)}`);
  return out;
}

export function buildAbout(markdown) {
  return `// Generated from content/about.md by scripts/build-about.mjs. Do not edit.
import { h, clear } from '../dom.js';
import { bus, store } from '../api.js';
import { feePrice, legacyDeployPolicyText, deployerSharePolicyText } from '../money.js';
import { tickersOpen } from '../tickers.js';

const html = ${JSON.stringify(renderMarkdown(markdown))};

export function mount(root) {
  const article = h('article.page.about', { html });
  clear(root, article);
  const prices = article.querySelectorAll('[data-fee-kind]');
  const update = status => {
    for (const price of prices) price.textContent = feePrice(status?.feePolicy, price.dataset.feeKind, Number(price.dataset.feeTier));
    const legacy = article.querySelector('[data-legacy-deploy-share]');
    if (legacy) legacy.textContent = legacyDeployPolicyText(status);
    // The ticker deployer's share is described once extra tickers are open.
    const deployer = article.querySelector('[data-deployer-share]');
    if (deployer) tickersOpen().then(open => { deployer.textContent = open ? deployerSharePolicyText(status) : ''; });
  };
  update(store.status);
  return bus.on('status', update);
}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = new URL('../content/about.md', import.meta.url), target = new URL('../js/views/about.js', import.meta.url);
  const built = buildAbout(await readFile(source, 'utf8'));
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== built) throw Error('About view is stale; run node playground/console/scripts/build-about.mjs');
  } else await writeFile(target, built);
}
