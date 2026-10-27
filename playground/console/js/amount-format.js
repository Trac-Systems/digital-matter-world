// Shared, DOM-free display boundary. Never convert atomic money through Number.
const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function fmtInt(v) {
  if (v === null || v === undefined || v === '') return '–';
  const s = String(v);
  return /^-?\d+$/.test(s) ? (s.startsWith('-') ? '-' + group(s.slice(1)) : group(s)) : s;
}
export function fmtAmount(v, decimals = 0, maxFrac = 8) {
  if (v === null || v === undefined || v === '') return '–';
  const s = String(v);
  if (!/^-?\d+$/.test(s) || !decimals) return fmtInt(s);
  const neg = s.startsWith('-'), d = (neg ? s.slice(1) : s).padStart(decimals + 1, '0');
  const whole = d.slice(0, -decimals), frac = d.slice(-decimals).slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '-' : '') + group(whole) + (frac ? '.' + frac : '');
}
export function formatTap(v, decimals = 18) {
  if (v === null || v === undefined || v === '') return '–';
  const digits = String(v).replace(/^0+/, '').length, whole = Math.max(1, digits - decimals);
  const text = fmtAmount(v, decimals, Math.max(0, Math.min(8, 12 - whole)));
  return text === '0' && /^0*[1-9]\d*$/.test(String(v)) ? '<0.00000001 TAP' : `${text} TAP`;
}
