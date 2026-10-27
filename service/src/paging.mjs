import { publicCursorAnchor, wireCursorAnchor, publicIdentities } from '../../rules/src/trac-address.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const secret = randomBytes(32);
const fail = message => { throw Object.assign(Error(message), { status: 400 }); };
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
const numeric = new Set(['finds', 'discoveries', 'crafts', 'mints', 'opensAt', 'index', 'sequence', 'number', 'height', 'block', 'region', 'halving', 'count', 'pattern', 'tier', 'status', 'amount', 'price', 'total', 'supply', 'minted', 'madeReal', 'rarity', 'accrued', 'paid', 'owed', 'findHeight', 'finderUntil', 'window', 'settledAt', 'linkHeight', 'revealFrom', 'revealUntil', 'created', 'finished', 'at', 'pid']);
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
export const compare = (a, b, key) => {
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
export const tieFor = (row, index) => {
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
  const query = { limit, sortKey, direction, selectedFilters, anchor, scope, route, get, match };
  if (rows?.page) return rows.page(query);
  return pageArray(rows, query);
}

export function pageArray(rows, { limit, sortKey, direction, selectedFilters, anchor, scope, route, get, match }) {
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
    next = pageCursor(scope, last);
  }
  return { entries: selected, meta: { total, next, limit, sort: sortKey, order: direction, route } };
}

export function pageCursor(scope, last) {
  const payload = Buffer.from(json({ scope, ...publicCursorAnchor(last) })).toString('base64url');
  return payload + '.' + sign(payload);
}
// A deterministic treap maintains subtree counts and range bounds. Reads skip
// whole subtrees for totals and seek directly past the existing keyset cursor.
const size = (n) => n?.size ?? 0;
const update = (n) => {
  if (!n) return n;
  n.size = 1 + size(n.left) + size(n.right);
  n.min = Math.min(n.range, n.left?.min ?? Infinity, n.right?.min ?? Infinity);
  n.max = Math.max(n.range, n.left?.max ?? -Infinity, n.right?.max ?? -Infinity);
  return n;
};
const priority = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};
const merge = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  if (a.priority < b.priority) {
    a.right = merge(a.right, b);
    return update(a);
  }
  b.left = merge(a, b.left);
  return update(b);
};
export class PageTree {
  constructor(key) {
    this.key = key;
    this.root = null;
  }
  compare = (a, b) => compare(a.key, b.key, this.key) || compare(a.tie, b.tie, 'tie');
  set(entry, range = 0) {
    const insert = (n) => {
      if (!n) return update({ entry, range, priority: priority(entry.tie), left: null, right: null });
      const c = this.compare(entry, n.entry);
      if (!c) {
        n.entry = entry;
        n.range = range;
        return update(n);
      }
      const side = c < 0 ? 'left' : 'right',
        other = c < 0 ? 'right' : 'left';
      n[side] = insert(n[side]);
      if (n[side].priority < n.priority) {
        const child = n[side];
        n[side] = child[other];
        child[other] = update(n);
        return update(child);
      }
      return update(n);
    };
    this.root = insert(this.root);
  }
  delete(entry) {
    const remove = (n) => {
      if (!n) return null;
      const c = this.compare(entry, n.entry);
      if (!c) return merge(n.left, n.right);
      const side = c < 0 ? 'left' : 'right';
      n[side] = remove(n[side]);
      return update(n);
    };
    this.root = remove(this.root);
  }
  rank(entry, from = -Infinity, to = Infinity) {
    let n = this.root,
      total = 0;
    while (n) {
      if (this.compare(n.entry, entry) < 0) {
        total += Number(n.range >= from && n.range <= to) + this.count(from, to, n.left);
        n = n.right;
      } else n = n.left;
    }
    return total;
  }
  count(from = -Infinity, to = Infinity, n = this.root) {
    if (!n || n.max < from || n.min > to) return 0;
    if (n.min >= from && n.max <= to) return n.size;
    return Number(n.range >= from && n.range <= to) + this.count(from, to, n.left) + this.count(from, to, n.right);
  }
  *entries({ anchor, direction, from = -Infinity, to = Infinity }, n = this.root) {
    if (!n || n.max < from || n.min > to) return;
    const asc = direction === 'asc',
      c = anchor ? this.compare(n.entry, anchor) * (asc ? 1 : -1) : 1;
    if (c <= 0) {
      yield* this.entries({ anchor, direction, from, to }, asc ? n.right : n.left);
      return;
    }
    yield* this.entries({ anchor, direction, from, to }, asc ? n.left : n.right);
    if (n.range >= from && n.range <= to) yield n.entry;
    yield* this.entries({ anchor, direction, from, to }, asc ? n.right : n.left);
  }
}

