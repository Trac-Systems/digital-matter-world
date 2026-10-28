// Compatibility constructor; verification, storage and seed recovery share BitcoinViews.
import { BitcoinViews } from './bitcoin.mjs';
export class DecimalBitcoinViews extends BitcoinViews {
  constructor(client, filename, options = {}) { super(client, filename, { ...options, integerVersion: 2 }); }
}
