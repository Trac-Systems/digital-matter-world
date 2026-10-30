export const TNK_SCALE = 10n ** 18n;
export const TNK_MAX_ATOMS = (1n << 128n) - 1n;

export function tnkError(code, details = {}) { return Object.assign(new Error(code), { code, ...details }); }
export function requireTnk(ok, code) { if (!ok) throw tnkError(code); }

export function formatTnk(atoms) {
  const whole = atoms / TNK_SCALE, fraction = (atoms % TNK_SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return String(whole) + (fraction ? '.' + fraction : '');
}
export function parseTnk(amount) {
  requireTnk(typeof amount === 'string' && amount.length <= 59 && /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(amount), 'tnk_invalid_amount');
  const [whole, fraction = ''] = amount.split('.');
  const atoms = BigInt(whole) * TNK_SCALE + BigInt(fraction.padEnd(18, '0'));
  requireTnk(atoms > 0n && atoms <= TNK_MAX_ATOMS, 'tnk_invalid_amount');
  return atoms;
}
export function tnkQuote(balance, to, amount) {
  const available = BigInt(balance.balanceAtoms), fee = BigInt(balance.feeAtoms);
  const atoms = amount === 'max' ? available - fee : parseTnk(amount);
  requireTnk(balance.accountExists && atoms > 0n && atoms + fee <= available, 'tnk_insufficient');
  requireTnk(atoms <= TNK_MAX_ATOMS, 'tnk_invalid_amount');
  return { ...balance, to, amount, amountAtoms: String(atoms), amountTnk: formatTnk(atoms),
    totalAtoms: String(atoms + fee), totalTnk: formatTnk(atoms + fee),
    remainingAtoms: String(available - atoms - fee), remainingTnk: formatTnk(available - atoms - fee) };
}