// Exact-filter combinations keep maintained counts and order indexes. Boolean
// facets use disjoint partitions (at most 32), avoiding duplicate row indexes.
// Range filters use subtree bounds; requests only merge bounded page candidates.
export class IndexedRows {
  constructor(
    spec,
    {
      facets = [],
      partitioned = false,
      emptyMatchesAll = false,
      range,
      values = (row, key) => [spec.get?.(row, key) ?? field(row, key)],
      queryValue = (key, value) => String(value),
      rangeValue = (row) => Number(field(row, range)),
    } = {},
  ) {
    Object.assign(this, { spec, facets, partitioned, emptyMatchesAll, range, values, queryValue, rangeValue });
    this.rows = new Map();
    this.buckets = new Map();
  }
  bucketKey(pairs) {
    return json(pairs);
  }
  memberships(row) {
    let combinations = [[]];
    for (const key of this.facets) {
      const previous = combinations;
      const additions = [...new Set(this.values(row, key).map((v) => String(v ?? '')))].flatMap((value) =>
        previous.map((p) => [...p, [key, value]]),
      );
      combinations = this.partitioned ? additions : [...previous, ...additions];
    }
    return combinations.map((p) => this.bucketKey(p));
  }
  set(id, row, index = id) {
    this.delete(id);
    const entry = { row, index, tie: tieFor(row, index) + '\u00000' },
      memberships = this.memberships(row);
    this.rows.set(id, { entry, memberships });
    for (const key of memberships) {
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = new Map([...this.spec.keys, '__source', ...(this.range ? ['__range'] : [])].map((k) => [k, new PageTree(k)]));
        this.buckets.set(key, bucket);
      }
      for (const [key, tree] of bucket)
        tree.set(
          {
            ...entry,
            key:
              key === '__range'
                ? this.rangeValue(row)
                : ['index', '__source'].includes(key)
                  ? index
                  : ((this.spec.get ?? field)(row, key) ?? null),
          },
          this.range ? this.rangeValue(row) : 0,
        );
    }
  }
  delete(id) {
    const old = this.rows.get(id);
    if (!old) return;
    for (const key of old.memberships) {
      const bucket = this.buckets.get(key);
      for (const [key, tree] of bucket)
        tree.delete({
          ...old.entry,
          key:
            key === '__range'
              ? this.rangeValue(old.entry.row)
              : ['index', '__source'].includes(key)
                ? old.entry.index
                : ((this.spec.get ?? field)(old.entry.row, key) ?? null),
        });
      if (!bucket.values().next().value.root) this.buckets.delete(key);
    }
    this.rows.delete(id);
  }
  page(query) {
    const { selectedFilters: f, sortKey, direction, anchor, limit, scope, route } = query;
    const pairs = this.facets
      .filter((k) => f[k] !== undefined && (!this.emptyMatchesAll || f[k] !== ''))
      .map((k) => [k, this.queryValue(k, f[k])]);
    const buckets = this.partitioned
      ? [...this.buckets]
          .filter(([key]) => {
            const p = JSON.parse(key);
            return pairs.every(([k, v]) => p.some(([a, b]) => a === k && b === v));
          })
          .map(([, b]) => b)
      : [this.buckets.get(this.bucketKey(pairs))].filter(Boolean);
    let from = f.from ?? -Infinity,
      to = f.to ?? Infinity;
    if (f.since !== undefined) from = f.since + 1;
    if (this.range && f[this.range] !== undefined) from = to = f[this.range];
    let total = 0;
    const entries = [];
    for (const bucket of buckets) {
      const tree = bucket.get(sortKey),
        rangeTree = bucket.get('__range') ?? tree,
        count = rangeTree.count(from, to);
      total += count;
      if (count <= limit * 2 && this.range && (from !== -Infinity || to !== Infinity)) {
        const candidates = [];
        for (const e of rangeTree.entries({ direction: 'asc', from, to })) {
          const entry = { ...e, key: (this.spec.get ?? field)(e.row, sortKey) ?? null };
          if (!anchor || tree.compare(entry, anchor) * (direction === 'asc' ? 1 : -1) > 0) candidates.push(entry);
        }
        candidates.sort((a, b) => tree.compare(a, b) * (direction === 'asc' ? 1 : -1));
        entries.push(...candidates.slice(0, limit + 1));
      } else {
        let n = 0;
        for (const entry of tree.entries({ anchor, direction, from, to })) {
          entries.push(entry);
          if (++n > limit) break;
        }
      }
    }
    if (buckets.length > 1)
      entries.sort((a, b) => (compare(a.key, b.key, sortKey) || compare(a.tie, b.tie, 'tie')) * (direction === 'asc' ? 1 : -1));
    const more = entries.length > limit;
    entries.length = Math.min(entries.length, limit);
    const source = query.sourceFilters ?? {},
      sourcePairs = this.facets.filter((k) => source[k] !== undefined).map((k) => [k, this.queryValue(k, source[k])]);
    const sourceBuckets = this.partitioned
      ? [...this.buckets]
          .filter(([key]) => {
            const p = JSON.parse(key);
            return sourcePairs.every(([k, v]) => p.some(([a, b]) => a === k && b === v));
          })
          .map(([, b]) => b)
      : [this.buckets.get(this.bucketKey(sourcePairs))].filter(Boolean);
    const lo = source[this.range] ?? source.from ?? -Infinity,
      hi = source[this.range] ?? source.to ?? Infinity;
    return {
      entries: entries.map((e) => ({
        ...e,
        index: sourceBuckets.reduce((n, b) => n + b.get('__source').rank({ key: e.index, tie: e.tie }, lo, hi), 0),
      })),
      meta: { total, next: more && entries.length ? pageCursor(scope, entries.at(-1)) : null, limit, sort: sortKey, order: direction, route },
    };
  }
}

