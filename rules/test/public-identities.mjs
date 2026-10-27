import assert from 'node:assert/strict';
import { tracIdentityFields } from '../src/trac-address.js';
export function assertPublicIdentities(value, key = '', path = '') {
  if (typeof value === 'string' && tracIdentityFields.has(key)) assert.ok(!/^[0-9a-f]{64}$/.test(value), `Raw Trac identity at ${path}`);
  else if (Array.isArray(value)) value.forEach((v, i) => assertPublicIdentities(v, key, path + '/' + i));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (!['split', 'amounts'].includes(k)) assertPublicIdentities(v, k, path + '/' + k);
}
