import { assert, integer } from './core.js';
import { freeLinkActive } from './free-link-activation.js';
import { multiTickerActive } from './multi-ticker-activation.js';
import { TICKER_DEPLOY_SETTINGS } from './settings-v2.js';
// All fee math, indexed payments, escrow amounts and payouts use this unit.
export const TAP_DECIMALS = 18;
export const TAP_UNIT = Object.freeze({ currency: 'TAP', denomination: 'atomic', decimals: TAP_DECIMALS });
const TAP_SCALE = 10n ** BigInt(TAP_DECIMALS);
// ord-tap limits a lock's total to u64 whole tokens at the deployment precision.
export const TAP_MAX_ATOMS = 18446744073709551615n * TAP_SCALE;
export function tapAtoms(value) {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,37})$/.test(value), 'tap_atomic_amount');
  const atoms = BigInt(value); assert(atoms <= TAP_MAX_ATOMS, 'tap_amount_range'); return atoms;
}
export function parseTapAmount(value) {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/.test(value), 'tap_decimal_amount');
  const [whole, fraction = ''] = value.split('.');
  return tapAtoms((BigInt(whole) * TAP_SCALE + BigInt(fraction.padEnd(TAP_DECIMALS, '0'))).toString()).toString();
}
export function formatTapAmount(value) {
  const atoms = tapAtoms(value), fraction = (atoms % TAP_SCALE).toString().padStart(TAP_DECIMALS, '0').replace(/0+$/, '');
  return (atoms / TAP_SCALE).toString() + (fraction ? '.' + fraction : '');
}
// Legacy fallback only: configured multipliers travel with signed/stored terms.
// Keep these values stable so pre-configuration quotes and installed kits agree.
export const FEE_DEFAULTS = Object.freeze({ tierMultipliers: Object.freeze([1, 3, 10, 30, 100]), compoundMinimum: 10, link: 20 });
function amount(v) { assert(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v), 'amount'); return BigInt(v); }
export function feeFor(kind, base, tier = 1, settings = {}, executionHeight = '0') {
  if (kind === 'ticker' && multiTickerActive(executionHeight)) {
    const multiplier = settings.tickerDeployMultiplier ?? TICKER_DEPLOY_SETTINGS.tickerDeployMultiplier;
    assert(Number.isSafeInteger(multiplier) && multiplier >= 0, 'fee_settings');
    return tapAtoms((amount(base) * BigInt(multiplier)).toString()).toString();
  }
  const s = { ...FEE_DEFAULTS, ...settings };
  assert(integer(tier) && tier >= 1 && tier <= 5 && s.tierMultipliers.length === 5 &&
    [...s.tierMultipliers, s.compoundMinimum].every(n => integer(n) && n > 0) &&
    integer(s.link) && (s.link > 0 || s.link === 0 && freeLinkActive(executionHeight)), 'fee_settings');
  let multiplier;
  if (kind === 'find') multiplier = s.tierMultipliers[tier - 1];
  else if (kind === 'compound') multiplier = Math.max(s.compoundMinimum, s.tierMultipliers[tier - 1]);
  else { assert(kind === 'link', 'fee_kind'); multiplier = s[kind]; }
  return tapAtoms((amount(base) * BigInt(multiplier)).toString()).toString();
}
export function splitFee(total, { kind = 'find', linked = false, discovered = false } = {}) {
  const n = amount(total), cut = percent => n * BigInt(percent) / 100n;
  let firstMaker = 0n, finder = 0n, landowner = 0n, burn = 0n, discoverer = 0n;
  if (kind === 'compound') { firstMaker = cut(30); burn = cut(35); }
  else if (kind === 'find') {
    finder = cut(30); landowner = linked ? cut(15) : 0n;
    burn = cut(20) + (linked ? 0n : cut(15));
    discoverer = discovered ? cut(5) : 0n;
  } else { assert(kind === 'link', 'fee_kind'); burn = cut(50); }
  // Every independently rounded share floors; treasury receives all remainder.
  const treasury = n - firstMaker - finder - landowner - burn - discoverer;
  return Object.fromEntries(Object.entries({ firstMaker, finder, landowner, burn, treasury, discoverer }).map(([k, v]) => [k, v.toString()]));
}

// Commissions are liabilities of the treasury, paid in the public payout ledger.
export const treasuryPayment = split => (BigInt(split.treasury) + BigInt(split.discoverer) + BigInt(split.legacyDeploy ?? '0') + BigInt(split.deployer ?? '0')).toString();
export function commissionOwed(id, split, destinations, kind = 'tap') {
  return ['discoverer', ...(kind === 'ethereum' ? ['landowner'] : [])].filter(role => split[role] !== '0').map(role => {
    assert(typeof destinations[role] === 'string' && destinations[role].length > 0, 'commission_destination');
    return { id, role, to: destinations[role], amount: split[role] };
  });
}
