import { publicIdentities, tracReadRoute } from '../rules/src/trac-address.js';
import { booleanFilter, enumFilter, field, genericSpec, limitOf, listRoute, numberFilter, pageRows, pointerValue, projectLists } from './paging.mjs';
import { sharedReads } from './public-proxy.mjs';

const strings = keys => Object.fromEntries(keys.split(' ').filter(Boolean).map(key => [key, String]));
const bools = keys => Object.fromEntries(keys.split(' ').filter(Boolean).map(key => [key, booleanFilter]));
const numbers = keys => Object.fromEntries(keys.split(' ').filter(Boolean).map(key => [key, numberFilter]));
const missing = () => { throw Object.assign(Error('not_found'), { status: 404 }); };
const bad = message => { throw Object.assign(Error(message), { status: 400 }); };
const matchFields = (get, row, filters) => Object.entries(filters).every(([key, value]) => {
  if (key === 'q') return [row.name, row.id, row.asset, row.actionId].some(v => String(v ?? '').toLowerCase().includes(value.toLowerCase()));
  if (key === 'nonzero') return (BigInt(row.amount ?? 0) !== 0n) === value;
  if (key === 'positive') return (BigInt(row.count ?? 0) > 0n) === value;
  if (key === 'whoMayMint') {
    if (value === 'me') return !!row.allowed;
    if (value === 'none') return !row.allowed;
    return row.reason === (value === 'landowner' ? 'bitmap' : value);
  }
  const actual = get(row, key);
  return typeof value === 'boolean' ? !!actual === value : String(actual ?? '') === String(value);
});
function spec(keys, { order = 'asc', filters = {}, get = field, match } = {}) {
  return { keys: keys.split(' '), sort: keys.split(' ')[0], order, filters, get, match: match ?? ((row, f) => matchFields(get, row, f)) };
}
const rights = spec('block asset amount reason finderUntil', { order: 'desc', filters: {
  ...strings('asset'), ...numbers('block'), ...bools('allowed minted pending'),
  whoMayMint: enumFilter(['me', 'finder', 'bitmap', 'landowner', 'public', 'minted', 'pending', 'insufficient_balance', 'none']),
} });
const finds = spec('block asset pattern count finder findHeight', { order: 'desc', filters: { ...strings('owner asset'), ...numbers('block'), ...bools('minted') }, get: (r, k) => field(r, k === 'owner' ? 'finder' : k) });
export const playerSpecs = {
  balances: spec('asset amount', { filters: { ...strings('asset'), ...bools('nonzero') } }),
  mintRights: rights,
  history: spec('sequence id type state', { order: 'desc', filters: strings('type state') }),
  pendingPayments: spec('id type asset block height state price', { filters: strings('type asset state kind') }),
  bitmaps: spec('height inscription linked', { filters: { ...bools('linked'), ...numbers('height') } }),
  discoveries: spec('actionId name state revealFrom revealUntil asset', { filters: strings('state asset q') }),
  items: spec('id asset', { filters: strings('asset') }),
};
export const resultSpecs = {
  mints: spec('id asset block amount kind state price', { filters: { ...strings('asset kind state owner'), ...numbers('block') } }),
  payments: spec('id block action total', { filters: strings('action'), get: (r, k) => k === 'id' ? r.id : field(r.consumed, ({ block: 'blck', total: r.consumed?.total === undefined ? 'amt' : 'total' })[k] ?? k) }),
  ethereum: spec('id amount status payer', { filters: strings('status payer'), get: (r, k) => field(r, k) ?? field(r.deposit, k) }),
  payouts: spec('id beneficiary accrued paid owed', { filters: strings('beneficiary') }),
  owed: spec('id role amount to', { filters: strings('role to') }),
  paid: spec('id amount to', { filters: strings('to') }),
  links: spec('block id linkHeight owner', { order: 'desc', filters: { ...strings('owner'), ...numbers('block') } }),
};
export const blockSpecs = {
  finds: { ...finds, sort: 'asset', order: 'asc' },
  claims: spec('agent window reason', { filters: { ...strings('agent'), ...bools('header') } }),
  draws: spec('window settledAt', { order: 'desc', filters: numbers('window') }),
  matches: spec('number asset count', { filters: { ...strings('asset'), ...bools('positive') } }),
  slotList: spec('number asset count pattern', { filters: strings('asset') }),
  mintRights: rights,
};
export const collectionSpecs = {
  patterns: spec('number name tier rarity supply minted madeReal discoverer', { filters: strings('asset tier discoverer q') }),
  compounds: spec('id name tier recipe supply madeReal firstMaker', { filters: strings('asset tier recipe firstMaker q'), get: (r, k) => field(r, k === 'asset' ? 'id' : k) }),
  plots: spec('height region halving', { order: 'desc', filters: { ...numbers('from to'), ...bools('found linked minted') }, match: (r, f) => Object.entries(f).every(([k, v]) => k === 'from' ? r.height >= v : k === 'to' ? r.height <= v : !!r[k] === v) }),
  finds,
  receipts: spec('id height', { order: 'desc', filters: numbers('height') }),
  jobs: spec('created id type state finished', { order: 'desc', filters: strings('type state') }),
  agents: spec('name address strategy', { filters: { ...strings('strategy'), state: enumFilter(['error', 'ready']) }, get: (r, k) => k === 'state' ? r.error ? 'error' : 'ready' : field(r, k) }),
  components: spec('name state pid', { filters: strings('state') }),
};
const withRoute = (value, route) => ({ ...value, route });
const policiesFor = (specs, base) => Object.fromEntries(Object.entries(specs).map(([key, value]) => ['/' + key, withRoute(value, base + '/' + key)]));

