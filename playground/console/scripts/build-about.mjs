// Run after editing content/about.md; --check verifies the checked-in view.
// This deliberately supports only the Markdown used by the approved document, plus three page blocks:
// `## Heading {#id Short label}` names a topic, a `[[topics]]` line lists the topics as links, and a
// `:::flow Title` … `:::` block draws the diagram (see flowFigure).
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function inline(text) {
  let html = '', at = 0;
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https:\/\/[^\s)]+|\/[a-z][a-z0-9/-]*(?:#[a-z][a-z0-9-]*)?)\)|\{\{price:(find:[1-5]|find-all|compound-minimum|link|ticker)\}\}|\{\{(legacy-deploy-share)\}\}|\{\{(deployer-share)\}\}|\{\{(ticker-burn-share)\}\}/g)) {
    html += escape(text.slice(at, match.index));
    if (match[8] !== undefined) html += '<span data-ticker-burn-share>a part</span>';
    else if (match[7] !== undefined) html += '<span data-deployer-share></span>';
    else if (match[6] !== undefined) html += '<span data-legacy-deploy-share>The older deployment share is inactive.</span>';
    else if (match[5] === 'ticker') html += '<span data-ticker-fee>the current fee</span>';
    else if (match[5] !== undefined) {
      const [kind, tier = '1'] = match[5].split(':');
      html += `<span data-fee-kind="${kind}" data-fee-tier="${tier}">current fee</span>`;
    } else if (match[3] !== undefined) {
      // Site pages open in place; other sites open in a new tab.
      const external = match[4].startsWith('https://');
      html += `<a href="${escape(match[4])}"${external ? ' target="_blank" rel="noopener"' : ''}>${escape(match[3])}</a>`;
    }
    else html += match[1] === undefined ? `<code>${escape(match[2])}</code>` : `<strong>${inline(match[1])}</strong>`;
    at = match.index + match[0].length;
  }
  return html + escape(text.slice(at));
}
const cells = line => line.trim().slice(1, -1).split('|').map(cell => cell.trim());
const divider = line => /^\|(?:\s*:?-+:?\s*\|)+$/.test(line ?? '');
const topicHeading = /^(#{1,6}) (.+?)(?: \{#([a-z][a-z0-9-]*)(?: ([^}]+))?\})?$/;
const listItem = /^(\d+)\. (.+)$/;
const block = line => /^#{1,6} /.test(line) || line === '[[topics]]' || line.startsWith(':::') || listItem.test(line);

// Words into lines of at most `max` characters (the diagram's text is plain and short).
function wrap(text, max) {
  const lines = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (lines.length && (lines.at(-1) + ' ' + word).length <= max) lines[lines.length - 1] += ' ' + word;
    else lines.push(word);
  }
  return lines;
}
const svgText = (x, y, cls, lines, step = 18) =>
  `<text class="${cls}" x="${x}" y="${y}">${lines.map((line, i) => `<tspan x="${x}" dy="${i ? step : 0}">${escape(line)}</tspan>`).join('')}</text>`;
const arrowHead = (x, y, dir) => {
  const [a, b] = dir === 'down' ? [[x - 5, y - 8], [x + 5, y - 8]] : [[x - 8, y - 5], [x - 8, y + 5]];
  return `<path class="fl-ah" d="M${a[0]} ${a[1]}L${x} ${y}L${b[0]} ${b[1]}Z"/>`;
};

// The diagram: numbered stages (`- Title | Place | Text`), then `= Heading` and the mint split
// (`30 % | Who | role`, `rest | Who | role` for the remainder). Two drawings of the same content:
// three columns for wide screens and one column for phones; CSS shows one of them.
export function parseFlow(lines) {
  const flow = { title: lines[0].slice(3).trim(), steps: [], pays: null, shares: [] };
  for (const line of lines.slice(1)) {
    if (line.startsWith('- ')) {
      const [title, place, text, extra] = line.slice(2).split('|').map(part => part.trim());
      if (!title || !place || !text || extra !== undefined) throw Error(`About flow step: ${line}`);
      flow.steps.push({ title, place, text });
    } else if (line.startsWith('= ')) flow.pays = line.slice(2).trim();
    else if (line.trim()) {
      const [share, who, role, extra] = line.split('|').map(part => part.trim());
      if (!/^(?:\d+ %|rest)$/.test(share) || !who || !/^[a-z]+$/.test(role ?? '') || extra !== undefined) throw Error(`About flow share: ${line}`);
      flow.shares.push({ share, who, role });
    }
  }
  const fixed = flow.shares.filter(s => s.share !== 'rest').reduce((sum, s) => sum + Number.parseInt(s.share, 10), 0);
  for (const s of flow.shares) s.percent = s.share === 'rest' ? 100 - fixed : Number.parseInt(s.share, 10);
  if (!flow.title || flow.steps.length !== 6 || !flow.pays || flow.shares.filter(s => s.share === 'rest').length !== 1 || fixed >= 100)
    throw Error('About flow needs a title, six stages, a split heading and one remainder share');
  return flow;
}

