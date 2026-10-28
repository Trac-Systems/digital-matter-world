import { publicIdentities, tracReadRoute } from '../../rules/src/trac-address.js';
import { readFile } from 'node:fs/promises';
import { check, hash } from './util.mjs';
import { R3_RESOURCES } from './r3-settings.mjs';
import { rules } from './rules.mjs';
import { claimedPage } from './claimed-feeds.mjs';
import { claimedPublicRead } from './claimed-public.mjs';
import { extendedPublicRead, publicProjectionRevision } from './public-projections.mjs';
import { agentSpecs, blockSpecs, collectionSpecs, eventSpec, patternBlocksSpec, resultSpecs } from './read-specs.mjs';
import { genericSpec, limitOf, listRoute, numberFilter, pageRows, pointerValue, projectLists } from './paging.mjs';

const notFound = () => { throw Object.assign(Error('not_found'), { status: 404 }); };
const immutablePath = path => /^\/(?:blocks|receipts)\/.+\.(?:json|bin)$/.test(path) || /-[0-9a-f]{64}\.json$/.test(path);
const staticPath = path => /^\/(?:blocks|receipts|patterns|records)\/[a-zA-Z0-9/:_.-]+\.(?:json|bin)$/.test(path) && immutablePath(path) || path === '/latest.json';
const withRoute = (spec, route) => ({ ...spec, route });
const policiesFor = (specs, base, suffix = '') => Object.fromEntries(Object.entries(specs).map(([key, spec]) => ['/' + key, withRoute(spec, base + '/' + key + suffix)]));
const normalize = input => {
  const url = new URL(input, 'http://127.0.0.1');
  if (url.pathname.endsWith('/') && url.pathname !== '/') url.pathname = url.pathname.slice(0, -1);
  if (url.pathname === '/results' && url.searchParams.has('kind')) {
    const kind = url.searchParams.get('kind'); check(url.searchParams.getAll('kind').length === 1 && Object.hasOwn(resultSpecs, kind), 'invalid_result_kind');
    url.pathname += '/' + kind; url.searchParams.delete('kind');
  }
  return url;
};

