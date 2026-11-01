import { validateTracAddress, publicIdentities, tracReadRoute } from '../../rules/src/trac-address.js';
import { check, integer } from './check.mjs';
import { patternId, nextCursor, isAsset } from './api-values.mjs';

const numeric = new Set(['limit', 'height', 'from', 'to', 'block', 'since', 'window']);
const boolean = new Set(['found', 'linked', 'minted', 'allowed', 'pending', 'nonzero', 'positive', 'header']);
const strings = new Set(['cursor', 'sort', 'order', 'asset', 'owner', 'address', 'tapAddress', 'agent', 'actor', 'discoverer', 'firstMaker', 'tier', 'recipe', 'reason', 'whoMayMint', 'q', 'type', 'category', 'state', 'kind', 'action', 'status', 'payer', 'beneficiary', 'role', 'source', 'path', 'deployment']);

// Only scalars reach URLSearchParams; a cursor remains an opaque value.
export function readQuery(options = {}) {
  check(options && typeof options === 'object' && !Array.isArray(options), 'Invalid read options');
  const query = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (key === 'to' && typeof value === 'string') check(value.length <= 2048, 'Invalid recipient');
    else if (numeric.has(key)) check((integer(value) || key !== 'limit' && typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) && (key !== 'limit' || value >= 1 && value <= 200), 'Invalid ' + key);
    else if (boolean.has(key)) check(typeof value === 'boolean', 'Invalid ' + key);
    else {
      check(strings.has(key) && typeof value === 'string' && value.length <= (key === 'cursor' || key === 'source' ? 8192 : 2048), 'Invalid read parameter: ' + key);
      if (key === 'order') check(['asc', 'desc'].includes(value), 'Invalid order');
      if (key === 'deployment') check(/^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(value), 'Invalid deployment');
      if (['owner', 'address', 'agent', 'actor', 'discoverer', 'firstMaker'].includes(key)) validateTracAddress(value);
    }
    query[key] = String(value);
  }
  return query;
}