function stageBox(step, n, x, y, w, height, chars) {
  const tag = step.place.toLowerCase().replace(/[^a-z]+/g, '-');
  return `<g class="fl-stage fl-${tag}"><rect class="fl-box" x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${height - 1}" rx="3"/>` +
    `<circle class="fl-n" cx="${x + 26}" cy="${y + 26}" r="11.25"/><text class="fl-nt" x="${x + 26}" y="${y + 30}">${n}</text>` +
    `<text class="fl-k" x="${x + 46}" y="${y + 30}">${escape(step.place)}</text>` +
    svgText(x + 14, y + 61, 'fl-t', [step.title]) + svgText(x + 14, y + 84, 'fl-b', wrap(step.text, chars)) + '</g>';
}
const stageHeight = (step, chars) => 98 + (wrap(step.text, chars).length - 1) * 18;

function splitBar(shares, x, y, w) {
  let at = x, out = '';
  for (const s of shares) {
    const width = w * s.percent / 100;
    out += `<rect class="fl-s fl-${s.role}" x="${at.toFixed(2)}" y="${y}" width="${width.toFixed(2)}" height="12"/>`;
    at += width;
  }
  return out + `<rect class="fl-bar" x="${x}" y="${y}" width="${w}" height="12" rx="2"/>`;
}
const swatch = (s, x, y) => `<rect class="fl-s fl-sw fl-${s.role}" x="${x}" y="${y - 10}" width="10" height="10" rx="2"/>`;

function wideFlow(flow) {
  const W = 816, gap = 36, w = 248, chars = 35, rowGap = 44, out = [];
  let y = 0;
  for (const row of [0, 1]) {
    const steps = flow.steps.slice(row * 3, row * 3 + 3), height = Math.max(...steps.map(s => stageHeight(s, chars)));
    steps.forEach((step, i) => {
      const x = i * (w + gap);
      out.push(stageBox(step, row * 3 + i + 1, x, y, w, height, chars));
      if (i < 2) out.push(`<path class="fl-a" d="M${x + w + 6} ${y + height / 2}H${x + w + gap - 6}"/>`, arrowHead(x + w + gap - 5, y + height / 2, 'right'));
    });
    const cx = 2 * (w + gap) + w / 2;
    if (row === 0) out.push(`<path class="fl-a" d="M${cx} ${y + height + 6}V${y + height + rowGap / 2}H${w / 2}V${y + height + rowGap - 6}"/>`, arrowHead(w / 2, y + height + rowGap - 5, 'down'));
    else out.push(`<path class="fl-a" d="M${cx} ${y + height + 6}V${y + height + rowGap - 6}"/>`, arrowHead(cx, y + height + rowGap - 5, 'down'));
    y += height + rowGap;
  }
  const col = (W - 28) / flow.shares.length, labels = flow.shares.map(s => wrap(s.who, 21));
  const height = 104 + (Math.max(...labels.map(l => l.length)) - 1) * 18;
  out.push(`<g class="fl-pays"><rect class="fl-box" x="0.5" y="${y + 0.5}" width="${W - 1}" height="${height - 1}" rx="3"/>`,
    svgText(14, y + 27, 'fl-t', [flow.pays]), splitBar(flow.shares, 14, y + 40, W - 28));
  flow.shares.forEach((s, i) => {
    const x = 14 + i * col;
    out.push(swatch(s, x, y + 79), svgText(x + 16, y + 79, 'fl-p', [`${s.percent} %`]), svgText(x, y + 98, 'fl-b', labels[i]));
  });
  out.push('</g>');
  return { width: W, height: y + height, body: out.join('') };
}

function narrowFlow(flow) {
  const W = 358, gap = 34, chars = 52, out = [];
  let y = 0;
  flow.steps.forEach((step, i) => {
    const height = stageHeight(step, chars);
    out.push(stageBox(step, i + 1, 0, y, W, height, chars),
      `<path class="fl-a" d="M26 ${y + height + 5}V${y + height + gap - 6}"/>`, arrowHead(26, y + height + gap - 5, 'down'));
    y += height + gap;
  });
  const rows = flow.shares.map(s => wrap(s.who, 40)), height = 70 + rows.reduce((sum, r) => sum + r.length * 18 + 6, 0);
  out.push(`<g class="fl-pays"><rect class="fl-box" x="0.5" y="${y + 0.5}" width="${W - 1}" height="${height - 1}" rx="3"/>`,
    svgText(14, y + 27, 'fl-t', [flow.pays]), splitBar(flow.shares, 14, y + 40, W - 28));
  let at = y + 78;
  flow.shares.forEach((s, i) => {
    out.push(swatch(s, 14, at), svgText(30, at, 'fl-p', [`${s.percent} %`]), svgText(78, at, 'fl-b', rows[i]));
    at += rows[i].length * 18 + 6;
  });
  out.push('</g>');
  return { width: W, height: y + height, body: out.join('') };
}