function feedSpec(owner) {
  return spec('sequence at type', { order: 'desc', filters: { ...strings('type actor'), category: enumFilter(['you', 'bots', 'chain', 'money', 'problems']) }, match: (event, f) => {
    const d = event.data ?? {}, actor = d.actor ?? d.agent ?? d.owner ?? d.address;
    if (f.type && event.type !== f.type || f.actor && actor !== f.actor) return false;
    if (!f.category) return true;
    if (f.category === 'you') return ['player', 'job'].includes(event.type) || actor === owner;
    if (f.category === 'bots') return event.type === 'bot';
    if (f.category === 'chain') return ['block', 'draw', 'find', 'header_find', 'header', 'claim', 'discovery', 'receipts'].includes(event.type);
    if (f.category === 'money') return event.type === 'payment' || /mint|pay|link/i.test(d.action ?? (event.type === 'job' ? d.type : '') ?? '');
    return event.type === 'error' || d.state === 'failed' || !!d.error || event.type === 'component' && !/^(ready|running|ok|up)$/i.test(d.state ?? '');
  } });
}

export function projectEvent(event, source = '/api/feed/' + event.sequence) {
  return publicIdentities(projectLists(event, { source }));
}
export function projectJob(job) {
  return publicIdentities(projectLists(job, { source: '/api/jobs/' + job.id }));
}

