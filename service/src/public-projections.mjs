import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';
import { R3_RESOURCES } from './r3-settings.mjs';
import { projectionReady, projectionRevision } from './projection-state.mjs';
import { bitmapFresh } from './submitted-bitmaps.mjs';
import { publicIdentities } from '../../rules/src/trac-address.js';
import { PUBLIC_SORTS } from './public-projection-index.mjs';
import { financialBlock } from './financial-status.mjs';
import { patternCatalogId } from './mint-assets.mjs';

const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
const financialKinds = ['balances', 'mints', 'payments', 'ethereum', 'credits', 'custody', 'linkRequests', 'links', 'supply'];
function paging(params, scope, revision, settings, allowed = []) {
  const s = { ...R3_RESOURCES, ...settings }, requested = Number(params.get('limit') ?? s.patternDetailRows), limit = Math.min(requested, s.patternDetailRows);
  check(Number.isSafeInteger(requested) && requested > 0, 'page_limit');
  for (const key of params.keys()) check(['limit', 'cursor', 'order', 'sort', ...allowed].includes(key) && params.getAll(key).length === 1, 'paged_query');
  const query = [...params].filter(([k]) => !['cursor', 'limit'].includes(k)).sort(([a], [b]) => a.localeCompare(b));
  const order = params.get('order') ?? 'asc'; check(['asc', 'desc'].includes(order), 'page_order');
  let anchor;
  if (params.has('cursor')) {
    let saved; try { saved = JSON.parse(Buffer.from(params.get('cursor'), 'base64url')); } catch { throw Error('page_cursor'); }
    check(saved.scope === scope && saved.revision === revision && JSON.stringify(saved.query) === JSON.stringify(query), 'page_cursor_stale', 409);
    anchor = saved.after;
  }
  return { limit, order, anchor, maxBytes: s.publicPageBytes, cursor: after => encode({ scope, revision, query, after }) };
}
function finishPage(rows, key, p, revision, map = row => JSON.parse(row.value), extra = {}) {
  const result = { ...extra, v: 3, revision, [key]: [], total: null, next: null, nextCursor: null, limit: p.limit, order: p.order };
  let more = rows.length > p.limit;
  for (const row of rows.slice(0, p.limit)) {
    const value = map(row), next = p.cursor([row.position, row.id]);
    const candidate = { ...result, [key]: [...result[key], value], next, nextCursor: next };
    if (Buffer.byteLength(JSON.stringify(publicIdentities(candidate))) > p.maxBytes) {
      check(result[key].length, 'page_row_budget', 503); more = true; break;
    }
    result[key].push(value); result.next = result.nextCursor = next;
  }
  if (!more) result.next = result.nextCursor = null;
  return result;
}
export function itemPage(store, kind, scope, params, settings = {}, map) {
  if (kind === 'discoveries') projectionReady(store, 'discoveriesByAgent/' + scope);
  if (kind === 'finds' && scope.startsWith('owner/')) projectionReady(store, 'findsByAgent/' + scope.slice(6));
  projectionReady(store, { events: 'publicEvents', patterns: 'catalogPatterns', compounds: 'catalogTypes', agents: 'catalogAgents' }[kind] ?? kind);
  const revision = projectionRevision(store, `items/${kind}/${scope}`) + (kind === 'links' || kind === 'bitmaps' ? '/' + projectionRevision(store, 'submittedBitmaps') + '/' + projectionRevision(store, 'links') + '/' + (store.get('meta', 'head')?.hash ?? '') : kind === 'balances' ? '/' + projectionRevision(store, 'publicBalanceHeads/' + scope) + '/' + projectionRevision(store, 'accountRecords/ar/' + scope) : '') +
    (financialKinds.includes(kind) ? '/' + projectionRevision(store, 'financialHealth') : '');
  const filters = ['asset', 'owner', 'block', 'state', 'action', 'since', 'q', 'tier', 'recipe', 'firstMaker', 'discoverer', 'address', 'nonzero', 'minted', 'pending', 'linked', 'height', 'type', 'actor', 'category', 'payer', 'beneficiary', 'role', 'to', 'status', 'window', 'agent', 'header', 'kind'];
  const p = paging(params, kind + '/' + scope, revision, settings, filters);
  if (!params.has('order') && ['agents', 'events', 'finds', 'links'].includes(kind)) p.order = 'desc';
  const sorts = (PUBLIC_SORTS[kind] ?? 'id').split(' '), sort = params.get('sort') ?? sorts[0];
  check(sorts.includes(sort), 'projection_sort');
  const where = ['o.kind=?', 'o.scope=?', 'o.sort=?'], args = [kind, scope, sort];
  let index = ''; const usedFilters = new Set(['since']);
  for (const filter of ['asset', 'owner', 'block', 'state', 'action']) if (params.has(filter)) {
    if (index || kind === 'links' && filter === 'owner') continue; usedFilters.add(filter);
    const column = filter === 'action' ? 'state' : filter; where.push(`o.${column}=?`); args.push(params.get(filter)); index ||= ' INDEXED BY publicOrderV2' + column[0].toUpperCase() + column.slice(1);
  }
  if (params.has('since')) { check(kind === 'events' && sort === 'sequence', 'page_since'); where.push('o.key>?'); args.push(rules.uintKeyV2(rules.decimalV2(params.get('since')))); }
  if (p.anchor) { check(Array.isArray(p.anchor) && p.anchor.length === 2, 'page_cursor'); where.push(`(o.key,o.id)${p.order === 'asc' ? '>' : '<'}(?,?)`); args.push(...p.anchor); }
  const extra = filters.filter(k => params.has(k) && !usedFilters.has(k));
  const budget = extra.length ? Math.max(p.limit, settings.feedEventRows ?? R3_RESOURCES.feedEventRows) : p.limit;
  const rows = store.db.prepare(`SELECT o.id,r.value,o.key AS position FROM publicOrderV2 o${index} JOIN publicItemsV2 r ON r.kind=o.kind AND r.scope=o.scope AND r.id=o.id
    WHERE ${where.join(' AND ')} ORDER BY o.key ${p.order},o.id ${p.order} LIMIT ?`).all(...args, budget + 1);
  const selected = []; let last, examined = 0;
  for (const row of rows.slice(0, budget)) {
    const value = map ? map(row) : JSON.parse(row.value);
    if (kind === 'links') {
      const bitmap = store.get('submittedBitmaps', rules.uintKeyV2(rules.decimalV2(value.block))), fresh = bitmapFresh(store, bitmap);
      value.owner = fresh ? bitmap.agent : null; value.address = fresh ? bitmap.address : null; value.holderUnavailable = !fresh;
      value.ownership = fresh ? 'verified_at_snapshot' : 'unverified_or_stale';
    }
    if (kind === 'balances') {
      const account = store.get('accountRecords', 'ar/' + scope), head = store.get('publicBalanceHeads', scope);
      value.blocked = financialBlock(store, ['ar/' + scope, 'fp/chain']);
      value.current = !value.blocked && (!account || head?.root === account.root && head?.revision === account.revision);
    }
    if (financialKinds.includes(kind) && kind !== 'balances') {
      const request = value.requestId ?? value.request ?? value.id;
      value.blocked = financialBlock(store, ['fp/chain', 'fp/usage', 'fp/' + request, 'ao/' + request, 'dc/' + request,
        'fl/' + request, 'fc/' + value.id, 'bc/' + value.id,
        ...(kind === 'links' ? ['k/link/' + BigInt(value.block).toString(36)] : []), ...(kind === 'supply' ? ['ar/supply'] : [])]);
      value.current = !value.blocked;
    }
    if (kind === 'finds') value.minted = !!store.get('minted', value.asset + '/' + value.block);
    const matches = extra.every(k => {
      const expected = params.get(k);
      if (k === 'nonzero') { check(['true', 'false'].includes(expected), 'page_filter'); return (BigInt(value.amount ?? '0') !== 0n) === (expected === 'true'); }
      if (['minted', 'pending', 'linked', 'header'].includes(k)) { check(['true', 'false'].includes(expected), 'page_filter'); return !!value[k] === (expected === 'true'); }
      if (k === 'q') return [value.name, value.asset, value.id, value.address].some(v => String(v ?? '').toLowerCase().includes(expected.toLowerCase()));
      if (k === 'actor') return Object.values(value.data ?? {}).includes(expected);
      if (k === 'category') return (value.type?.startsWith('financial_') || ['mint_request', 'mint_permit', 'mint_complete', 'transfer', 'link'].includes(value.type) ? 'money' : 'chain') === expected;
      return String(value[k] ?? '') === expected;
    });
    last = row; examined++;
    if (matches) selected.push({ ...row, value: JSON.stringify(value) });
    if (selected.length > p.limit) break;
  }
  const page = finishPage(selected, kind, p, revision, undefined, { sort, examined: budget, continuationMeaning: 'bounded_index_work' });
  if (!page.next && last && examined < rows.length) page.next = page.nextCursor = p.cursor([last.position, last.id]);
  return { ...page, sort, examined, continuationMeaning: 'bounded_index_work' };
}
const stateOf = store => store.get('meta', 'ruleState');
const clocks = store => ({ tip: rules.decimalV2(store.get('meta', 'head')?.tip ?? stateOf(store).counted), counted: rules.decimalV2(stateOf(store).counted) });
export function publicProjectionRevision(store, input) {
  const url = new URL(input, 'http://localhost'), path = decodeURIComponent(url.pathname);
  const sources = { '/patterns': ['catalogPatterns'], '/table': ['catalogPatterns'], '/compounds': ['catalogTypes'], '/agents': ['catalogAgents'],
    '/finds': ['finds'], '/feed': ['publicEvents'], '/events': ['publicEvents'], '/receipts': ['receiptObservations'], '/records/batches': ['batches'], '/window-eligibility': ['windowEligibility'] };
  let scopes = sources[path], clock = false, match;
  if (path.startsWith('/payouts/')) scopes = [{ beneficiaries: 'payoutTotals', owed: 'commissionOwed', paid: 'payoutPaid' }[path.slice(9)] ?? 'payoutTotals'];
  if ((match = /^\/patterns\/([^/]+)\/(claimed-blocks|claimed-pages|blocks)$/.exec(path))) scopes = ['claimed2/' + match[1], 'claimedPageManifests/' + match[1], 'catalogPatterns/' + match[1], 'mintedAsset/' + match[1], 'links'];
  if (path === '/mint-rights' || path.endsWith('/mintRights')) { scopes = ['finds', 'links', 'minted', 'holds', 'replay/mints/holds', 'submittedBitmaps', 'publicBalances', 'publicBalanceHeads', 'publicDeployments', 'meta/publicRegistryRevision', 'accountRecords', 'financialHealth']; clock = true; }
  if (path.startsWith('/world') || /^\/blocks(?:\/|$)/.test(path) && !path.endsWith('/mintRights')) { scopes = ['world', 'finds', 'publicEvents', 'links', 'minted']; clock = true; }
  if ((match = /^\/agents\/([0-9a-f]{64})(?:\/(\w+))?$/.exec(path)) && match[2] !== 'mintRights') {
    const [, owner, kind] = match;
    scopes = kind ? [`items/${kind === 'history' ? 'events' : kind}/${kind === 'finds' ? 'owner/' : ''}${owner}`, { finds: 'findsByAgent/', discoveries: 'discoveriesByAgent/', assets: 'agentAssets/' }[kind] + owner] : ['catalogAgents/' + owner, 'agent/' + owner];
    if (kind === 'bitmaps') { scopes.push('links'); clock = true; }
    if (kind === 'balances') scopes.push('publicBalanceHeads/' + owner, 'accountRecords/ar/' + owner, 'financialHealth');
  }
  if ((match = /^\/accounts\/([0-9a-f]{64})\//.exec(path))) scopes = ['accountRecords/ar/' + match[1]];
  if (path.startsWith('/results')) { clock = true; scopes = ['mints', 'linkRequests', 'links', 'submittedBitmaps', 'payoutTotals', 'commissionOwed', 'payoutPaid', 'publicSummaries', 'publicSupply', 'financialHealth', 'publicFinancialHealth', ...['mints', 'payments', 'ethereum', 'credits', 'custody', 'linkRequests'].map(k => 'publicResults/' + k)]; }
  if (!scopes) return null;
  return scopes.map(s => projectionRevision(store, s)).join('/') + (clock ? '/' + JSON.stringify(clocks(store)) + '/' + (store.get('meta', 'head')?.hash ?? '') : '');
}
function plot(store, height) {
  const mark = store.db.prepare('SELECT * FROM publicBlocksV2 WHERE heightKey=?').get(rules.uintKeyV2(height));
  return { height, ...rules.heightToPlotV2(height), region: String(BigInt(height) / 2016n), halving: String(BigInt(height) / 210000n),
    found: !!mark?.finds, findCount: String(mark?.finds ?? 0), minted: !!mark?.mints, linked: !!mark?.linked,
    claimable: rules.compareUint(height, clocks(store).counted) <= 0 };
}
function world(store, params, settings, map = false) {
  projectionReady(store, 'world');
  const clock = clocks(store), revision = projectionRevision(store, 'world') + '/' + clock.tip + '/' + clock.counted;
  const p = paging(params, map ? 'map' : 'world', revision, settings, ['from', 'to', 'found', 'minted', 'linked']);
  const from = rules.decimalV2(params.get('from') ?? '0'), to = rules.decimalV2(params.get('to') ?? clock.tip);
  check(rules.compareUint(from, to) <= 0 && rules.compareUint(to, clock.tip) <= 0, 'world_range');
  check(!params.has('sort') || ['height', 'region', 'halving'].includes(params.get('sort')), 'projection_sort');
  if (!params.has('order') && !map) p.order = 'desc';
  const filters = ['found', 'minted', 'linked'].filter(k => params.has(k));
  for (const k of filters) check(['true', 'false'].includes(params.get(k)), 'world_filter');
  const sparse = map && !filters.some(k => params.get(k) === 'false') || filters.length && filters.every(k => params.get(k) === 'true');
  const budget = filters.length ? Math.max(p.limit, settings.feedEventRows ?? R3_RESOURCES.feedEventRows) : p.limit, heights = [];
  if (sparse) {
    const where = ['heightKey>=?', 'heightKey<=?'], args = [rules.uintKeyV2(from), rules.uintKeyV2(to)];
    if (p.anchor) { check(Array.isArray(p.anchor) && p.anchor.length === 2, 'page_cursor'); where.push(`heightKey${p.order === 'asc' ? '>' : '<'}?`); args.push(p.anchor[0]); }
    for (const r of store.db.prepare(`SELECT height FROM publicBlocksV2 WHERE ${where.join(' AND ')} ORDER BY heightKey ${p.order} LIMIT ?`).all(...args, budget + 1)) heights.push(r.height);
  } else {
    let h = p.anchor ? BigInt(p.anchor[1]) + (p.order === 'asc' ? 1n : -1n) : BigInt(p.order === 'asc' ? from : to);
    while (heights.length <= budget && h >= BigInt(from) && h <= BigInt(to)) { heights.push(String(h)); h += p.order === 'asc' ? 1n : -1n; }
  }
  const selected = []; let last, examined = 0;
  for (const height of heights.slice(0, budget)) {
    const value = plot(store, height); examined++; last = height;
    if (filters.every(k => value[k] === (params.get(k) === 'true'))) selected.push({ id: height, position: rules.uintKeyV2(height), value: JSON.stringify(value) });
    if (selected.length > p.limit) break;
  }
  const page = finishPage(selected, map ? 'marks' : 'plots', p, revision, undefined, { ...clock, from, to, examined: budget });
  if (!page.next && last !== undefined && examined < heights.length) page.next = page.nextCursor = p.cursor([rules.uintKeyV2(last), last]);
  return { ...page, examined };

}
function rights(store, owner, params, settings, onlyBlock) {
  check(/^[0-9a-f]{64}$/.test(owner ?? ''), 'agent_key');
  const clock = clocks(store), revision = ['finds', 'links', 'minted', 'holds', 'replay/mints/holds', 'submittedBitmaps', 'publicBalances', 'publicDeployments', 'meta/publicRegistryRevision', 'publicBalanceHeads/' + owner, 'accountRecords', 'financialHealth'].map(s => projectionRevision(store, s)).join('/') + '/' + clock.counted + '/' + (store.get('meta', 'head')?.hash ?? '');
  const blocked = financialBlock(store, ['ar/' + owner, 'ar/supply', 'fp/chain']);
  const p = paging(params, 'rights/' + owner + '/' + (onlyBlock ?? ''), revision, settings, ['asset', 'block', 'allowed', 'whoMayMint', 'reason', 'minted', 'pending']);
  check(!params.has('sort') || params.get('sort') === 'block', 'projection_sort');
  const block = onlyBlock ?? params.get('block'), namedAsset = params.get('asset');
  if (namedAsset) check(rules.assetIdV2(namedAsset) || /^p[0-9a-z]{1,23}$/.test(namedAsset), 'asset');
  const compoundsPhase = p.anchor?.[0] === 'compounds';
  const filtering = ['allowed', 'reason', 'whoMayMint', 'minted', 'pending'].some(k => params.has(k));
  for (const key of ['allowed', 'minted', 'pending']) if (params.has(key)) check(['true', 'false'].includes(params.get(key)), 'rights_filter');
  const budget = Math.max(p.limit, filtering ? settings.feedEventRows ?? R3_RESOURCES.feedEventRows : p.limit);
  const rows = []; let workAfter = null, candidateWork = 0, candidateMore = false;
  // The outer seek is through this owner's asset keys. No global find/catalog
  // traversal or fanout over other owners is part of an owner-wide read.
  if (namedAsset && block != null && patternCatalogId(namedAsset)) {
    // First mint names an exact block. Read its accepted find directly, also
    // for imported pN finds omitted from older publicRightsV2 indexes. No
    // index rebuild, global scan or catalog-to-ledger relabeling is needed.
    const catalogAsset = patternCatalogId(namedAsset), pattern = store.get('patternsByAsset', catalogAsset);
    const ledger = pattern?.legacy?.asset ?? catalogAsset, height = rules.decimalV2(block);
    check(namedAsset === catalogAsset || namedAsset === ledger, 'asset');
    const id = rules.findIdV2(height, catalogAsset.slice(3)), find = store.get('finds', id);
    if (!p.anchor && find && find.asset === ledger) rows.push({ id, position: [ledger, rules.uintKeyV2(height)], value: JSON.stringify(find) });
    candidateWork = 1;
  } else if (!compoundsPhase && !namedAsset?.startsWith('c2:')) {
    const anchor = p.anchor?.[0];
    check(!anchor || Array.isArray(anchor) && anchor.length === 2 && anchor.every(x => typeof x === 'string'), 'page_cursor');
    // Pattern balances: p2:N and imported v1 ledger assets such as p0 (all sort between 'p' and 'q').
    const afterAsset = anchor?.[0] ?? 'p';
    const assets = namedAsset ? [{ asset: namedAsset }] : store.db.prepare("SELECT asset FROM publicBalancesV2 WHERE owner=? AND asset>=? AND asset>='p' AND asset<'q' ORDER BY asset LIMIT ?").all(owner, afterAsset, budget + 1);
    for (const { asset } of assets.slice(0, budget)) {
      if (candidateWork >= budget || rows.length > budget) { candidateMore = true; break; }
      candidateWork++;
      const where = ['asset=?'], args = [asset];
      if (block != null) { where.push('heightKey=?'); args.push(rules.uintKeyV2(rules.decimalV2(block))); }
      if (anchor?.[0] === asset) { where.push(`(heightKey,id)${p.order === 'asc' ? '>' : '<'}(?,?)`); args.push(anchor[1], p.anchor[1]); }
      const part = store.db.prepare(`SELECT id,heightKey,value FROM publicRightsV2 INDEXED BY publicRightsV2Asset WHERE ${where.join(' AND ')} ORDER BY heightKey ${p.order},id ${p.order} LIMIT ?`).all(...args, budget + 1 - rows.length);
      rows.push(...part.map(r => ({ ...r, position: [asset, r.heightKey] })));
      workAfter = [[asset, p.order === 'asc' ? '~' : ''], p.order === 'asc' ? '~' : ''];
      if (rows.length > budget) { candidateMore = true; break; }
    }
    if (assets.length > candidateWork) candidateMore = true;
  }
  const hydrate = r => {
    const f = JSON.parse(r.value), link = store.get('links', heightKey(f.block)), bitmap = store.get('submittedBitmaps', rules.uintKeyV2(rules.decimalV2(f.block))), fresh = bitmapFresh(store, bitmap);
    const exclusive = rules.compareUint(clock.counted, rules.decimalV2(f.finderUntil)) < 0;
    const role = exclusive ? 'finder' : link && rules.compareUint(rules.decimalV2(link.linkHeight), rules.decimalV2(f.findHeight)) < 0 ? 'bitmap' : 'public';
    const rightAllowed = role === 'finder' ? f.finder === owner : role === 'bitmap' ? fresh ? bitmap.agent === owner : null : true;
    const balance = store.get('publicBalances', owner + '/' + f.asset), account = store.get('accountRecords', 'ar/' + owner);
    const balanceHead = store.get('publicBalanceHeads', owner) ?? balance;
    const balanceKnown = !account || balanceHead?.root === account.root && balanceHead?.revision === account.revision;
    const amount = balanceKnown ? balance?.amount ?? '0' : null;
    const minted = store.get('minted', f.asset + '/' + f.block), hold = store.get('holds', f.asset + '/' + f.block) ?? store.get('replay/mints/holds', f.asset + '/' + f.block);
    const pending = hold && (hold.safeToReplace === false || rules.compareUint(rules.decimalV2(hold.expiry), clock.counted) >= 0);
    const deployment = store.get('publicDeployments', f.asset), registryRevision = store.get('meta', 'publicRegistryRevision');
    const registered = deployment && (registryRevision == null || deployment.registryRevision === registryRevision) ? !deployment.suspended : null;
    const allowed = !!(!blocked && rightAllowed && registered && amount !== null && BigInt(amount) >= BigInt(f.count) && !minted && !pending);
    return { ...f, find: f, link: link ?? null, amount: String(f.count), balance: amount, finderUntil: rules.decimalV2(f.finderUntil), right: role, whoMayMint: role,
      eligible: rightAllowed, rightAllowed, allowed, deploymentRegistered: registered, minted, pending: pending ? { id: hold.id, expiry: hold.expiry } : null,
      currentHolder: fresh ? bitmap.agent : null, ownership: fresh ? 'verified_at_snapshot' : 'unverified_or_stale',
      reason: blocked ?? (minted ? 'minted' : pending ? 'pending' : !registered ? 'asset_unregistered' : amount === null ? 'balance_projection_pending' : BigInt(amount) < BigInt(f.count) ? 'insufficient_balance' : rightAllowed === null ? 'holder_unavailable' : role),
      authorization: 'recheck_named_item' };
  };
  const selected = []; let last, examined = 0;
  for (const row of rows.slice(0, budget)) {
    const value = hydrate(row); examined++; last = row;
    const matches = ['allowed', 'minted', 'pending'].every(k => !params.has(k) || !!value[k] === (params.get(k) === 'true')) &&
      (!params.has('reason') || value.reason === params.get('reason')) &&
      (!params.has('whoMayMint') || (params.get('whoMayMint') === 'me' ? value.allowed : params.get('whoMayMint') === 'none' ? !value.allowed : value.whoMayMint === (params.get('whoMayMint') === 'landowner' ? 'bitmap' : params.get('whoMayMint'))));
    if (matches) selected.push({ ...row, value: JSON.stringify(value) });
    if (selected.length > p.limit) break;
  }
  const page = finishPage(selected, 'mintRights', p, revision, undefined, { owner, examined: budget, candidateWork, scope: namedAsset ? 'named_asset' : 'owned_balance_assets', ordering: 'asset_then_block', continuationMeaning: 'bounded_index_work', implicitAwards: '/window-eligibility' });
  if (!page.nextCursor && last && examined < rows.length) page.next = page.nextCursor = p.cursor([last.position, last.id]);
  if (!page.nextCursor && candidateMore && workAfter) page.next = page.nextCursor = p.cursor(workAfter);
  if (!page.next && block == null && !params.get('asset')?.startsWith('p2:')) {
    // Compound rights come from this owner's balance keys, never the catalog.
    const after = compoundsPhase ? p.anchor[1] : '', remaining = p.limit - page.mintRights.length;
    if (!remaining) page.next = page.nextCursor = p.cursor(['compounds', after]);
    else {
      const candidates = store.db.prepare(`SELECT asset,amount FROM publicBalancesV2 WHERE owner=? AND asset>? AND asset>='c2:' AND asset<'c2;' ${params.has('asset') ? 'AND asset=?' : ''} ORDER BY asset LIMIT ?`).all(owner, after, ...(params.has('asset') ? [params.get('asset')] : []), budget + 1);
      let visited = 0, lastAsset = after;
      for (const balance of candidates.slice(0, budget)) {
        visited++; lastAsset = balance.asset;
        const deployment = store.get('publicDeployments', balance.asset), account = store.get('accountRecords', 'ar/' + owner), head = store.get('publicBalanceHeads', owner);
        const known = !account || head?.root === account.root && head?.revision === account.revision;
        const registryRevision = store.get('meta', 'publicRegistryRevision'), registered = !!deployment && (registryRevision == null || deployment.registryRevision === registryRevision) && !deployment.suspended;
        const allowed = !!(!blocked && known && registered && BigInt(balance.amount) > 0n);
        const value = { asset: balance.asset, block: null, amount: balance.amount, balance: known ? balance.amount : null, compound: true,
          allowed, rightAllowed: true, eligible: true, whoMayMint: 'holder', right: 'holder', reason: blocked ?? (!known ? 'balance_projection_pending' : !registered ? 'asset_unregistered' : BigInt(balance.amount) === 0n ? 'insufficient_balance' : 'holder'),
          minted: null, pending: null, finderUntil: null, deploymentRegistered: registered, authorization: 'recheck_named_item' };
        if (params.has('allowed') && allowed !== (params.get('allowed') === 'true') || params.has('reason') && value.reason !== params.get('reason') || params.has('minted') && params.get('minted') === 'true' || params.has('pending') && params.get('pending') === 'true') continue;
        const role = params.get('whoMayMint');
        if (role && !(role === 'holder' || role === 'me' && allowed || role === 'none' && !allowed)) continue;
        if (page.mintRights.length === p.limit || Buffer.byteLength(JSON.stringify({ ...page, mintRights: [...page.mintRights, value] })) > p.maxBytes - 1024) {
          page.next = page.nextCursor = p.cursor(['compounds', page.mintRights.filter(r => r.compound).at(-1)?.asset ?? after]); break;
        }
        page.mintRights.push(value);
      }
      if (!page.next && visited < candidates.length) page.next = page.nextCursor = p.cursor(['compounds', lastAsset]);
      examined += visited;
    }
  }
  return { ...page, owner, examined, continuationMeaning: 'bounded_index_work', candidateWork, scope: namedAsset ? 'named_asset' : 'owned_balance_assets', ordering: 'asset_then_block', implicitAwards: '/window-eligibility' };
}
export function extendedPublicRead(store, url, settings = {}) {
  projectionReady(store);
  const path = decodeURIComponent(url.pathname), params = url.searchParams;
  if (['/patterns', '/table', '/compounds', '/agents'].includes(path)) return itemPage(store, path === '/table' ? 'patterns' : path.slice(1), '', params, settings);
  const ownerRights = /^\/agents\/([0-9a-f]{64})\/mintRights$/.exec(path), blockRights = /^\/blocks\/(0|[1-9][0-9]*)\/mintRights$/.exec(path);
  if (path === '/mint-rights' || ownerRights || blockRights) {
    const query = new URLSearchParams(params); query.delete('owner');
    return rights(store, ownerRights?.[1] ?? params.get('owner'), query, settings, blockRights?.[1]);
  }
  if (['/world', '/blocks', '/world/map'].includes(path)) return world(store, params, settings, path.endsWith('/map'));
  const block = /^\/blocks\/(0|[1-9][0-9]*)(?:\/(finds|claims|draws|matches|slotList))?$/.exec(path);
  if (block) {
    check(rules.compareUint(block[1], clocks(store).tip) <= 0, 'block_not_found', 404);
    if (block[2] === 'finds') return itemPage(store, 'finds', 'block/' + block[1], params, settings);
    if (['claims', 'draws'].includes(block[2])) return itemPage(store, block[2], block[1], params, settings);
    if (block[2]) {
      projectionReady(store, 'block/' + block[1]);
      const p = paging(params, 'block/' + block[1] + '/' + block[2], projectionRevision(store, 'claimedAt2/' + rules.uintKeyV2(block[1])), settings);
      const space = 'claimedAt2/' + rules.uintKeyV2(block[1]), after = p.anchor?.[1];
      const rows = store.db.prepare(`SELECT id,value FROM records WHERE space=? ${after ? 'AND id' + (p.order === 'asc' ? '>' : '<') + '?' : ''} ORDER BY id ${p.order} LIMIT ?`).all(space, ...(after ? [after] : []), p.limit + 1);
      return { countMeaning: 'verified_submitted_blocks', ...finishPage(rows.map(r => ({ ...r, position: r.id })), block[2], p, projectionRevision(store, 'claimedAt2/' + rules.uintKeyV2(block[1])), r => ({ asset: r.id, ...store.get('claimed2/' + r.id, rules.uintKeyV2(block[1])) })) };
    }
    const clock = clocks(store), window = clock.tip;
    return { v: 3, ...plot(store, block[1]), header: store.get('headers', heightKey(block[1]))?.fields ?? null,
      window, claimWindow: { window, closesAt: rules.addUint(window, '2'), drawAt: rules.addUint(window, '2'), settlesAt: rules.addUint(window, '2'), claimable: rules.compareUint(block[1], clock.counted) <= 0 },
      collections: Object.fromEntries(['finds', 'claims', 'draws', 'matches', 'slotList', 'mintRights'].map(k => [k, path + '/' + k])) };
  }
  const agent = /^\/agents\/([0-9a-f]{64})\/(balances|bitmaps|history|finds|discoveries)$/.exec(path);
  if (agent) {
    const kind = agent[2] === 'history' ? 'events' : agent[2];
    const page = itemPage(store, kind, kind === 'finds' ? 'owner/' + agent[1] : agent[1], params, settings, kind === 'bitmaps' ? r => { const b = JSON.parse(r.value); return { ...b, linked: !!store.get('links', heightKey(b.block)), current: bitmapFresh(store, b) }; } : undefined);
    if (agent[2] === 'history') { page.history = page.events; delete page.events; }
    return { ...page, ...(kind === 'bitmaps' ? { completeness: 'submitted_items_only', submit: '/bitmaps/submit' } : {}) };
  }
  if (['/finds', '/events', '/feed'].includes(path)) return itemPage(store, path === '/finds' ? 'finds' : 'events', '', params, settings);
  const event = /^\/(?:events|feed)\/(0|[1-9][0-9]*)$/.exec(path);
  if (event) { const value = store.get('publicEvents', heightKey(event[1])); check(value, 'event_not_found', 404); return value; }
  const kinds = ['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links', 'credits', 'custody', 'linkRequests', 'supply'];
  if (path === '/results') return { v: 3, unit: rules.TAP_UNIT, counts: Object.fromEntries(kinds.map(k => [k, store.db.prepare("SELECT n FROM publicItemCountsV2 WHERE kind=? AND scope=''").get(k)?.n ?? '0'])), collections: Object.fromEntries(kinds.map(k => [k, '/results/' + k])),
    treasury: store.get('publicSummaries', 'treasury'), burn: store.get('publicSummaries', 'burn'),
    outstandingSupply: { ...store.get('publicSummaries', 'outstandingSupply'), ...store.get('publicSummaries', 'externalSupply') },
    financialRecovery: store.get('accountRecords', 'fr/active') ?? store.get('meta', 'financialRecoveryActive') ?? null,
    quarantined: store.get('publicFinancialHealth', 'quarantined') ?? '0', verification: 'accepted_deltas_and_labelled_source_snapshots' };
  if (path.startsWith('/results/') && kinds.includes(path.slice(9))) return { unit: rules.TAP_UNIT, ...itemPage(store, path.slice(9), '', params, settings) };
  return undefined;
}
