import { store } from './api.js';
import { h, fmtAmount, table, hashEl } from './dom.js';
import { formatTap } from './amount-format.js';

// TAP fee amounts and balances are atomic strings. The unit comes from the response's `unit` metadata or
// `status.units.tap`; 18 decimals when neither is given. Formatting is string/BigInt only.
export const TAP_DEFAULT_DECIMALS = 18;
export function tapDecimals(unit) {
  if (Number.isInteger(unit?.decimals)) return unit.decimals;
  const stated = store.status?.units?.tap ?? store.status?.feePolicy?.unit?.decimals;
  return Number.isInteger(stated) ? stated : TAP_DEFAULT_DECIMALS;
}
// At most 12 significant digits and 8 fractional ones (cut, not rounded); exact values stay in Inspect.
function shown(v, d) {
  const digits = String(v).replace(/^0+/, '').length, whole = Math.max(1, digits - d);
  return fmtAmount(v, d, Math.max(0, Math.min(8, 12 - whole)));
}
export function tap(v, unit) {
  return formatTap(v, tapDecimals(unit));
}
// Display the current operator policy, with the same integer math as rules feeFor.
// Missing settings must never fall back to legacy or launch prices.
export function feePrice(policy, kind, tier = 1) {
  // v2 sends integers as decimal strings ("4").
  if (typeof tier === 'string' && /^[1-5]$/.test(tier)) tier = Number(tier);
  const settings = policy?.feeSettings;
  if (typeof policy?.baseFee !== 'string' || !/^(0|[1-9]\d*)$/.test(policy.baseFee) ||
      !Array.isArray(settings?.tierMultipliers) || settings.tierMultipliers.length !== 5 ||
      ![...settings.tierMultipliers, settings.compoundMinimum, settings.link].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Number.isInteger(tier) || tier < 1 || tier > 5) return 'current fee';
  let multiplier;
  if (kind === 'find') multiplier = settings.tierMultipliers[tier - 1];
  else if (kind === 'compound') multiplier = Math.max(settings.compoundMinimum, settings.tierMultipliers[tier - 1]);
  else if (kind === 'compound-minimum') multiplier = Math.max(settings.compoundMinimum, Math.min(...settings.tierMultipliers));
  else if (kind === 'link') multiplier = settings.link;
  else return 'current fee';
  return tap((BigInt(policy.baseFee) * BigInt(multiplier)).toString(), policy.unit);
}
export function feePolicyTip(policy) {
  const s = policy?.feeSettings;
  if (s?.tierMultipliers?.length === 5 && s.tierMultipliers.every(n => n === 1) && s.compoundMinimum === 1 && s.link === 1)
    return `Changes apply to new quotes. Every pattern and compound mint: ${feePrice(policy, 'find')}; Bitmap link: ${feePrice(policy, 'link')}. Fixed in TAP; network fees are separate.`;
  const tiers = Array.from({ length: 5 }, (_, i) => feePrice(policy, 'find', i + 1)).join(', ');
  return `Changes apply to new quotes. Link: ${feePrice(policy, 'link')}; tiers: ${tiers}; compounds from: ${feePrice(policy, 'compound-minimum')}.`;
}
// Decimal TAP text (for example "22.6") from atoms, without grouping, for editable fields.
export function tapText(v, unit) {
  const d = tapDecimals(unit), s = String(v ?? '');
  if (!/^\d+$/.test(s)) return '';
  if (!d) return s;
  const p = s.padStart(d + 1, '0'), frac = p.slice(-d).replace(/0+$/, '');
  return p.slice(0, -d) + (frac ? `.${frac}` : '');
}
// Atoms from decimal TAP text; null when the text is not a valid amount for the unit.
export function tapAtoms(text, unit) {
  const d = tapDecimals(unit), m = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m || (m[2] ?? '').length > d) return null;
  return (BigInt(m[1]) * 10n ** BigInt(d) + BigInt((m[2] ?? '').padEnd(d, '0') || '0')).toString();
}
export function bridged(v) {
  if (v === null || v === undefined || v === '') return '–';
  const u = store.status?.units?.bridgedTap, d = Number.isInteger(u) ? u : TAP_DEFAULT_DECIMALS;
  const text = shown(v, d);
  return text === '0' && /^0*[1-9]\d*$/.test(String(v)) ? '<0.00000001 bridged TAP' : `${text} bridged TAP`;
}
// Both payment routes price fees in the same TAP unit.
export const fee = (v, kind, unit) => tap(v, unit);
// Share of a total as "12.34 %" using integer arithmetic only.
export function percent(part, total) {
  const t = BigInt(total); if (!t) return '–';
  const bp = BigInt(part) * 10000n / t;
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, '0')} %`;
}
export function eth(v) { return v === null || v === undefined ? '–' : `${fmtAmount(v, 18)} ETH`; }
export function btc(v) {
  if (v === null || v === undefined) return '–';
  const s = String(v);
  return /^\d+$/.test(s) && s.length > 8 ? `${fmtAmount(s, 8)} BTC` : /\./.test(s) ? `${s} BTC` : `${fmtAmount(s, 8)} BTC`;
}

const ROLE = {
  treasury: ['Treasury', '#5A5E66', 'The quoted treasury share is paid directly.'],
  finder: ['Finder', '#4C6E3B', 'Whoever won this block\'s find.'],
  landowner: ['Bitmap holder', '#3E7F86', 'The current holder of the linked Bitmap. Burned when the block is not linked.'],
  burn: ['Burned', '#1F2328', 'Destroyed for good, shrinking TAP supply.'],
  firstMaker: ['First maker', '#6F9A3E', 'Whoever first made this compound type.'],
  legacyDeploy: ['Older deploy holders', '#5A5E66', 'Taken from burn, split equally per qualifying older deployment, and owed to its current Bitcoin holder in the payout ledger.'],
  discoverer: ['Discoverer', '#9A72C8', 'Paid directly to the pattern discoverer.'],
};
// Deferred shares use the same split rows; treasury holds their payout backing.
export function splitTable(split, destinations = {}, kind = 'tap', unit) {
  if (!split) return h('div.empty', {}, 'No split.');
  const entries = Object.entries(split).filter(([k, v]) => ROLE[k] && v !== undefined && v !== null);
  const total = entries.reduce((sum, [, v]) => sum + BigInt(v), 0n);
  const rows = entries.filter(([, v]) => v !== '0').map(([k, v]) => ({ role: k, amount: v, to: destinations[k] ?? null }));
  const bar = h('div.splitbar', { 'aria-hidden': 'true' }, rows.map(r => h('i', { style: { width: total ? percent(r.amount, total).replace(' ', '') : '0', background: ROLE[r.role][1] } })));
  return h('div', {}, bar, table(rows, [
    { key: 'role', label: 'Goes to', render: r => h('span', { 'data-tip': ROLE[r.role][2] }, h('span.swatch', { style: { background: ROLE[r.role][1] } }), ROLE[r.role][0]), sortable: false },
    { key: 'pct', label: 'Share', num: true, render: r => h('span.mono', {}, percent(r.amount, total)), sortable: false },
    { key: 'amount', label: 'Amount', num: true, render: r => h('span.mono', {}, fee(r.amount, kind, unit)), sortable: false },
    { key: 'to', label: 'Address', render: r => r.to ? hashEl(r.to) : h('span.faint', {}, r.role === 'burn' ? 'burn' : r.role === 'legacyDeploy' ? 'payout ledger' : '–'), sortable: false },
  ], { sortable: false }));
}

export function legacyDeployPolicyText(status) {
  const policy = status?.legacyDeployShare;
  if (!policy?.active) return 'The older deployment share is inactive.';
  const bps = BigInt(policy.shareBps), share = String(bps / 100n) + (bps % 100n ? '.' + String(bps % 100n).padStart(2, '0').replace(/0+$/, '') : '');
  return `${share} % of each qualifying pattern mint fee comes from the burn and is split equally among deployments before block ${policy.cutoff}, excluding the DMW authority. Their current Bitcoin holders accrue TAP in the public payout ledger, paid by the operator once an address is owed at least ${tap(policy.payoutMinAtoms, status.unit)}. With no qualifying deployment, that share stays in the burn.`;
}

export function legacyDeployPaymentText(status) {
  const amount = status?.split?.legacyDeploy;
  return amount ? ` ${tap(amount, status.unit)} from this mint's burn is held in treasury for older deploy holders and paid through the payout ledger.` : '';
}
