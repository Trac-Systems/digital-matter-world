import { encodeTracAddress as encode, tracReadRoute as route, tracIdentityFields } from '../../rules/src/trac-address.js';
import { BoundedLRU, PUBLIC_READ_DEFAULTS, publicReadSettings } from './public-read-settings.mjs';
export * from '../../rules/src/trac-address.js';
let addresses, routes;
export function configurePublicIdentities(settings = {}) {
  const { identityCacheEntries } = publicReadSettings(settings);
  addresses = new BoundedLRU(identityCacheEntries); routes = new BoundedLRU(identityCacheEntries);
}
configurePublicIdentities(PUBLIC_READ_DEFAULTS);
export function encodeTracAddress(value) {
  const key = value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value;
  const saved = addresses.get(key);
  return saved ?? addresses.set(key, encode(value));
}
export function tracReadRoute(input, direction = 'wire', depth = 0) {
  // Cache scalar presentation values, never mutable response objects.
  if (typeof input !== 'string') return route(input, direction, depth);
  const key = JSON.stringify([input, direction, depth]), saved = routes.get(key);
  return saved ?? routes.set(key, route(input, direction, depth));
}
export function publicIdentities(value, key = '', identities = true) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (identities && tracIdentityFields.has(key) && /^[0-9a-f]{64}$/.test(value)) return encodeTracAddress(value);
    if (identities && ['route', 'source'].includes(key) && value.startsWith('/')) return tracReadRoute(value, 'public');
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => publicIdentities(v, key, identities));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicIdentities(v,
    k === 'a' && value.network && value.t ? 'agent' : k,
    identities && !['split', 'amounts', 'feeQuote', 'feeAuthorization'].includes(k))]));
}
