import { decimalV2 } from './integers-v2.js';

// Coordinated release: admission follows batch execution height, never the
// proposal's witness anchor, receipt tip, or a client-selected snapshot.
export const PLAIN_NAMES_HEIGHT = '973850';
export const plainNamesActive = height => BigInt(decimalV2(height)) >= BigInt(PLAIN_NAMES_HEIGHT);
export const PLAIN_PATTERN_NAME = /^[a-z0-9]{3,32}$/;
export const LEGACY_PATTERN_NAME = /^dmw[a-z0-9]{2,29}$/;
export const validPatternName = (name, height = '0') => typeof name === 'string' &&
  (plainNamesActive(height) ? PLAIN_PATTERN_NAME : LEGACY_PATTERN_NAME).test(name);
