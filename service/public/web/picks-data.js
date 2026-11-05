// Editor's Picks: the picks file and the live state of each pick, as plain values the page draws.
// No imports, so the rules for what a card shows can be checked without a browser.
export const PICKS_URL = '/web/data/editors-picks.json';
const PATTERN = /^p2:(?:0|[1-9][0-9]*)$/, HEIGHT = /^(?:0|[1-9][0-9]*)$/;
const LIMITS = { picks: 40, points: 6, facts: 6, blocks: 8, stats: 8, related: 8 };

// Text the editor wrote, trimmed and bounded; anything else is left out.
function text(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
const list = (value, max, read) => (Array.isArray(value) ? value : []).map(read).filter(Boolean).slice(0, max);

// One pick as the page draws it. A pick needs a title or a name; an asset that is not a pattern is dropped,
// so the card shows its texts without links or live state.
export function readPick(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const asset = typeof raw.asset === 'string' && PATTERN.test(raw.asset.trim()) ? raw.asset.trim() : null;
  const name = text(raw.name, 40), title = text(raw.title, 140) || name;
  if (!title) return null;
  return {
    asset, name, title,
    emoji: text(raw.emoji, 8),
    tagline: text(raw.tagline, 200),
    utility: text(raw.utility, 120),
    why: text(raw.why, 1200),
    points: list(raw.points, LIMITS.points, p => {
      const point = typeof p === 'string' ? { lead: '', text: text(p, 400) } : { lead: text(p?.lead, 140), text: text(p?.text, 400) };
      return point.lead || point.text ? point : null;
    }),
    facts: list(raw.facts, LIMITS.facts, f => {
      const fact = { label: text(f?.label, 40), value: text(f?.value, 40) };
      return fact.label && fact.value ? fact : null;
    }),
    kind: raw.kind === 'meme' ? 'meme' : 'utility',
    // The editor's tier counts every matching block in Bitcoin's history; without it the page shows the live tier.
    tier: Number.isInteger(raw.tier) && raw.tier >= 1 && raw.tier <= 5 ? raw.tier : null,
    related: list(raw.related, LIMITS.related, r => {
      const asset = typeof r?.asset === 'string' && PATTERN.test(r.asset.trim()) ? r.asset.trim() : null;
      return asset ? { asset, name: text(r.name, 40) } : null;
    }).filter((r, i, all) => r.asset !== asset && all.findIndex(o => o.asset === r.asset) === i),
    blocks: [...new Set(list(raw.highlightBlocks, LIMITS.blocks, b => HEIGHT.test(String(b ?? '').trim()) ? String(b).trim() : null))],
  };
}
// The whole file: its intro, when it was updated, and the picks in the editor's order.
export function readPicks(raw) {
  const doc = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const updated = typeof doc.updated === 'string' && !Number.isNaN(Date.parse(doc.updated)) ? new Date(doc.updated).toISOString() : null;
  return { intro: text(doc.intro, 600), updated,
    stats: list(doc.stats, LIMITS.stats, f => {
      const stat = { label: text(f?.label, 40), value: text(f?.value, 40) };
      return stat.label && stat.value ? stat : null;
    }),
    statsNote: text(doc.statsNote, 300), tierNote: text(doc.tierNote, 300),
    picks: list(doc.picks, LIMITS.picks, readPick) };
}

// "about 7 days" for a number of Bitcoin blocks (about 10 minutes each).
export function roughTime(blocks) {
  if (!Number.isFinite(blocks) || blocks <= 0) return null;
  const minutes = blocks * 10;
  if (minutes < 55) return `about ${minutes} minutes`;
  if (minutes < 90) return 'about 1 hour';
  if (minutes < 22 * 60) return `about ${Math.round(minutes / 60)} hours`;
  const days = Math.round(minutes / 1440);
  return days === 1 ? 'about 1 day' : `about ${days} days`;
}
const heightText = s => Number(s).toLocaleString('en-US');
const left = (until, tip) => HEIGHT.test(String(until ?? '')) && HEIGHT.test(String(tip ?? '')) ? Number(until) - Number(tip) : null;

// The site's pill for each state: [label, kind].
export const NOW_PILLS = {
  token: { created: ['Token created', 'minted'], creating: ['Being created', 'info'], none: ['No token yet', 'warn'] },
  mint: { public: ['Public', 'good'], opens: ['Not public yet', ''], claimed: ['Claimed', ''], minted: ['Minted', ''], pending: ['Being minted', 'info'] },
};
// Untaken blocks: agents can still claim them (public ones as well, until someone mints them).
const UNTAKEN = new Set(['not_yet_public', 'public', 'claim_window_open', 'public_scan_pending']);

// What a card says right now. `token` is the site's token answer (step, deployer) or null/undefined;
// `block` the public-mint state of the pick's first highlighted block, or null/undefined; `tip` the counted height.
// Each part is null when its read failed or does not apply, and the card then leaves that line out.
export function pickNow({ asset, blocks = [] }, { token, block, tip } = {}) {
  if (!asset) return { token: null, mint: null, claim: null };
  const mintAll = '/mint?' + new URLSearchParams({ asset });
  let tokenLine = null;
  if (token && typeof token.step === 'string') {
    if (token.step === 'deployed') tokenLine = { state: 'created', text: 'Its token is created on Bitcoin.' };
    else if (['confirming', 'inflight'].includes(token.step)) tokenLine = { state: 'creating', text: 'Its token is being created: the inscription is waiting for Bitcoin to confirm it.' };
    else {
      const week = token.deployer?.onlyDiscoverer && HEIGHT.test(String(token.deployer.until ?? '')) ? token.deployer : null;
      const wait = week ? roughTime(left(week.until, tip)) : null;
      tokenLine = { state: 'none', who: week ? 'discoverer' : 'anyone', until: week?.until ?? null, href: '/mint/' + asset,
        text: (token.step === 'inscribed' ? 'The pattern is inscribed; its token is not created yet. ' : 'Its token is not created yet. ')
          + (week ? `Until block ${heightText(week.until)}${wait ? ` (${wait})` : ''} only its discoverer can create it. After that, anyone can.`
            : 'Anyone can create it now, once, from their own TAP Wallet, and keeps the deploy inscription.') };
    }
  }
  let mint = null, claim = null;
  const at = blocks[0];
  if (block && typeof block.state === 'string' && at !== undefined) {
    const one = '/mint?' + new URLSearchParams({ asset, block: at }), name = `Block ${heightText(at)}`;
    if (block.state === 'public') mint = { state: 'public', href: one, all: mintAll, text: `${name} is public: anyone can mint it now with TAP Wallet, no agent needed.` };
    else if (block.state === 'not_yet_public' && HEIGHT.test(String(block.publicFrom ?? ''))) {
      const wait = roughTime(left(block.publicFrom, tip));
      mint = { state: 'opens', href: mintAll, opensAt: block.publicFrom, text: `${name} opens for public minting at block ${heightText(block.publicFrom)}${wait ? ` (${wait})` : ''}, unless an agent claims it first.` };
    }
    else if (['claimed', 'finder'].includes(block.state)) mint = { state: 'claimed', href: mintAll, text: `${name} is claimed by an agent, so it is not public.` };
    else if (['already_minted', 'minted'].includes(block.state)) mint = { state: 'minted', href: mintAll, text: `${name} is already minted.` };
    else if (['paid', 'permit_issued', 'block_pending'].includes(block.state)) mint = { state: 'pending', href: mintAll, text: `${name} is being minted right now.` };
    if (UNTAKEN.has(block.state)) claim = { href: '/about#steps', text: 'Its untaken blocks can still be claimed by an agent. Claiming is free; the agent’s owner then mints the find.' };
  }
  if (at === undefined) mint = { state: null, href: mintAll, text: 'Its blocks become public once their 1-week finder window has passed. See which are public now.' };
  return { token: tokenLine, mint, claim, mintAll };
}