function controlReadAPI({ views, engine, jobs, events, paymentPlan }) {
  const raw = async url => {
    if (url.pathname.startsWith('/api/lab/')) {
      if (!/^\/api\/lab\/(?:status|bots|jobs|feed)(?:\/|$)/.test(url.pathname)) return missing();
      url = new URL(url); url.pathname = '/api/' + url.pathname.slice(9);
    }
    const path = url.pathname.slice(5), params = url.searchParams;
    if (path === 'status') return views.status();
    if (path === 'status/components') return { components: (await views.status()).components };
    if (path === 'jobs') return { jobs: [...jobs.rows.values()] };
    if (path.startsWith('jobs/')) return jobs.rows.get(path.slice(5)) ?? missing();
    if (path === 'feed') return { events };
    if (/^feed\/\d+$/.test(path)) return events.find(e => e.sequence === Number(path.slice(5))) ?? missing();
    if (path === 'player') return views.localPlayer ? views.localPlayer() : views.player();
    if (path.startsWith('player/') && Object.hasOwn(playerSpecs, path.slice(7))) {
      const key = path.slice(7); return { [key]: await views.playerList(key) };
    }
    if (path === 'results') return views.results();
    if (path.startsWith('results/') && Object.hasOwn(resultSpecs, path.slice(8))) {
      const key = path.slice(8); return { [key]: await views.resultList(key) };
    }
    if (path === 'patterns') return views.patterns();
    if (path === 'compounds') return { compounds: (await views.patterns()).compounds };
    if (path === 'bots') return engine.botState();
    if (path === 'finds') return views.finds();
    if (path === 'receipts') return views.receipts();
    if (path === 'world') {
      const tip = (await engine.trac('head')).tip.height;
      const from = params.has('from') ? numberFilter(params.get('from')) : 0;
      const to = params.has('to') ? numberFilter(params.get('to')) : tip;
      if (from > to || to > tip) bad('world_range');
      return views.plots(from, to);
    }
    const block = /^blocks\/(\d+)(?:\/([a-zA-Z]+))?$/.exec(path);
    if (block) {
      if (block[2] && !Object.hasOwn(blockSpecs, block[2])) return missing();
      const value = await views.block(numberFilter(block[1]));
      return block[2] ? { [block[2]]: value[block[2]] } : value;
    }
    if (path.startsWith('payment-plan/')) return paymentPlan(engine, path.slice(13));
    if (path.startsWith('gateway/')) {
      const p = path.slice(8);
      if (!/^(?:health|latest\.json|world|patterns|(?:world|blocks|receipts|records|patterns|agents|mint)\/[a-zA-Z0-9/_.-]+)$/.test(p) || p.includes('..')) bad('gateway_read_path');
      return engine.get('/' + p + url.search);
    }
    return missing();
  };
  return async input => {
    const url = new URL(input), params = url.searchParams;
    const lab = url.pathname.startsWith('/api/lab/');
    if (lab) url.pathname = '/api/' + url.pathname.slice(9);
    const outward = path => lab ? path.replace('/api/', '/api/lab/') : path;
    if (url.pathname === '/api/results' && params.has('kind')) {
      const kind = params.get('kind');
      if (params.getAll('kind').length !== 1 || !Object.hasOwn(resultSpecs, kind)) bad('invalid_result_kind');
      url.pathname += '/' + kind; params.delete('kind');
    }
    const path = url.pathname.slice(5), source = outward(url.pathname) + url.search;
    if (path === 'list') {
      const sourcePath = params.get('source'), pointer = params.get('path');
      if (!sourcePath?.startsWith('/api/') || sourcePath.startsWith('//') || pointer === null || params.getAll('source').length !== 1 || params.getAll('path').length !== 1) bad('invalid_list_source');
      const sourceURL = new URL(sourcePath, url.origin);
      if (sourceURL.origin !== url.origin || sourceURL.hash || ['list', 'events'].includes(sourceURL.pathname.slice(5))) bad('invalid_list_source');
      const rows = pointerValue(await raw(sourceURL), pointer);
      if (!Array.isArray(rows)) bad('list_path_not_array');
      const query = new URLSearchParams(params); query.delete('source'); query.delete('path');
      const { entries, meta } = pageRows(rows, query, genericSpec(rows, listRoute(sourcePath, pointer)));
      return { items: entries.map(({ row, index }) => projectLists(row, { source: sourcePath, path: pointer + '/' + index, previewLimit: meta.limit, atomicTuple: true })), ...meta };
    }
    let policies = {}, primary;
    const collection = (key, value, route = outward(url.pathname)) => {
      primary = '/' + key; policies[primary] = withRoute(value, route);
    };
    if (path === 'player') policies = policiesFor(playerSpecs, '/api/player');
    else if (path.startsWith('player/') && Object.hasOwn(playerSpecs, path.slice(7))) collection(path.slice(7), playerSpecs[path.slice(7)]);
    else if (path === 'results') policies = policiesFor(resultSpecs, '/api/results');
    else if (path.startsWith('results/') && Object.hasOwn(resultSpecs, path.slice(8))) collection(path.slice(8), resultSpecs[path.slice(8)]);
    else if (path === 'patterns') {
      collection('patterns', collectionSpecs.patterns);
      policies['/compounds'] = withRoute(collectionSpecs.compounds, '/api/compounds');
    } else if (path === 'compounds') collection('compounds', collectionSpecs.compounds);
    else if (path === 'world') collection('plots', collectionSpecs.plots);
    else if (['finds', 'receipts', 'jobs'].includes(path)) collection(path, collectionSpecs[path]);
    else if (path === 'bots') collection('agents', collectionSpecs.agents);
    else if (path === 'feed') collection('events', feedSpec(engine.state.player.address));
    else if (path === 'status/components') collection('components', collectionSpecs.components);
    else if (path === 'status') policies['/components'] = withRoute(collectionSpecs.components, outward('/api/status/components'));
    else if (/^blocks\/\d+(?:\/[a-zA-Z]+)?$/.test(path)) {
      const [, height, key] = path.split('/');
      if (key && Object.hasOwn(blockSpecs, key)) collection(key, blockSpecs[key]);
      else policies = policiesFor(blockSpecs, '/api/blocks/' + height);
    }
    if (primary) pageRows([], params, policies[primary]); // Validate before expensive source reads.
    else {
      limitOf(params);
      for (const key of params.keys()) if (key !== 'limit' || params.getAll(key).length !== 1) bad('summary_accepts_only_limit');
    }
    const value = await raw(url);
    if (path === 'world') for (let i = 0; i < value.plots.length; i++) {
      policies['/plots/' + i + '/finds'] = withRoute(blockSpecs.finds, '/api/blocks/' + value.plots[i].height + '/finds');
    }
    // A TAP redeem document is an executable wallet instruction. Metadata or a
    // sliced allocation vector would change the transaction the wallet signs.
    return projectLists(value, { source, params, policies, primary, atomicPaths:
      ['/feePolicy', '/feeQuote', '/feeSettings', '/terms/feeAuthorization', '/terms/feeSettings', ...(path.startsWith('payment-plan/') ? ['/redeem'] : [])] });
  };
}

export function createControlReadAPI(options) {
  const read = controlReadAPI(options);
  return async input => { const url = new URL(input); return publicIdentities(await read(new URL(tracReadRoute(url), url.origin))); };
}

export function createReadAPI(options) {
  const read = sharedReads({ engine: options.engine, local: createControlReadAPI(options) });
  return async (input, context) => publicIdentities(await read(input, context));
}
