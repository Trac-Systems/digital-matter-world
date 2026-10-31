import { get, store, site } from './api.js';
import { h, fmtInt, short, hashEl, nameAssets } from './dom.js';
import { tap } from './money.js';

// 24 mineral swatches: six hue groups x four values, none in the reserved Bitcoin orange band.
export const MINERALS = [
  '#2F7A5E', '#4FB28C', '#7CC9A9', '#B4E0CB',
  '#2E4F8F', '#4A72C8', '#7E9BDB', '#B5C6EC',
  '#7A2433', '#A83848', '#C9677A', '#E2A3AF',
  '#8A7330', '#B39A4C', '#CDB977', '#E4D7A8',
  '#5E4588', '#9A72C8', '#B79AD8', '#D7C6EA',
  '#8E8696', '#B5ACBF', '#D3CCDB', '#ECE6F2',
];
export function mineral(id) {
  let x = 2166136261;
  for (const c of String(id)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; }
  return MINERALS[x % MINERALS.length];
}
export const FIELDS = { 4: 'Height', 10: 'Nonce', 11: 'Difficulty bits' };
export function fieldName(p) { return p ? `${FIELDS[p.fld] ?? `Field ${p.fld}`}${p.fld === 11 ? (p.dt === 'h' ? ' (hex)' : ' (decimal)') : ''}${p.amountMode === 'field-value' ? ' · field value' : ''}` : '–'; }
export function title(name) {
  const n = String(name ?? '').replace(/^dmw(?=[a-z0-9]{2,29}$)/, '');
  return n ? n[0].toUpperCase() + n.slice(1) : '–';
}
export function symbol(pattern) {
  if (pattern && typeof pattern === 'object' && pattern.symbol !== undefined) return pattern.symbol;
  const t = title(pattern && typeof pattern === 'object' ? pattern.name : pattern);
  return t.length > 1 ? t[0] + t[1].toLowerCase() : t;
}
// A pattern or compound by its name, never its raw id: "Pattern #7" or "Compound #e9f0843e" until the name is known.
export function assetName(asset) {
  if (MERGED.has(asset)) return assetName(MERGED.get(asset));
  const p = store.pattern(asset);
  if (p) return title(p.name);
  if (patternNames.has(asset)) return patternNames.get(asset);
  if (/^p2:(0|[1-9][0-9]*)$/.test(asset ?? '')) return `Pattern #${asset.slice(3)}`;
  const c = store.compound(asset) ?? compounds.get(asset);
  if (c?.name && c.name !== c.id && c.name !== asset) return c.name.replace(/\bdmw([a-z0-9]{2,29})\b/g, (_, n) => title(n));
  if (c || /^c2:[0-9a-f]{64}$/.test(asset ?? '')) return compoundName(c ?? { id: asset });
  return asset ?? '–';
}
// Compound ids merged into their deterministic id at block 973829 (rules/src/compound-merge-manifest.js, which the
// pages cannot load): an old id is named and linked as the compound it became.
const MERGED = new Map([
  ['c2:1bafd6097265662a5da3cd6aecd4c1df945f866038ceb85151ee96ed6227e5d5', 'c2:e9f0843ea3da981ce457b38b35170e16e2448c9f93581c48c50c366013d34729'],
  ['c2:2b91a38746504080d048ec76ed4234f22ab8555bcda7daffa925869a6d62552f', 'c2:e9f0843ea3da981ce457b38b35170e16e2448c9f93581c48c50c366013d34729'],
]);
export const MERGED_COMPOUNDS = MERGED;
export const currentAsset = asset => MERGED.get(asset) ?? asset;
// Names not loaded yet come from one point read per asset (never the whole catalog).
const patternNames = new Map(), lookups = new Map();
export const ASSET_ID = /^(?:p2:(?:0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/;
const known = asset => { asset = currentAsset(asset); return !!(store.pattern(asset) || store.compound(asset) || patternNames.has(asset) || compounds.has(asset)); };
export function lookupName(asset) {
  asset = currentAsset(asset);
  if (!ASSET_ID.test(asset ?? '') || known(asset)) return Promise.resolve(assetName(asset));
  if (!lookups.has(asset)) {
    const kind = asset.startsWith('p2:') ? 'patterns' : 'compounds';
    lookups.set(asset, get(`/${kind}?asset=${encodeURIComponent(asset)}&limit=1`).then(async r => {
      const row = r?.[kind]?.[0];
      if (kind === 'patterns' && row?.name) { patternNames.set(asset, title(row.name)); if (patternNames.size > 500) patternNames.delete(patternNames.keys().next().value); }
      // A compound's name lists its first ingredients: their patterns are read the same way.
      if (kind === 'compounds' && row) { rememberCompound({ ...row, id: row.id ?? asset }); await Promise.all(compoundInputs(row).slice(0, 4).filter(i => i.asset.startsWith('p2:')).map(i => lookupName(i.asset))); }
      return assetName(asset);
    }, () => { lookups.delete(asset); return assetName(asset); }));
    if (lookups.size > 500) lookups.delete(lookups.keys().next().value);
  }
  return lookups.get(asset);
}
// Text that names assets (a compound by its ingredients); it is redrawn once their missing names arrive.
export function namedText(text, assets) {
  const named = assets.flatMap(a => [a, ...compoundInputs(store.compound(a) ?? compounds.get(a)).slice(0, 4).map(i => i.asset)]);
  const node = document.createTextNode(text()), missing = [...new Set(named)].filter(a => ASSET_ID.test(a ?? '') && !known(a));
  if (missing.length) Promise.all(missing.map(lookupName)).then(() => { node.textContent = text(); });
  return node;
}
// Complete references: every mention of a thing with its own page or public record is named in words and links
// there. Pages are the site's own (site.href); inscriptions, Bitcoin transactions and addresses open the mainnet
// explorers the pages already use, on the public pages only. Ethereum has no explorer page: its values stay copyable.
const EXTERNAL = { target: '_blank', rel: 'noreferrer noopener' };
export function assetHref(asset) {
  const id = currentAsset(asset);
  if (/^p(?:2:(?:0|[1-9][0-9]*)|[0-9a-z]{1,23})$/.test(id ?? '')) return site.href('table', { p: id });
  if (/^c(?:2:[0-9a-f]{64}|[0-9a-z]{1,23})$/.test(id ?? '')) return site.href('table', { c: id });
  return null;
}
export function assetLink(asset, label) {
  const href = assetHref(asset), text = label ?? namedText(() => assetName(asset), [asset]);
  return href ? h('a', { href }, text) : h('span', {}, text);
}
export const agentHref = address => /^trac1[0-9a-z]{20,}$/.test(address ?? '') ? site.href('agents', { a: address }) : null;
export function agentLink(address, label) {
  if (!address) return h('span.faint', {}, '–');
  const href = agentHref(address);
  return href ? h('a.mono', { href, title: address }, label ?? who(address)) : hashEl(address, label);
}
export const blockHref = height => height === null || height === undefined || height === '' ? null : site.href('world', { b: height });
export function blockLink(height, label) {
  const href = blockHref(height);
  return href ? h('a.mono', { href }, label ?? fmtInt(height)) : h('span.faint', {}, '–');
}
const explorer = path => site.public ? 'https://' + path : null;
export const inscriptionHref = id => /^[0-9a-f]{64}i[0-9]+$/.test(id ?? '') ? explorer('ordinals.com/inscription/' + id) : null;
export function inscriptionLink(id, label) {
  const href = inscriptionHref(id);
  return href ? h('a.mono', { href, title: id, ...EXTERNAL }, label ?? short(id, 8, 6)) : hashEl(id, label);
}
export function txLink(chain, txid, label) {
  const href = chain === 'bitcoin' && /^[0-9a-f]{64}$/.test(txid ?? '') ? explorer('mempool.space/tx/' + txid) : null;
  return href ? h('a.mono', { href, title: txid, ...EXTERNAL }, label ?? short(txid, 8, 6)) : hashEl(txid, label);
}
// An inscription a wallet has broadcast and the gateway has seen on Bitcoin, not yet confirmed and indexed.
// Every page shows it in these words, with its phase and the transaction linked.
export const INFLIGHT_TEXT = 'Inscription sent — waiting for Bitcoin confirmation';
export const INFLIGHT_PHASE = { element: 'Pattern inscription', deployment: 'Token deployment', mint: 'Mint', link: 'Bitmap link' };
export const inflightTxid = inflight => /^[0-9a-f]{64}$/.test(inflight?.revealTxid ?? '') ? inflight.revealTxid : null;
export function inflightLine(inflight, { asset } = {}) {
  const txid = inflightTxid(inflight); if (!txid) return null;
  const confirmations = Number.isSafeInteger(inflight.confirmations) && inflight.confirmations > 0 ? inflight.confirmations : 0;
  return h('span', {}, INFLIGHT_PHASE[inflight.phase] ?? 'Inscription', asset ? [' of ', assetLink(asset)] : null, ' · ', txLink('bitcoin', txid),
    confirmations ? ` · ${fmtInt(confirmations)} confirmation${confirmations === 1 ? '' : 's'}` : '');
}
export function inflightNote(inflight, { asset, detail } = {}) {
  return inflightTxid(inflight) ? h('div.callout.info', {}, h('strong', {}, INFLIGHT_TEXT), h('div.small', {}, inflightLine(inflight, { asset })), detail ? h('div.small', {}, detail) : null) : null;
}
// A wallet: its agent page for a Trac key, the Bitcoin explorer for a mainnet Bitcoin address.
export function addressLink(address, label) {
  if (agentHref(address)) return agentLink(address, label);
  const href = /^(?:bc1|[13])[0-9a-zA-Z]{20,}$/.test(address ?? '') ? explorer('mempool.space/address/' + address) : null;
  return href ? h('a.mono', { href, title: address, ...EXTERNAL }, label ?? short(address, 8, 6)) : hashEl(address, label);
}
// A request's own page on the public pages (mint, link and payout-binding requests).
export function requestLink(kind, id, label) {
  return site.public && /^[0-9a-f]{64}$/.test(id ?? '') ? h('a.mono', { href: `/${kind}/${id}`, title: id }, label ?? short(id, 8, 6)) : hashEl(id, label);
}
nameAssets(assetName, { asset: assetLink, address: addressLink, inscription: inscriptionLink });

// Sentences keep their plain text; while one is described its references are noted in order, so the rendered
// sentence links each named thing where its words appear.
let noting = null;
const note = (text, link) => { text = String(text); noting?.push({ text, link }); return text; };
const A = asset => note(assetName(asset), () => assetLink(asset, assetName(asset)));
const B = height => note(fmtInt(height), () => blockLink(height));
const W = address => note(who(address), () => agentLink(address));
const P = (text, asset) => note(text, () => assetHref(asset) ? h('a', { href: assetHref(asset) }, text) : text);
export function describeRefs(e) {
  const outer = noting, refs = noting = [];
  try { return { ...describe(e), refs }; } finally { noting = outer; }
}
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The text with each noted reference replaced by its link, matched in order as whole words.
export function linkedText(text, refs = []) {
  const out = [];
  let at = 0;
  for (const r of refs) {
    if (!r.text || r.text === '–') continue;
    const m = new RegExp(`(?<![0-9A-Za-z,.#])${escape(r.text)}(?![0-9A-Za-z]|[,.][0-9])`).exec(text.slice(at));
    if (!m) continue;
    if (m.index) out.push(text.slice(at, at + m.index));
    out.push(r.link()); at += m.index + r.text.length;
  }
  out.push(text.slice(at));
  return out;
}
// An event's sentence with links, redrawn once the names it uses arrive.
export function eventSentence(e, describeWith = describeRefs) {
  const el = h('span');
  const draw = () => { const d = describeWith(e); el.replaceChildren(...linkedText(d.text, d.refs)); };
  draw();
  const missing = [...new Set(eventAssets(e).flatMap(a => [a, ...compoundInputs(store.compound(currentAsset(a)) ?? compounds.get(currentAsset(a))).slice(0, 4).map(i => i.asset)]))]
    .filter(a => ASSET_ID.test(currentAsset(a) ?? '') && !known(a));
  if (missing.length) Promise.all(missing.map(lookupName)).then(draw);
  return el;
}
// The assets an event names.
export function eventAssets(e) {
  const d = e?.data ?? {}, r = d.result ?? {}, q = r.request ?? r;
  return [d.asset, d.id, d.request?.asset, q.asset, r.compound?.id ?? r.compound, ...(d.assets ?? r.assets ?? []).map(a => Array.isArray(a) ? a[0] : a?.asset)]
    .filter(a => typeof a === 'string');
}
// A compound is named by its recipe and ingredients ("Nullspar + Muffinite fusion"); its key is only a detail.
const compounds = new Map();
export function rememberCompound(c) {
  const id = c?.id ?? c?.asset;
  if (typeof id === 'string' && Array.isArray(c.inputs)) { compounds.delete(id); compounds.set(id, c); if (compounds.size > 500) compounds.delete(compounds.keys().next().value); }
  return c;
}
// v2 records list { asset, amount, properties }; older ones [asset, amount].
export const compoundInputs = c => (Array.isArray(c?.inputs) ? c.inputs : [])
  .map(i => Array.isArray(i) ? { asset: i[0], amount: String(i[1]) } : { asset: i?.asset, amount: String(i?.amount ?? '') }).filter(i => typeof i.asset === 'string');
export const compoundKey = id => { const s = String(id ?? ''); return s.startsWith('c2:') ? s.slice(3, 11) : short(s, 6, 3); };
export function compoundName(c, depth = 0) {
  const inputs = compoundInputs(c), id = c?.id ?? c?.asset;
  if (!inputs.length) return `Compound #${compoundKey(id)}`;
  const names = inputs.slice(0, 4).map(i => i.asset.startsWith('c') && depth < 1 && compounds.has(i.asset) ? compoundName(compounds.get(i.asset), depth + 1)
    : i.asset.startsWith('c') ? `Compound #${compoundKey(i.asset)}` : assetName(i.asset));
  return `${names.join(' + ')}${inputs.length > 4 ? ' + …' : ''} ${c.recipe === 'resonance' ? 'resonance' : 'fusion'}`;
}
// A v2 tier is { value, expression }.
export const tierOf = t => t?.value ?? t ?? null;
// Spectrum names the block header fields of the ingredients; generation counts crafting steps.
const SPECTRUM = [[1, 'block height'], [2, 'nonce'], [4, 'difficulty bits']];
export const spectrumText = n => Number.isSafeInteger(n) ? SPECTRUM.filter(([bit]) => n & bit).map(([, w]) => w).join(' + ') || '–' : '–';
export const generationText = g => g === undefined || g === null ? '–' : String(g) === '0' ? '0 · a pattern' : `${g} · crafted`;
export function assetKind(asset) { return store.pattern(asset) ? 'pattern' : store.compound(asset) ? 'compound' : 'asset'; }

const ME = () => store.player?.address ?? store.status?.player?.address;
export function who(key) {
  if (!key) return 'nobody';
  if (key === ME()) return 'You';
  const bot = store.bots?.find(b => b.address === key);
  return bot ? bot.name : short(key, 6, 4);
}
export const isMe = key => key && key === ME();

// The rule for who may mint block B for pattern X, in plain words.
export function mintRule(r, counted) {
  // `whoMayMint` names the rule (finder, bitmap, public, holder); `reason` adds minted, pending, insufficient_balance.
  const who = String(r.whoMayMint ?? '').toLowerCase(), reason = String(r.reason ?? r.role ?? '').replace(/^mint_/, '');
  if (r.minted || reason === 'minted') return { label: 'Minted', kind: 'minted', text: 'Already minted on Bitcoin. TAP allows one mint per block per pattern.' };
  if (r.pending || reason === 'pending') return { label: 'Mint in progress', kind: 'warn', text: 'A mint request holds this block until it completes or expires.' };
  if (reason === 'insufficient_balance' || reason === 'balance' || reason === 'insufficient') return { label: 'Not enough units', kind: 'bad', text: 'Minting uses exactly this block\'s match count of units from your balance.' };
  if (reason === 'holder_unavailable') return { label: 'Holder unknown', kind: 'warn', text: 'The linked Bitmap\'s current holder could not be read right now.' };
  const rule = who || reason;
  if (rule === 'finder' || (!who && r.finderUntil && counted !== undefined && counted < r.finderUntil)) {
    const left = r.finderUntil && counted !== undefined ? r.finderUntil - counted : null;
    return { label: r.allowed ? 'You, as finder' : 'Finder only', kind: r.allowed ? 'good' : 'info',
      text: `Only the finder may mint until block ${fmtInt(r.finderUntil)}${left !== null && left > 0 ? ` (${fmtInt(left)} blocks left)` : ''}. Afterwards any agent with enough units can mint. Bitmap holders earn 15% of every mint on their plot.` };
  }
  if (rule === 'bitmap' || rule === 'landowner') {
    return { label: r.allowed ? 'Eligible' : 'Mint unavailable', kind: r.allowed ? 'good' : 'info',
      text: 'This request uses an earlier mint policy. Refresh its quote to check availability.' };
  }
  if (rule === 'holder') return { label: r.allowed ? 'You hold units' : 'Holders of units', kind: r.allowed ? 'good' : '', text: 'Compounds are minted by whoever holds their units, in any amount.' };
  if (rule === 'public' || rule === 'anyone' || rule === '') {
    return { label: 'Anyone', kind: r.allowed ? 'good' : '', text: 'The finder window is over. Any agent with enough units may mint it. Bitmap holders earn 15% of every mint on their plot.' };
  }
  return { label: r.allowed ? 'You may mint' : rule.replace(/_/g, ' '), kind: r.allowed ? 'good' : '', text: rule ? `Rule: ${rule.replace(/_/g, ' ')}.` : '' };
}

const JOB_NAMES = {
  mine: 'Mine blocks', mining: 'Auto-mine', 'time-travel': 'Time travel', reorg: 'Reorg', fee: 'Change base fee', bots: 'Bot settings',
  header: 'Send header', claim: 'Claim', 'discovery-commit': 'Discovery commit', 'discovery-reveal': 'Discovery reveal', commit: 'Discovery commit', reveal: 'Discovery reveal',
  craft: 'Craft', transfer: 'Transfer',
  'mint-quote': 'Mint quote', mint: 'Mint request', 'compound-mint': 'Compound mint', pay: 'Payment', bitmap: 'Inscribe Bitmap', link: 'Bitmap link',
};
export function jobName(t) {
  const k = String(t ?? 'job').replace(/^\/?(api\/)?player[-.:/]/, '').replace(/^\//, '').replace(/[/.:]/g, '-');
  return JOB_NAMES[t] ?? JOB_NAMES[k] ?? k.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());
}

export const PAYMENT_STATE = { requested: 'requested', reserving: 'reserving matter', enrolling: 'preparing payment', awaiting_payment: 'waiting for wallet payment', partly_paid: 'partly paid', waiting_payment: 'waiting for payment', paid: 'Payment confirmed', permit_issued: 'Being minted', minted: 'Minted', already_minted: 'Minted', public: 'Public', claimed: 'Claimed', complete: 'done', expired: 'expired, units returned', refunded: 'refunded', cancelled: 'cancelled', failed: 'failed' };
// One feed line per event: actor, sentence, block.
export function actorName(d) {
  const key = d.actor ?? d.agent ?? d.owner ?? d.address;
  if (key && isMe(key)) return 'You';
  if (d.name === 'owner') return 'You';
  const bot = store.bots?.find(b => b.address === key || b.name === d.name);
  if (bot) return `${bot.name} · ${bot.strategy}`;
  if (d.name) return d.strategy ? `${d.name} · ${d.strategy}` : d.name;
  return key ? short(key, 6, 4) : 'World';
}
export function describe(e) {
  const d = e.data ?? {};
  let block = d.height ?? d.block ?? d.tip ?? d.result?.tip ?? d.result?.block ?? d.result?.receipt?.tip ?? null;
  let actor = e.type === 'block' || e.type === 'component' ? 'World' : e.type === 'job' ? (/^player\//.test(d.type ?? '') ? 'You' : 'Lab') : actorName(d);
  let text;
  switch (e.type) {
    case 'block': {
      const list = a => a.slice(0, 6).map(fmtInt).join(', ') + (a.length > 6 ? ` +${a.length - 6}` : '');
      if (d.reorg || d.depth) text = `Reorg of ${d.depth ?? ''} block${d.depth === 1 ? '' : 's'}: new tip ${B(block)}`;
      else text = `Block ${B(block)} mined${d.counted !== undefined ? ` · counted ${fmtInt(d.counted)}` : ''}`;
      break;
    }
    case 'job': {
      const name = jobName(d.type);
      text = d.state === 'complete' ? `${name} done` : d.state === 'failed' ? `${name} failed: ${plainError(d.error)}` : `${name} ${d.state ?? ''}`;
      if (d.state === 'complete' && d.result?.mined !== undefined) text += ` · ${fmtInt(d.result.mined)} block${d.result.mined === 1 ? '' : 's'}, tip ${B(d.result.tip)}`;
      if (d.state === 'complete' && d.result?.newHash) text += ` · ${fmtInt(d.result.depth)} replaced`;
      break;
    }
    case 'payment': {
      const r = d.request ?? d, asset = d.asset ?? r.asset;
      const what = asset ? `${A(asset)}${(d.block ?? r.block) !== undefined && (d.block ?? r.block) !== null ? ` from block ${B(d.block ?? r.block)}` : ''}` : 'a request';
      text = `Mint of ${what}: ${PAYMENT_STATE[r.state ?? d.state] ?? String(r.state ?? d.state ?? '').replace(/_/g, ' ')}${(r.kind ?? d.kind) ? ` · ${(r.kind ?? d.kind) === 'ethereum' ? 'bridged TAP escrow' : 'direct TAP payment'}` : ''}`;
      block = d.block ?? r.block ?? null;
      actor = 'Mint';
      break;
    }
    case 'draw': {
      const list = d.settlements ?? [];
      const winners = list.reduce((n, x) => n + (x.total ?? x.winners?.length ?? 0), 0), claims = list.reduce((n, x) => n + (x.claims ?? 0), 0);
      const blocks = [...new Set(list.flatMap(x => (x.winners ?? []).map(w => w.block)))];
      text = list.some(x => x.void) ? `Draw void after a reorg` : list.some(x => x.complete === false) ? 'Draw credits are continuing in the next batch' : `Draw settled: ${winners} find${winners === 1 ? '' : 's'} · ${list.reduce((n, x) => n + (x.headerFinds ?? (x.winners ?? []).filter(w => w.source === 'header').length), 0)} header finds · ${claims} claim${claims === 1 ? '' : 's'}${blocks.length ? ` · plots ${blocks.slice(0, 4).map(B).join(', ')}${blocks.length > 4 ? '…' : ''}` : ''}`;
      actor = 'World';
      break;
    }
    case 'discovery': {
      if (d.state === 'revealed') { actor = actorName({ actor: d.agent }); text = `revealed a pattern proposal: ${title(d.name)} (being checked)`; break; }
      if (d.state === 'accepted') { actor = actorName({ actor: d.agent ?? d.discoverer }); text = `discovered ${P(title(d.name), d.asset)}: tier ${d.tier}, ${fmtInt(d.rarity ?? store.pattern(d.asset)?.rarity ?? d.knownMatchCount)} blocks`; block ??= d.anchor?.height ?? null; break; }
      const recs = (d.discoveries ?? []).map(x => x.record ?? x);
      text = recs.length ? recs.map(r => `New pattern accepted: ${P(title(r.name), r.asset)} (tier ${r.tier}, ${fmtInt(r.rarity ?? store.pattern(r.asset)?.rarity ?? r.knownMatchCount)} blocks) by ${W(r.discoverer)}`).join('; ') : 'Discovery round closed';
      actor = 'World';
      break;
    }
    case 'claim': {
      actor = actorName({ actor: d.agent });
      const n = (d.patterns ?? []).length;
      text = `claimed ${n ? `${n} pattern${n === 1 ? '' : 's'}` : 'a find'} in block ${B(d.block)}${d.header ? ' (header sent)' : ''}`;
      block = d.block ?? block; break;
    }
    case 'header_find': actor = actorName({ actor: d.finder ?? d.winner }); text = `header find: received ${fmtInt(d.count ?? d.amount)} ${A(d.asset)} in block ${B(d.block)} for sending its header`; block = d.block ?? block; break;
    case 'find': actor = actorName({ actor: d.finder ?? d.winner }); text = `won ${fmtInt(d.count ?? d.amount)} ${A(d.asset)} in block ${B(d.block)}`; block = d.block ?? block; break;
    case 'craft': actor = actorName({ actor: d.owner ?? d.firstMaker }); text = `crafted ${d.amount ? `${fmtInt(d.amount)} ` : ''}${A(d.id ?? d.asset)}`; break;
    case 'mint_request': actor = actorName({ actor: d.owner }); text = `asked to mint ${fmtInt(d.amount)} ${A(d.asset)}${d.block !== undefined ? ` from block ${B(d.block)}` : ''}`; block = d.block ?? block; break;
    case 'mint_permit': actor = actorName({ actor: d.owner }); text = `received a permanent permit to mint ${fmtInt(d.amount)} ${A(d.asset)}${d.block !== undefined ? ` from block ${B(d.block)}` : ''}`; block = d.block ?? block; break;
    case 'mint_complete': actor = actorName({ actor: d.owner }); text = `minted ${fmtInt(d.amount)} ${A(d.asset)}${d.block !== undefined ? ` from block ${B(d.block)}` : ''} on Bitcoin`; block = d.block ?? block; break;
    case 'link': actor = actorName({ actor: d.owner }); text = `linked the Bitmap of block ${B(d.block)}`; block = d.block ?? block; break;
    case 'transfer': {
      actor = actorName({ actor: d.from });
      const what = (d.assets ?? []).slice(0, 3).map(([a, n]) => `${fmtInt(n)} ${A(a)}`).join(', ');
      text = `sent ${what || 'matter'} to ${W(d.to)}`; break;
    }
    case 'receipts': text = `Gateway sealed ${fmtInt(d.count)} move${d.count === 1 ? '' : 's'} at tip ${B(d.tip)}`; actor = 'World'; block = d.tip ?? block; break;
    case 'component': text = d.name ? `${d.name} is ${d.state ?? 'changed'}` : d.phase ? `Playground: ${d.phase}` : d.state ? `Playground ${d.state}` : 'System update'; break;
    case 'error': text = plainError(d.message ?? d.error ?? 'error'); break;
    default:
      // Money steps (financial_<action>): only link-complete (type 'link') means a Bitmap is linked.
      if (e.type.startsWith('financial_')) { text = moneyStep(d); block = d.block ?? block; break; }
      if (d.error) { text = `${d.state ? `${String(d.state).replace(/_/g, ' ')}: ` : ''}${plainError(d.error)}`; break; }
      text = sentence(d) ?? (d.action ? String(d.action).replace(/[/_-]/g, ' ') : e.type);
  }
  return { actor, text, block };
}
function moneyStep(d) {
  const block = () => B(d.block), what = d.asset ? `${d.amount ? `${fmtInt(d.amount)} ` : ''}${A(d.asset)}` : null, from = d.block !== undefined ? ` from block ${block()}` : '';
  const bitmap = `the Bitmap of block ${block()}`;
  const steps = {
    reserve: () => `asked to mint ${what ?? 'matter'}${from}; awaiting payment`,
    fund: () => `paid the fees to mint ${what ?? 'matter'}${from}`,
    surplus: () => `paid more than needed${from}; the extra is refunded`,
    consume: () => `payment final: permit to mint ${what ?? 'matter'}${from}`,
    refund: () => `request${from} ended; payment refunded`,
    'link-reserve': () => `asked to link ${bitmap}; awaiting payment`,
    'link-exit': () => `link request for ${bitmap} ended without a link`,
    'legacy-link-exit': () => `link request for ${bitmap} ended without a link`,
    'legacy-link-complete': () => `linked ${bitmap}`,
    'deployment-open': () => `deployed the ${what ?? 'pattern'} token`,
  };
  const f = steps[d.action];
  return f ? f().replace(/\s+/g, ' ').trim() : String(d.action ?? 'payment step').replace(/[/_-]/g, ' ');
}
function sentence(d) {
  const a = String(d.action ?? d.kind ?? '').toLowerCase().replace(/[/_.:]/g, '-');
  const r = d.result ?? {}, q = r.request ?? r;
  const asset = d.asset ?? q.asset ? A(d.asset ?? q.asset) : null;
  const at = d.block ?? q.block ?? d.height;
  const tip = r.receipt?.tip;
  const plural = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;
  const things = list => (list ?? []).map(([x, n]) => `${fmtInt(n)} ${A(x)}`).join(', ');
  const map = {
    header: () => `sent the header for block ${B(tip ?? at)}`,
    claim: () => d.plots?.length ? `claimed in ${plural(d.plots.length, 'plot')}` : `claimed finds${tip !== undefined ? ` at tip ${B(tip)}` : ''}`,
    find: () => `won ${fmtInt(d.amount ?? d.count)} ${asset ?? ''} in block ${B(at)}`,
    'discovery-commit': () => 'committed a hidden pattern discovery',
    'discovery-reveal': () => `revealed a pattern discovery${d.name && d.name !== 'owner' && !/^bot/.test(d.name) ? `: ${title(d.name)}` : ''}`,
    craft: () => `crafted ${r.compound ? A(r.compound.id ?? r.compound) : 'a compound'}`,
    transfer: () => `sent ${things(d.assets ?? r.assets) || 'matter'}${(d.to ?? r.to) ? ` to ${W(d.to ?? r.to)}` : ''} on Trac`,
    'mint-quote': () => `asked for the fee to mint ${asset ?? ''} from block ${B(at)}${r.price ? `: ${tap(r.price, r.unit)}` : ''}`,
    mint: () => `asked to mint ${asset ?? 'matter'}${at !== undefined ? ` from block ${B(at)}` : ''}`,
    'compound-mint': () => `asked to mint ${asset ?? 'a compound'} on-chain`,
    pay: () => q.inscription ? `paid and minted on Bitcoin${asset ? `: ${asset}` : ''}` : `paid ${q.price ? tap(q.price, q.unit) : ''}`.trim(),
    bitmap: () => `inscribed a test Bitmap for block ${B(d.height ?? at)}`,
    link: () => `linked the Bitmap of block ${B(d.height ?? at)}`,
  };
  const f = map[a] ?? Object.entries(map).find(([k]) => a.startsWith(k))?.[1];
  return f ? f().replace(/\s+/g, ' ').trim() : d.message ?? d.text ?? null;
}
export function plainError(e) {
  const s = String(e?.message ?? e ?? 'error');
  const known = {
    mint_finder: 'only the finder may mint this block during the finder window',
    mint_bitmap: 'this request uses an earlier mint policy; refresh its quote',
    mint_balance: 'not enough units in your balance',
    already_minted: 'this block is already minted for this pattern',
    block_pending: 'another mint request holds this block right now',
    mint_no_find: 'this block needs a find before it can be minted',
    mint_no_match: 'this pattern does not occur in this block',
    unauthorized: 'the access token was refused',
  };
  return known[s] ?? s.replace(/_/g, ' ');
}
