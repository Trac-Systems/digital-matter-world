import { decimalV2, safeNumberV2, patternAssetV2, patternAsset } from '../../rules/src/index.js';
import { financialAsset } from '../../rules/src/financial-mint.js';
import { check, hex32 } from './check.mjs';

// Convert only values consumed by local numeric algorithms. Never recursively
// coerce public JSON: amounts, revisions, signed packets and proofs stay exact.
export function readInteger(value) { return safeNumberV2(decimalV2(value)); }
export { financialAsset as isAsset };
export function patternId(pattern) {
  return hex32(pattern?.key) ? patternAssetV2(decimalV2(pattern.number)) : patternAsset(readInteger(pattern.number));
}
export function nextCursor(page) {
  const next = page.next === undefined ? page.nextCursor : page.next;
  check(next === null || typeof next === 'string' && next.length > 0, 'Invalid public page cursor');
  check(page.nextCursor === undefined || page.next === undefined || page.next === page.nextCursor, 'Conflicting public page cursors');
  return next;
}
export function claimSelection(payload) {
  return { ...payload, ...(payload.window === undefined ? {} : { window: readInteger(payload.window) }),
    plots: payload.plots.map(p => ({ ...p, block: readInteger(p.block), patterns: p.patterns.map(readInteger) })),
    ...(payload.header ? { header: { ...payload.header, ...(payload.header.height === undefined ? {} : { height: readInteger(payload.header.height) }) } } : {}) };
}
