// Trac identities are 32-byte Ed25519 keys encoded as lowercase bech32m.
// Dependency-free so the exact same codec runs in services, kits and browsers.
const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const prefix = [3, 3, 3, 3, 0, 20, 18, 1, 3]; // HRP expansion of "trac"
export const TRAC_ADDRESS_ERROR = 'Use a checksum-valid trac1… Trac address; raw hex keys are not accepted.';
const fail = () => { throw Object.assign(new Error(TRAC_ADDRESS_ERROR), { code: 'trac_address_required', status: 400 }); };
function polymod(words) {
  let chk = 1;
  for (const word of words) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ word;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generators[i];
  }
  return chk >>> 0;
}
function convert(words, from, to, pad) {
  let acc = 0, bits = 0; const out = [], mask = (1 << to) - 1;
  for (const word of words) {
    acc = ((acc << from) | word) & ((1 << (from + to - 1)) - 1); bits += from;
    while (bits >= to) { bits -= to; out.push((acc >>> bits) & mask); }
  }
  if (pad && bits) out.push((acc << (to - bits)) & mask);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & mask))) fail();
  return out;
}
export function encodeTracAddress(key) {
  const bytes = typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)
    ? Uint8Array.from(key.match(/../g), b => parseInt(b, 16)) : key;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) fail();
  const words = convert(bytes, 8, 5, true), checksum = polymod([...prefix, ...words, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  for (let i = 5; i >= 0; i--) words.push((checksum >>> (i * 5)) & 31);
  return 'trac1' + words.map(n => alphabet[n]).join('');
}
export function decodeTracAddress(address) {
  if (typeof address !== 'string' || !/^trac1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(address)) fail();
  const words = [...address.slice(5)].map(c => alphabet.indexOf(c));
  if (polymod([...prefix, ...words]) !== 0x2bc830a3) fail();
  const bytes = convert(words.slice(0, -6), 5, 8, false);
  if (bytes.length !== 32) fail();
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}
export function isTracAddress(address) { try { decodeTracAddress(address); return true; } catch { return false; } }
export function validateTracAddress(address) { decodeTracAddress(address); return address; }
export function shortTracAddress(address) { validateTracAddress(address); return address.slice(0, 9) + '…' + address.slice(-4); }

export const tracIdentityFields = new Set(['address', 'agent', 'owner', 'actor', 'finder', 'discoverer', 'firstMaker', 'holder', 'currentHolder', 'claimant', 'sender', 'recipient', 'from', 'to', 'winner', 'feeSource', 'headerSenders', 'owners', 'claimants', 'opponentOwners', 'landowner']);
const hexKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
// Only presentation copies are transformed. Wire packets and stored records
// remain untouched; monetary role names in fee splits are not identities.
export function publicIdentities(value, key = '', identities = true) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (identities && tracIdentityFields.has(key) && hexKey(value)) return encodeTracAddress(value);
    if (identities && ['route', 'source'].includes(key) && value.startsWith('/')) return tracReadRoute(value, 'public');
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => publicIdentities(v, key, identities));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicIdentities(v, k === 'a' && value.network && value.t ? 'agent' : k, identities && !['split', 'amounts', 'feeQuote', 'feeAuthorization'].includes(k))]));
}
// Internal adapters restore public projections before protocol verification or
// rule evaluation. This is not an input validator; callers must validate inputs.
export function wireIdentities(value, key = '') {
  if (typeof value === 'string') return tracIdentityFields.has(key) && value.startsWith('trac1') ? decodeTracAddress(value) : value;
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => wireIdentities(v, key));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ['split', 'amounts', 'feeQuote', 'feeAuthorization'].includes(k) ? v : wireIdentities(v, k === 'a' && value.network && value.t ? 'agent' : k)]));
}
const queryIdentities = new Set(['owner', 'address', 'agent', 'actor', 'finder', 'discoverer', 'firstMaker', 'holder', 'claimant', 'sender', 'recipient']);
export function tracReadRoute(input, direction = 'wire', depth = 0) {
  if (depth > 3) fail();
  if (depth && (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//') || /[\\#]/.test(input) || input.includes('..')))
    throw Object.assign(new Error('invalid_list_source'), { status: 400 });
  const url = new URL(input, 'http://127.0.0.1');
  const change = value => direction === 'wire' ? decodeTracAddress(value) : hexKey(value) ? encodeTracAddress(value) : value;
  url.pathname = url.pathname.replace(/\/(agents|payout-bindings)\/([^/]+)/, (all, collection, address) =>
    collection === 'payout-bindings' && address === 'requests' ? all : '/' + collection + '/' + change(address));
  for (const [key, value] of [...url.searchParams]) {
    if (queryIdentities.has(key)) {
      if (url.searchParams.getAll(key).length !== 1) throw Object.assign(new Error('duplicate_parameter'), { status: 400 });
      url.searchParams.set(key, change(value));
    }
    if (key === 'source' && value.startsWith('/')) url.searchParams.set(key, tracReadRoute(value, direction, depth + 1));
  }
  if (direction === 'wire' && /\/agents$/.test(url.pathname) && hexKey(url.searchParams.get('q'))) fail();
  return url.pathname + url.search;
}

// Cursor anchors retain their original ordering internally. Only identity
// values appearing in the selected row are encoded in the public payload.
export function publicCursorAnchor(entry) {
  const identities = new Set();
  const collect = (v, key = '') => {
    if (typeof v === 'string' && tracIdentityFields.has(key) && hexKey(v)) identities.add(v);
    else if (Array.isArray(v)) v.forEach(x => collect(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!['split', 'amounts'].includes(k)) collect(x, k);
  };
  collect(entry.row);
  const encode = v => typeof v === 'string' ? v.replace(/[0-9a-f]{64}/g, k => identities.has(k) ? encodeTracAddress(k) : k) : v;
  const key = encode(entry.key), tie = encode(entry.tie);
  return { key, tie, encoded: ['key', 'tie'].filter(k => (k === 'key' ? key : tie) !== entry[k]) };
}
export function wireCursorAnchor(anchor) {
  const decode = v => typeof v === 'string' ? v.replace(/trac1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}/g, decodeTracAddress) : v;
  const { encoded = [], ...rest } = anchor;
  if (!Array.isArray(encoded) || encoded.some(k => !['key', 'tie'].includes(k))) fail();
  return { ...rest, key: encoded.includes('key') ? decode(anchor.key) : anchor.key, tie: encoded.includes('tie') ? decode(anchor.tie) : anchor.tie };
}