// Real text in both drawings; screen readers get the same content once, from the title and description.
function flowFigure(flow, id) {
  const desc = flow.steps.map((s, i) => `${i + 1}. ${s.title} (${s.place}): ${s.text}`).join(' ') +
    ` ${flow.pays}: ${flow.shares.map(s => `${s.who} ${s.percent} %`).join(', ')}.`;
  const svg = (layout, cls) => `<svg class="${cls}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="${id}-${cls}-t ${id}-${cls}-d">` +
    `<title id="${id}-${cls}-t">${escape(flow.title)}</title><desc id="${id}-${cls}-d">${escape(desc)}</desc>${layout.body}</svg>`;
  return `<figure class="about-flow" id="${id}">${svg(wideFlow(flow), 'fl-wide')}${svg(narrowFlow(flow), 'fl-narrow')}</figure>`;
}

export function renderMarkdown(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n'), html = [];
  const topics = lines.map(line => topicHeading.exec(line)).filter(m => m?.[1] === '##' && m[3]).map(m => ({ id: m[3], label: m[4] ?? m[2] }));
  if (new Set(topics.map(t => t.id)).size !== topics.length) throw Error('About topic ids repeat');
  let i = 0, heading = 0, labelledBy = '', flows = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const title = topicHeading.exec(lines[i]);
    if (title) {
      const level = title[1].length;
      if (title[3] && level !== 2) throw Error('Only ## headings name topics');
      labelledBy = title[3] ?? `about-heading-${heading}`;
      heading++;
      const tag = `<h${level} id="${labelledBy}">${inline(title[2])}</h${level}>`;
      html.push(level === 1 ? `<div class="page-head">${tag}</div>` : tag);
      i++; continue;
    }
    if (lines[i] === '[[topics]]') {
      if (!topics.length) throw Error('About topics need ## headings with ids');
      html.push(`<nav class="about-topics" aria-label="Topics on this page">${topics.map(t => `<a class="pill" href="#${t.id}">${escape(t.label)}</a>`).join('')}</nav>`);
      i++; continue;
    }
    if (lines[i].startsWith(':::flow ')) {
      const start = i;
      while (i < lines.length && lines[i] !== ':::') i++;
      if (i === lines.length) throw Error('About flow is not closed');
      html.push(flowFigure(parseFlow(lines.slice(start, i)), `about-flow-${flows++}`));
      i++; continue;
    }
    if (listItem.test(lines[i])) {
      const items = [];
      while (i < lines.length && listItem.test(lines[i])) {
        const [, n, text] = listItem.exec(lines[i++]);
        if (Number(n) !== items.length + 1) throw Error(`About list numbering near: ${text}`);
        items.push(`<li><span class="n" aria-hidden="true">${n}</span><div>${inline(text)}</div></li>`);
      }
      html.push(`<ol class="about-steps">${items.join('')}</ol>`);
      continue;
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
    while (i < lines.length && lines[i].trim() && !block(lines[i]) && !(lines[i].startsWith('|') && divider(lines[i + 1]))) {
      paragraph.push(lines[i++]);
    }
    html.push(`<p>${inline(paragraph.join('\n'))}</p>`);
  }
  const out = html.join('\n'), text = out.replace(/<[^>]*>/g, '');
  // Markdown syntax left in the visible text means the renderer missed it; fail the build.
  const raw = /\*\*|\]\(|`|\{\{|\{#|\[\[|:::/.exec(text);
  if (raw) throw Error(`About markdown left unrendered near: ${text.slice(Math.max(0, raw.index - 40), raw.index + 40)}`);
  return out;
}

export function buildAbout(markdown) {
  return `// Generated from content/about.md by scripts/build-about.mjs. Do not edit.
import { h, clear } from '../dom.js';
import { bus, store } from '../api.js';
import { feePrice, legacyDeployPolicyText, deployerSharePolicyText, tickerDeployPrice, tickerDeployBurnText } from '../money.js';
import { tickersOpen } from '../tickers.js';

const html = ${JSON.stringify(renderMarkdown(markdown))};
const topic = /^#[a-z][a-z0-9-]*$/;

export function mount(root) {
  const article = h('article.page.about', { html });
  clear(root, article);
  // Topic links scroll within the page; the page address keeps the topic, the console's view fragment stays.
  article.addEventListener('click', event => {
    const link = event.target.closest?.('a[href^="#"]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !topic.test(link.getAttribute('href'))) return;
    const section = article.querySelector(link.getAttribute('href'));
    if (!section) return;
    event.preventDefault();
    section.scrollIntoView({ block: 'start' });
    if (!location.hash.startsWith('#/')) history.replaceState(history.state, '', link.getAttribute('href'));
  });
  if (topic.test(location.hash)) requestAnimationFrame(() => article.querySelector(location.hash)?.scrollIntoView({ block: 'start' }));
  const prices = article.querySelectorAll('[data-fee-kind]');
  const update = status => {
    for (const price of prices) price.textContent = feePrice(status?.feePolicy, price.dataset.feeKind, Number(price.dataset.feeTier));
    for (const price of article.querySelectorAll('[data-ticker-fee]')) price.textContent = tickerDeployPrice(status);
    for (const share of article.querySelectorAll('[data-ticker-burn-share]')) share.textContent = tickerDeployBurnText(status);
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
