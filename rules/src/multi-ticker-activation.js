// Coordinated-release placeholder. Only execution height selects admission.
import { decimalV2 } from './integers-v2.js';
export const MULTI_TICKER_HEIGHT = '973890';
export const multiTickerActive = height => BigInt(decimalV2(height)) >= BigInt(MULTI_TICKER_HEIGHT);
