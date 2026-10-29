import { store } from './api.js';
import { fmtInt, short } from './dom.js';
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
export function fieldName(p) { return p ? `${FIELDS[p.fld] ?? `Field ${p.fld}`}${p.fld === 11 ? (p.dt === 'h' ? ' (hex)' : ' (decimal)') : ''}` : '–'; }
export function title(name) {
  const n = String(name ?? '').replace(/^dmw/, '');
  return n ? n[0].toUpperCase() + n.slice(1) : '–';
}
export function symbol(name) { const t = title(name); return t.length > 1 ? t[0] + t[1].toLowerCase() : t; }
export function assetName(asset) {
  const p = store.pattern(asset);
  if (p) return title(p.name);
  const c = store.compound(asset);
  if (c) return c.name && c.name !== c.id ? c.name.replace(/\bdmw([a-z0-9]+)/g, (_, n) => title(n)) : `Compound ${short(asset, 6, 3)}`;
  return asset ?? '–';
}
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
      text: `Only the finder may mint until block ${fmtInt(r.finderUntil)}${left !== null && left > 0 ? ` (${fmtInt(left)} blocks left)` : ''}. After that, the Bitmap holder if the Bitmap was linked before the find, otherwise anyone.` };
  }
  if (rule === 'bitmap' || rule === 'landowner') {
    return { label: r.allowed ? 'You, as Bitmap holder' : 'Bitmap holder only', kind: r.allowed ? 'good' : 'info',
      text: 'The Bitmap was linked before the find, so only whoever holds that Bitmap now may mint it. No time limit.' };
  }
  if (rule === 'holder') return { label: r.allowed ? 'You hold units' : 'Holders of units', kind: r.allowed ? 'good' : '', text: 'Compounds are minted by whoever holds their units, in any amount.' };
  if (rule === 'public' || rule === 'anyone' || rule === '') {
    return { label: 'Anyone', kind: r.allowed ? 'good' : '', text: 'The finder window is over and no earlier Bitmap link exists, so anyone holding enough units may mint it.' };
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

export const PAYMENT_STATE = { requested: 'requested', reserving: 'reserving matter', enrolling: 'preparing payment', awaiting_payment: 'waiting for wallet payment', partly_paid: 'partly paid', waiting_payment: 'waiting for payment', paid: 'payment confirmed', permit_issued: 'permit ready for your wallet to inscribe', minted: 'minted on Bitcoin', complete: 'done', expired: 'expired, units returned', refunded: 'refunded', cancelled: 'cancelled', failed: 'failed' };
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
      if (d.reorg || d.depth) text = `Reorg of ${d.depth ?? ''} block${d.depth === 1 ? '' : 's'}: new tip ${fmtInt(block)}`;
      else text = `Block ${fmtInt(block)} mined${d.counted !== undefined ? ` · counted ${fmtInt(d.counted)}` : ''}`;
      break;
    }
    case 'job': {
      const name = jobName(d.type);
      text = d.state === 'complete' ? `${name} done` : d.state === 'failed' ? `${name} failed: ${plainError(d.error)}` : `${name} ${d.state ?? ''}`;
      if (d.state === 'complete' && d.result?.mined !== undefined) text += ` · ${fmtInt(d.result.mined)} block${d.result.mined === 1 ? '' : 's'}, tip ${fmtInt(d.result.tip)}`;
      if (d.state === 'complete' && d.result?.newHash) text += ` · ${fmtInt(d.result.depth)} replaced`;
      break;
    }
    case 'payment': {
      const r = d.request ?? d, asset = d.asset ?? r.asset;
      const what = asset ? `${assetName(asset)}${(d.block ?? r.block) !== undefined && (d.block ?? r.block) !== null ? ` from block ${fmtInt(d.block ?? r.block)}` : ''}` : 'a request';
      text = `Mint of ${what}: ${PAYMENT_STATE[r.state ?? d.state] ?? String(r.state ?? d.state ?? '').replace(/_/g, ' ')}${(r.kind ?? d.kind) ? ` · ${(r.kind ?? d.kind) === 'ethereum' ? 'bridged TAP escrow' : 'direct TAP payment'}` : ''}`;
      block = d.block ?? r.block ?? null;
      actor = 'Mint';
      break;
    }
    case 'draw': {
      const list = d.settlements ?? [];
      const winners = list.reduce((n, x) => n + (x.total ?? x.winners?.length ?? 0), 0), claims = list.reduce((n, x) => n + (x.claims ?? 0), 0);
      const blocks = [...new Set(list.flatMap(x => (x.winners ?? []).map(w => w.block)))];
      text = list.some(x => x.void) ? `Draw void after a reorg` : list.some(x => x.complete === false) ? 'Draw credits are continuing in the next batch' : `Draw settled: ${winners} find${winners === 1 ? '' : 's'} · ${list.reduce((n, x) => n + (x.headerFinds ?? (x.winners ?? []).filter(w => w.source === 'header').length), 0)} header finds · ${claims} claim${claims === 1 ? '' : 's'}${blocks.length ? ` · plots ${blocks.slice(0, 4).map(fmtInt).join(', ')}${blocks.length > 4 ? '…' : ''}` : ''}`;
      actor = 'World';
      break;
    }
    case 'discovery': {
      if (d.state === 'revealed') { actor = actorName({ actor: d.agent }); text = `revealed a pattern proposal: ${title(d.name)} (being checked)`; break; }
      if (d.state === 'accepted') { actor = actorName({ actor: d.agent ?? d.discoverer }); text = `discovered ${title(d.name)}: tier ${d.tier}, ${fmtInt(d.rarity)} blocks`; break; }
      const recs = (d.discoveries ?? []).map(x => x.record ?? x);
      text = recs.length ? recs.map(r => `New pattern accepted: ${title(r.name)} (tier ${r.tier}, ${fmtInt(r.rarity)} blocks) by ${who(r.discoverer)}`).join('; ') : 'Discovery round closed';
      actor = 'World';
      break;
    }
    case 'claim': {
      actor = actorName({ actor: d.agent });
      const n = (d.patterns ?? []).length;
      text = `claimed ${n ? `${n} pattern${n === 1 ? '' : 's'}` : 'a find'} in block ${fmtInt(d.block)}${d.header ? ' (header sent)' : ''}`;
      block = d.block ?? block; break;
    }
    case 'header_find': actor = actorName({ actor: d.finder ?? d.winner }); text = `header find: received ${fmtInt(d.count ?? d.amount)} ${assetName(d.asset)} in block ${fmtInt(d.block)} for sending its header`; block = d.block ?? block; break;
    case 'find': actor = actorName({ actor: d.finder ?? d.winner }); text = `won ${fmtInt(d.count ?? d.amount)} ${assetName(d.asset)} in block ${fmtInt(d.block)}`; block = d.block ?? block; break;
    case 'craft': actor = actorName({ actor: d.owner ?? d.firstMaker }); text = `crafted ${d.amount ? `${fmtInt(d.amount)} ` : ''}${assetName(d.id ?? d.asset)}`; break;
    case 'mint_request': actor = actorName({ actor: d.owner }); text = `asked to mint ${fmtInt(d.amount)} ${assetName(d.asset)}${d.block !== undefined ? ` from block ${fmtInt(d.block)}` : ''}`; block = d.block ?? block; break;
    case 'mint_permit': actor = actorName({ actor: d.owner }); text = `received a permanent permit to mint ${fmtInt(d.amount)} ${assetName(d.asset)}${d.block !== undefined ? ` from block ${fmtInt(d.block)}` : ''}`; block = d.block ?? block; break;
    case 'mint_complete': actor = actorName({ actor: d.owner }); text = `minted ${fmtInt(d.amount)} ${assetName(d.asset)}${d.block !== undefined ? ` from block ${fmtInt(d.block)}` : ''} on Bitcoin`; block = d.block ?? block; break;
    case 'link': actor = actorName({ actor: d.owner }); text = `linked the Bitmap of block ${fmtInt(d.block)}`; block = d.block ?? block; break;
    case 'transfer': {
      actor = actorName({ actor: d.from });
      const what = (d.assets ?? []).slice(0, 3).map(([a, n]) => `${fmtInt(n)} ${assetName(a)}`).join(', ');
      text = `sent ${what || 'matter'} to ${who(d.to)}`; break;
    }
    case 'receipts': text = `Gateway sealed ${fmtInt(d.count)} move${d.count === 1 ? '' : 's'} at tip ${fmtInt(d.tip)}`; actor = 'World'; block = d.tip ?? block; break;
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
  const what = d.asset ? `${d.amount ? `${fmtInt(d.amount)} ` : ''}${assetName(d.asset)}` : null, from = d.block !== undefined ? ` from block ${fmtInt(d.block)}` : '';
  const bitmap = `the Bitmap of block ${fmtInt(d.block)}`;
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
  const asset = d.asset ?? q.asset ? assetName(d.asset ?? q.asset) : null;
  const at = d.block ?? q.block ?? d.height;
  const tip = r.receipt?.tip;
  const plural = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;
  const things = list => (list ?? []).map(([x, n]) => `${fmtInt(n)} ${assetName(x)}`).join(', ');
  const map = {
    header: () => `sent the header for block ${fmtInt(tip ?? at)}`,
    claim: () => d.plots?.length ? `claimed in ${plural(d.plots.length, 'plot')}` : `claimed finds${tip !== undefined ? ` at tip ${fmtInt(tip)}` : ''}`,
    find: () => `won ${fmtInt(d.amount ?? d.count)} ${asset ?? ''} in block ${fmtInt(at)}`,
    'discovery-commit': () => 'committed a hidden pattern discovery',
    'discovery-reveal': () => `revealed a pattern discovery${d.name && d.name !== 'owner' && !/^bot/.test(d.name) ? `: ${title(d.name)}` : ''}`,
    craft: () => `crafted ${r.compound ? assetName(r.compound.id ?? r.compound) : 'a compound'}`,
    transfer: () => `sent ${things(d.assets ?? r.assets) || 'matter'}${(d.to ?? r.to) ? ` to ${who(d.to ?? r.to)}` : ''} on Trac`,
    'mint-quote': () => `asked for the fee to mint ${asset ?? ''} from block ${fmtInt(at)}${r.price ? `: ${tap(r.price, r.unit)}` : ''}`,
    mint: () => `asked to mint ${asset ?? 'matter'}${at !== undefined ? ` from block ${fmtInt(at)}` : ''}`,
    'compound-mint': () => `asked to mint ${asset ?? 'a compound'} on-chain`,
    pay: () => q.inscription ? `paid and minted on Bitcoin${asset ? `: ${asset}` : ''}` : `paid ${q.price ? tap(q.price, q.unit) : ''}`.trim(),
    bitmap: () => `inscribed a test Bitmap for block ${fmtInt(d.height ?? at)}`,
    link: () => `linked the Bitmap of block ${fmtInt(d.height ?? at)}`,
  };
  const f = map[a] ?? Object.entries(map).find(([k]) => a.startsWith(k))?.[1];
  return f ? f().replace(/\s+/g, ' ').trim() : d.message ?? d.text ?? null;
}
export function plainError(e) {
  const s = String(e?.message ?? e ?? 'error');
  const known = {
    mint_finder: 'only the finder may mint this block during the finder window',
    mint_bitmap: 'only the linked Bitmap\'s holder may mint this block',
    mint_balance: 'not enough units in your balance',
    already_minted: 'this block is already minted for this pattern',
    block_pending: 'another mint request holds this block right now',
    mint_no_find: 'this block needs a find before it can be minted',
    mint_no_match: 'this pattern does not occur in this block',
    unauthorized: 'the access token was refused',
  };
  return known[s] ?? s.replace(/_/g, ' ');
}