export function createPublicAPI({ views, files, settings = {} }) {
  const raw = async url => {
    const path = url.pathname, params = url.searchParams;
    if (path === '/status') return views.status();
    if (path === '/records/batches') return { batches: views.batches() };
    if (/^\/records\/batches\/\d+$/.test(path)) return views.batch(numberFilter(path.split('/')[3]));
    if (['/patterns', '/table'].includes(path)) return views.catalog();
    if (path === '/compounds') return { compounds: (await views.catalog()).compounds };
    if (['/world', '/blocks'].includes(path)) return views.world(params.has('from') ? numberFilter(params.get('from')) : undefined, params.has('to') ? numberFilter(params.get('to')) : undefined);
    if (path === '/finds') return { finds: views.finds() };
    if (path === '/receipts') return { receipts: views.receipts() };
    if (path === '/agents') return { agents: views.agents() };
    if (path === '/mint-rights') { check(params.has('owner'), 'owner_required'); return { mintRights: await views.rights(params.get('owner')) }; }
    if (['/events', '/feed'].includes(path)) return { events: views.events() };
    if (/^\/(?:events|feed)\/\d+$/.test(path)) return views.events().find(e => e.sequence === Number(path.split('/')[2])) ?? notFound();
    if (path === '/results') return views.results();
    const result = /^\/results\/([a-z]+)$/.exec(path);
    if (result && Object.hasOwn(resultSpecs, result[1])) return { unit: rules.TAP_UNIT, [result[1]]: await views.resultList(result[1]) };
    const pattern = /^\/patterns\/([a-z0-9]{1,24})\/blocks$/.exec(path);
    if (pattern) return views.patternBlocks(pattern[1]);
    const agent = /^\/agents\/([0-9a-f]{64})(?:\/([a-zA-Z]+))?$/.exec(path);
    if (agent) {
      if (!agent[2]) return views.profile(agent[1]);
      if (!Object.hasOwn(agentSpecs, agent[2])) return notFound();
      return { [agent[2]]: await views.agentList(agent[1], agent[2]) };
    }
    const block = /^\/blocks\/(\d+)(?:\/([a-zA-Z]+))?$/.exec(path);
    if (block) {
      if (block[2] && !Object.hasOwn(blockSpecs, block[2])) return notFound();
      const value = await views.block(numberFilter(block[1]), params.get('owner') ?? undefined);
      return block[2] ? { [block[2]]: value[block[2]] } : value;
    }
    if (/^\/mint\/[0-9a-f]{64}$/.test(path)) return views.mints.public(path.slice(6));
    if (staticPath(path)) {
      try { const bytes = await readFile(files.path(path.slice(1))); return path.endsWith('.bin') ? rules.decodeBinary(bytes) : JSON.parse(bytes); }
      catch (error) { if (error.code === 'ENOENT') return notFound(); throw error; }
    }
    return notFound();
  };
  const read = async (input, { unpagedPath, depth = 0 } = {}) => {
    check(depth < 3, 'invalid_list_source');
    const url = normalize(input), path = url.pathname, params = new URLSearchParams(url.searchParams), source = path + url.search;
    const pageSettings = { ...settings, publicPageBytes: (settings.publicPageBytes ?? R3_RESOURCES.publicPageBytes) - Buffer.byteLength(JSON.stringify({ route: path })) - 128 };
    const claimed = /^\/patterns\/(p[0-9a-z]+|p2:(?:0|[1-9][0-9]*))\/claimed-blocks$/.exec(decodeURIComponent(path));
    if (claimed) return claimedPage(views.store, claimed[1], params, pageSettings);
    if (views.store?.get('meta', 'ruleState')?.batchVersion === 2) {
      const extended = extendedPublicRead(views.store, url, pageSettings); if (extended !== undefined) return extended;
      const projected = claimedPublicRead(views.store, url, pageSettings); if (projected !== undefined) return projected;
      if (!(path === '/status' || path === '/list' || /^\/mint\/[0-9a-f]{64}$/.test(path) || staticPath(path))) return notFound();
    }
    if (path === '/world/map') {
      for (const key of params.keys()) check(['from', 'to'].includes(key) && params.getAll(key).length === 1, 'world_map_query');
      // A bounded canvas projection, not a pageable collection of full plots.
      return views.worldMap(params.has('from') ? numberFilter(params.get('from')) : undefined, params.has('to') ? numberFilter(params.get('to')) : undefined);
    }
    if (path === '/list') {
      const sourcePath = params.get('source'), pointer = params.get('path');
      check(typeof sourcePath === 'string' && sourcePath.startsWith('/') && !sourcePath.startsWith('//') && pointer !== null && params.getAll('source').length === 1 && params.getAll('path').length === 1, 'invalid_list_source');
      const sourceURL = normalize(new URL(sourcePath, url.origin));
      check(sourceURL.origin === url.origin && !sourceURL.hash && !sourcePath.includes('..'), 'invalid_list_source');
      // Rights have dedicated indexed routes and no pageable nested arrays.
      // Refuse aliases too, before a raw profile/block can materialize rights.
      const rightsSource = sourceURL.pathname === '/mint-rights' || /^\/(?:agents\/[0-9a-f]{64}|blocks\/\d+)\/mintRights$/.test(sourceURL.pathname) ||
        /^\/(?:agents\/[0-9a-f]{64}|blocks\/\d+)$/.test(sourceURL.pathname) && /^\/mintRights(?:\/|$)/.test(pointer);
      check(!rightsSource, 'list_source_has_dedicated_route');
      params.delete('source'); params.delete('path'); limitOf(params);
      const sourceValue = staticPath(sourceURL.pathname) ? await raw(sourceURL) : await read(sourcePath, { unpagedPath: pointer, depth: depth + 1 });
      const rows = pointerValue(sourceValue, pointer); check(Array.isArray(rows), 'list_path_not_array');
      const { entries, meta } = pageRows(rows, params, genericSpec(rows, listRoute(sourcePath, pointer)));
      if (unpagedPath === '/items') return { items: rows };
      return { items: entries.map(({ row }, index) => projectLists(row, { source, path: '/items/' + index, previewLimit: meta.limit, atomicTuple: true, unpagedPath })), ...meta };
    }
    let primary, policies = {}, suffix = '';
    if (path === '/mint-rights' || /^\/blocks\/\d+(?:\/[^/]+)?$/.test(path)) {
      if (params.has('owner')) {
        check(params.getAll('owner').length === 1 && /^[0-9a-f]{64}$/.test(params.get('owner')), 'agent_key');
        suffix = '?' + new URLSearchParams({ owner: params.get('owner') }); params.delete('owner');
      }
    }
    const collection = (key, spec, route = path + suffix) => { primary = '/' + key; policies[primary] = withRoute(spec, route); };
    if (['/world', '/blocks'].includes(path)) collection('plots', collectionSpecs.plots);
    else if (path === '/records/batches') collection('batches', { keys: ['n', 'from', 'to'], sort: 'n', order: 'desc' });
    else if (['/patterns', '/table'].includes(path)) { collection('patterns', collectionSpecs.patterns); policies['/compounds'] = withRoute(collectionSpecs.compounds, '/compounds'); }
    else if (path === '/compounds') collection('compounds', collectionSpecs.compounds);
    else if (['/finds', '/receipts', '/agents'].includes(path)) collection(path.slice(1), collectionSpecs[path.slice(1)]);
    else if (['/events', '/feed'].includes(path)) collection('events', eventSpec);
    else if (path === '/mint-rights') collection('mintRights', agentSpecs.mintRights);
    else if (path === '/results') policies = policiesFor(resultSpecs, '/results');
    else if (path.startsWith('/results/') && Object.hasOwn(resultSpecs, path.slice(9))) collection(path.slice(9), resultSpecs[path.slice(9)]);
    else if (/^\/patterns\/[a-z0-9]{1,24}\/blocks$/.test(path)) collection('rows', patternBlocksSpec);
    else if (/^\/agents\/[0-9a-f]{64}(?:\/[a-zA-Z]+)?$/.test(path)) {
      const [, , owner, key] = path.split('/');
      if (key && Object.hasOwn(agentSpecs, key)) collection(key, agentSpecs[key]);
      else policies = policiesFor(agentSpecs, '/agents/' + owner);
    } else if (/^\/blocks\/\d+(?:\/[a-zA-Z]+)?$/.test(path)) {
      const [, , height, key] = path.split('/');
      if (key && Object.hasOwn(blockSpecs, key)) collection(key, blockSpecs[key]);
      else policies = policiesFor(blockSpecs, '/blocks/' + height, suffix);
    }
    if (primary) pageRows([], params, policies[primary]);
    else {
      limitOf(params); for (const key of params.keys()) check(key === 'limit' && params.getAll(key).length === 1, 'summary_accepts_only_limit');
    }
    const indexed = await views.indexed?.(url, policies, primary);
    const value = indexed ?? await raw(url);
    if (!indexed && ['/world', '/blocks'].includes(path)) {
      const page = pageRows(value.plots, params, policies[primary]);
      page.entries.forEach(({ row }, i) => { policies['/plots/' + i + '/finds'] = withRoute(blockSpecs.finds, '/blocks/' + row.height + '/finds'); });
      value.plots = { page: () => page };
    }
    // Fixed multiplier vectors and signed quote bytes are not collections.
    // Pagination metadata inside a quote would invalidate its signature.
    return projectLists(value, { source, params, policies, primary, unpagedPath,
      atomicPaths: ['/feePolicy', '/feeQuote', '/feeSettings', '/terms/feeAuthorization', '/terms/feeSettings'] });
  };
  const cache = new Map();
  const publicRead = async input => {
    const value = publicIdentities(await read(tracReadRoute(input)));
    return value?.nextCursor !== undefined ? { ...value, next: value.nextCursor, route: normalize(input).pathname } : value;
  };
  return { read: publicRead, async response(input) {
    const version2 = views.store?.get('meta', 'ruleState')?.batchVersion === 2;
    // Health/readiness and live mint state also depend on adapters and time.
    // A database revision alone cannot authenticate a cached answer for them.
    const path = normalize(input).pathname, cacheable = version2 && path !== '/status' && !path.startsWith('/mint/');
    const revisionOf = () => version2 ? publicProjectionRevision(views.store, tracReadRoute(input)) : null, revision = revisionOf();
    if (cacheable && revision !== null && cache.get(input)?.revision === revision) { const saved = cache.get(input); cache.delete(input); cache.set(input, saved); return saved.result; }
    const bytes = Buffer.from(JSON.stringify(await publicRead(input))), result = { bytes, etag: '"' + hash(bytes) + '"' };
    if (cacheable && revision !== null && revision === revisionOf()) {
      const capacity = settings.publicCachePages ?? R3_RESOURCES.publicCachePages;
      while (cache.size >= capacity) cache.delete(cache.keys().next().value);
      cache.set(input, { revision, result });
    }
    return result;
  }, handles(input) {
    const path = normalize(input).pathname;
    return !immutablePath(path) && (staticPath(path) || /^\/records\/batches(?:\/\d+)?$/.test(path) || /^\/(?:status|world|blocks|patterns|table|compounds|finds|receipts|mint-rights|agents|accounts|payouts|events|feed|results|list|window-eligibility|windows)(?:\/|$)/.test(path) || /^\/mint\/[0-9a-f]{64}$/.test(path));
  } };
}
