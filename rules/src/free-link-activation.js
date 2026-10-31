// Coordinated-release placeholder. Only execution height selects admission.
import { decimalV2 } from './integers-v2.js';
export const FREE_LINK_HEIGHT = '973988';
export const freeLinkActive = height => BigInt(decimalV2(height)) >= BigInt(FREE_LINK_HEIGHT);
