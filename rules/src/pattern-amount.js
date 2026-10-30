import { assert } from './core.js';
import { decimalV2 } from './integers-v2.js';
import { countWith, fieldValue, validateDefinition } from './patterns.js';

// Coordinated-release placeholder. Only execution height selects admission;
// an old witness block or a client-supplied snapshot cannot select the rules.
export const FIELD_VALUE_AMOUNT_HEIGHT = '973840';
export const fieldValueAmountActive = height => BigInt(decimalV2(height)) >= BigInt(FIELD_VALUE_AMOUNT_HEIGHT);
export const fieldValueMode = pattern => pattern.amountMode === 'field-value';

// `count` remains the wire name for units. Regex matches select eligible
// blocks in both modes; a field-value block pays its numeric value once.
export function amountWith(pattern, regex, field) {
  const count = countWith(regex, field);
  if (!fieldValueMode(pattern)) return String(count);
  if (!count) return '0';
  return String(BigInt(pattern.dt === 'h' ? '0x' + field : field));
}
export function patternAmount(pattern, header) {
  validateDefinition(pattern);
  return amountWith(pattern, new RegExp(pattern.pat, 'g'), fieldValue(header, pattern.fld, pattern.dt));
}

// ord-tap chooses full field values only when the element has no pattern.
// Empty regex is different and must never be used for this purpose.
export const tapElementPattern = pattern => fieldValueMode(pattern) ? null : pattern.pat;
export function tapElementText(name, pattern) {
  assert(typeof name === 'string' && !name.includes('.'), 'element_name');
  return fieldValueMode(pattern) ? `${name}.${pattern.fld}.element` : `${name}.${pattern.pat}.${pattern.fld}.element`;
}