const escapePointer = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
export function listRoute(source, path) {
  return '/list?' + new URLSearchParams({ source, path });
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

// Nested pointers address positions in the returned source page.
// Dedicated policies override the generic array route without changing row shapes.
export function projectLists(value, { source, params = new URLSearchParams(), policies = {}, primary, path = '', previewLimit = limitOf(params), atomicTuple = false, atomicPaths = [], unpagedPath } = {}) {
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
    if (Array.isArray(input) || input instanceof IndexedRows || input?.page) {
      if (tuple && input.length <= 2 && input.every(scalar)) return input.slice();
      if (pointer + '/items' === unpagedPath) return { items: input };
      const page = paginate(input, pointer + '/items');
      return { items: page.items, ...page.meta };
    }
    if (pointer === unpagedPath) return input;
    const output = {}, pages = {}, counts = {};
    for (const [key, child] of Object.entries(input)) {
      const childPath = pointer + '/' + escapePointer(key);
      if (Array.isArray(child) || child instanceof IndexedRows || child?.page) {
        if (childPath === unpagedPath) { output[key] = child; continue; }
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
    return { items: entries.map(({ row }, index) => project(row, pointer + '/' + index, true)), meta };
  };
  const output = project(value, path, atomicTuple);
  if (primary) Object.assign(output, output.pages?.[primary.slice(primary.lastIndexOf('/') + 1)]);
  return output;
}