export function publicRoute(route, depth = 0) {
  check(typeof route === 'string' && route.length <= 16384 && depth < 3 && route.startsWith('/') && !route.startsWith('//') && !/[#\\\s]/.test(route), 'Invalid public read route');
  const [encodedPath, ...search] = route.split('?');
  // Account links encode the colon in p2:/c2: identities. Decode only that
  // delimiter; encoded slashes, traversal and origins remain forbidden.
  const path = encodedPath.replace(/%3a/gi, ':');
  check(search.length <= 1 && /^\/[a-zA-Z0-9/:_.-]+$/.test(path) && !path.includes('..') && !path.includes('//'), 'Invalid public read path');
  check(/^\/(?:status|world|blocks|patterns|table|compounds|finds|receipts|mint-rights|public-mints|payout-bindings|payouts|agents|accounts|events|feed|results|links|list|records|latest|window-eligibility|windows)(?:$|\/|\.json$)/.test(path) || /^\/mint\/[0-9a-f]{64}$/.test(path), 'Not a public collection route');
  tracReadRoute(path + (search.length ? '?' + search[0] : ''));
  const query = {}, params = new URLSearchParams(search[0]);
  for (const [key, value] of params) {
    check(!Object.hasOwn(query, key), 'Duplicate read parameter');
    if (key === 'to' && !/^(0|[1-9][0-9]*)$/.test(value)) query[key] = value;
    else if (numeric.has(key)) { check(/^(0|[1-9][0-9]*)$/.test(value), 'Invalid ' + key); query[key] = key === 'limit' ? Number(value) : value; }
    else if (boolean.has(key)) { check(['true', 'false'].includes(value), 'Invalid ' + key); query[key] = value === 'true'; }
    else query[key] = value;
  }
  if (path === '/list') {
    check(typeof query.source === 'string' && typeof query.path === 'string' && (query.path === '' || query.path.startsWith('/')) && !/~(?![01])/.test(query.path), 'Invalid nested collection');
    publicRoute(query.source, depth + 1);
  } else check(query.source === undefined && query.path === undefined, 'Nested parameters require /list');
  return { path, query: readQuery(query) };
}

const TAP = Object.freeze({ currency: 'TAP', denomination: 'atomic', decimals: 18 });
const SAT = Object.freeze({ currency: 'BTC', denomination: 'satoshi', decimals: 0 });
const matter = asset => ({ currency: asset ?? 'matter', denomination: 'unit', decimals: 0 });
const decimal = v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) || integer(v);
const pointer = v => String(v).replaceAll('~', '~0').replaceAll('/', '~1');
const fees = new Set(['price', 'baseFee', 'accrued', 'paid', 'owed', 'burn', 'treasury', 'treasuryAccrued', 'burned', 'totalPaid', 'totalOwed']);
const quantities = new Set(['amount', 'balance', 'supply', 'madeReal', 'unitsUsed', 'count', 'remaining']);

export function amountView(value, unit) {
  check(decimal(value), 'Invalid read amount');
  check(integer(unit.decimals) && unit.decimals <= 18, 'Invalid amount decimals');
  check(unit.denomination !== 'satoshi' || unit.decimals === 0, 'Satoshi amounts require zero decimals');
  const amount = String(value), digits = unit.decimals;
  const padded = amount.padStart(digits + 1, '0');
  const fraction = digits ? padded.slice(-digits).replace(/0+$/, '') : '';
  const display = digits ? padded.slice(0, -digits) + (fraction ? '.' + fraction : '') : amount;
  return { amount, unit, human: `${display} ${unit.denomination === 'satoshi' ? 'sat' : unit.currency === 'TAP' ? 'TAP' : unit.currency + ' units'}` };
}

// Keep the protocol data (including signed quote bytes) intact. JSON pointers
// identify exact display values without changing wire amounts or proof objects.
export function presentRead(value, { route = '', contextPath = '', asset } = {}) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid public read response');
  const amounts = {};
  const walk = (node, path, context = {}) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.length === 2 && isAsset(node[0]) && /^[pc]/.test(node[0]) && decimal(node[1])) {
        amounts[path + '/1'] = amountView(node[1], matter(node[0])); return;
      }
      node.forEach((row, i) => walk(row, path + '/' + i, context)); return;
    }
    const ownAsset = node.asset ?? (isAsset(node.id) && /^[pc]/.test(node.id) ? node.id : undefined) ??
      (decimal(node.number) ? patternId(node) : undefined) ?? context.asset;
    const monetary = context.monetary || /\/(?:payments|ethereum|payouts|owed|paid|split|feeDestinations|feePolicy|treasury|burn|outstandingSupply)(?:\/|$)/.test(path);
    for (const [key, child] of Object.entries(node)) {
      if (['amounts', 'pages', 'pagination', 'counts', 'listCounts', 'provenance', 'receipt', 'feeQuote'].includes(key)) continue;
      const next = path + '/' + pointer(key);
      if (decimal(child)) {
        let unit;
        if (key === 'networkFeeSats') unit = SAT;
        else if (key === 'total' && (path === '' || Object.hasOwn(node, 'next') && Object.hasOwn(node, 'limit'))) continue;
        else if (fees.has(key) || monetary && (['amount', 'balance', 'total', 'base', 'amt', 'tap', 'ethereum', 'erc20'].includes(key) || /\/split$/.test(path))) unit = TAP;
        else if (quantities.has(key) && (ownAsset || key === 'unitsUsed')) unit = matter(ownAsset);
        if (unit) amounts[next] = amountView(child, unit);
      } else walk(child, next, { asset: ownAsset, monetary });
    }
  };
  asset ??= /^\/patterns\/([a-z0-9:]+)\/(?:claimed-blocks|blocks)/.exec(route)?.[1];
  walk(value, '', { asset, monetary: /^\/results\/(payments|ethereum|payouts|owed|paid)(?:\?|$)/.test(route) || /^\/(payments|ethereum|payouts|owed|paid|treasury|burn|outstandingSupply)(?:\/|$)/.test(contextPath) });
  // `next` is a page cursor on lists; on action answers it is the list of next tool steps.
  const paged = Object.hasOwn(value, 'nextCursor') || Object.hasOwn(value, 'next') && !Array.isArray(value.next);
  return publicIdentities({ ...value, ...(paged ? { next: nextCursor(value) } : {}), amounts });
}
