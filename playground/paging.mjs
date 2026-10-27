import { publicCursorAnchor, wireCursorAnchor, publicIdentities } from '../rules/src/trac-address.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const secret = randomBytes(32);
const fail = message => { throw Object.assign(Error(message), { status: 400 }); };
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
const numeric = new Set(['index', 'sequence', 'number', 'height', 'block', 'region', 'halving', 'count', 'pattern', 'tier', 'status', 'amount', 'price', 'total', 'supply', 'minted', 'madeReal', 'rarity', 'accrued', 'paid', 'owed', 'findHeight', 'finderUntil', 'window', 'settledAt', 'linkHeight', 'revealFrom', 'revealUntil', 'created', 'finished', 'at', 'pid']);
export const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
export const field = (row, key) => row && Object.hasOwn(row, key) ? row[key] : null;
export function limitOf(params) {
  const value = params.get('limit') ?? '50';
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 200) fail('limit_1_200');
  return Number(value);
}
export function booleanFilter(value) {
  if (!['true', 'false'].includes(value)) fail('boolean_filter');
  return value === 'true';
}
export function numberFilter(value) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('integer_filter');
  return Number(value);
}
export function enumFilter(values) {
  return value => { if (!values.includes(value)) fail('invalid_filter'); return value; };
}
const compare = (a, b, key) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (numeric.has(key) && /^-?\d+$/.test(String(a)) && /^-?\d+$/.test(String(b))) {
    const left = BigInt(a), right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};
const tieFor = (row, index) => {
  if (!row || typeof row !== 'object') return json([row, index]);
  // Include the role/recipient for ledger rows that share a request ID.
  if (row.id !== undefined) return json([row.id, row.role ?? null, row.to ?? null]);
  if (row.sequence !== undefined) return String(row.sequence);
  if (row.actionId !== undefined) return row.actionId;
  if (row.asset !== undefined) return json([row.asset, row.block ?? null]);
  if (row.height !== undefined) return json([row.height, row.inscription ?? null]);
  if (row.address !== undefined) return row.address;
  if (row.number !== undefined) return String(row.number);
  if (row.name !== undefined) return row.name;
  return digest(row);
};

// Keyset cursors bind to the route, filter values and ordering, not the page size.
export function pageRows(rows, params, { route, keys = ['index'], sort = keys[0], order = 'asc', filters = {}, get = field, match = () => true } = {}) {
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1) fail('duplicate_parameter');
    if (!['limit', 'cursor', 'sort', 'order', ...Object.keys(filters)].includes(key)) fail('unknown_parameter_' + key);
  }
  const limit = limitOf(params), sortKey = params.get('sort') ?? sort, direction = params.get('order') ?? order;
  if (!keys.includes(sortKey)) fail('invalid_sort');
  if (!['asc', 'desc'].includes(direction)) fail('invalid_order');
  const selectedFilters = Object.fromEntries(Object.keys(filters).sort().filter(k => params.has(k)).map(k => [k, filters[k](params.get(k))]));
  const scope = digest([route, sortKey, direction, selectedFilters]);
  let anchor;
  const cursor = params.get('cursor');
  if (cursor) {
    try {
      if (cursor.length > 8192 || !/^[\w-]+\.[\w-]+$/.test(cursor)) throw Error();
      const [payload, signature] = cursor.split('.'), expected = Buffer.from(sign(payload)), got = Buffer.from(signature);
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw Error();
      anchor = wireCursorAnchor(JSON.parse(Buffer.from(payload, 'base64url').toString()));
      if (anchor.scope !== scope || !scalar(anchor.key) || typeof anchor.tie !== 'string') throw Error();
    } catch { fail('invalid_cursor'); }
  }
  const entries = [], duplicates = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!match(row, selectedFilters)) continue;
    const key = sortKey === 'index' ? index : get(row, sortKey) ?? null;
    if (!scalar(key)) fail('sort_field_not_scalar');
    const identity = tieFor(row, index), occurrence = duplicates.get(identity) ?? 0;
    duplicates.set(identity, occurrence + 1);
    entries.push({ row, index, key, tie: identity + '\u0000' + occurrence });
  }
  const cmp = (a, b) => (compare(a.key, b.key, sortKey) || compare(a.tie, b.tie, 'tie')) * (direction === 'asc' ? 1 : -1);
  entries.sort(cmp);
  const total = entries.length, remaining = anchor ? entries.filter(entry => cmp(entry, anchor) > 0) : entries;
  const selected = remaining.slice(0, limit), last = selected.at(-1);
  let next = null;
  if (remaining.length > limit) {
    const payload = Buffer.from(json({ scope, ...publicCursorAnchor(last) })).toString('base64url');
    next = payload + '.' + sign(payload);
  }
  return { entries: selected, meta: { total, next, limit, sort: sortKey, order: direction, route } };
}

const escapePointer = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
export function listRoute(source, path) {
  return '/api/list?' + new URLSearchParams({ source, path });
}
export function pointerValue(value, path) {
  if (path === '') return value;
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) fail('invalid_list_path');
  for (const token of path.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) fail('list_path_missing');
    value = value[key];
  }
  return value;
}
export function genericSpec(rows, route) {
  const keys = new Set(['index']);
  for (const row of rows) if (row && !Array.isArray(row) && typeof row === 'object') {
    for (const [key, value] of Object.entries(row)) if (scalar(value)) keys.add(key);
  }
  return { route, keys: [...keys], sort: 'index', filters: { q: String }, match: (row, f) => !f.q || json(publicIdentities(row)).toLowerCase().includes(f.q.toLowerCase()) };
}

// Traverse raw source positions so every nested preview has a retrievable path.
// Dedicated policies override the generic array route without changing row shapes.
export function projectLists(value, { source, params = new URLSearchParams(), policies = {}, primary, path = '', previewLimit = limitOf(params), atomicTuple = false, atomicPaths = [] } = {}) {
  const project = (input, pointer, tuple = false) => {
    if (!input || typeof input !== 'object') return input;
    if (atomicPaths.includes(pointer)) {
      const bounded = item => {
        if (!item || typeof item !== 'object') return;
        if (Array.isArray(item) && item.length > 200) fail('atomic_array_limit');
        for (const child of Object.values(item)) bounded(child);
      };
      bounded(input);
      return input;
    }
    if (Array.isArray(input)) {
      if (tuple && input.length <= 2 && input.every(scalar)) return input.slice();
      const page = paginate(input, pointer);
      return { items: page.items, ...page.meta };
    }
    const output = {}, pages = {}, counts = {};
    for (const [key, child] of Object.entries(input)) {
      const childPath = pointer + '/' + escapePointer(key);
      if (Array.isArray(child)) {
        const page = paginate(child, childPath);
        output[key] = page.items; pages[key] = page.meta; counts[key] = page.meta.total;
      } else output[key] = project(child, childPath);
    }
    if (Object.keys(pages).length) {
      output[Object.hasOwn(input, 'pages') ? 'pagination' : 'pages'] = pages;
      output[Object.hasOwn(input, 'counts') ? 'listCounts' : 'counts'] = counts;
    }
    return output;
  };
  const paginate = (rows, pointer) => {
    const policy = policies[pointer] ?? genericSpec(rows, listRoute(source, pointer));
    const query = pointer === primary ? params : new URLSearchParams({ limit: String(previewLimit) });
    const { entries, meta } = pageRows(rows, query, policy);
    return { items: entries.map(({ row, index }) => project(row, pointer + '/' + index, true)), meta };
  };
  const output = project(value, path, atomicTuple);
  if (primary) Object.assign(output, output.pages?.[primary.slice(primary.lastIndexOf('/') + 1)]);
  return output;
}
