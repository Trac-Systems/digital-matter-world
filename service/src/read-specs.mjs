import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { booleanFilter, enumFilter, field, numberFilter } from './paging.mjs';

const strings = keys => Object.fromEntries(keys.split(' ').filter(Boolean).map(key => [key, String]));
const bools = keys => Object.fromEntries(keys.split(' ').filter(Boolean).map(key => [key, booleanFilter]));
const numbers = keys => Object.fromEntries(keys.split(' ').filter(Boolean).map(key => [key, numberFilter]));
const matchFields = (get, row, filters) => Object.entries(filters).every(([key, value]) => {
  if (key === 'q') return [row.name, row.id, row.asset, row.actionId, /^[0-9a-f]{64}$/.test(row.address ?? '') ? encodeTracAddress(row.address) : row.address].some(v => String(v ?? '').toLowerCase().includes(value.toLowerCase()));
  if (key === 'nonzero') return (BigInt(row.amount ?? 0) !== 0n) === value;
  if (key === 'positive') return (BigInt(row.count ?? 0) > 0n) === value;
  if (key === 'whoMayMint') {
    if (value === 'me') return !!row.allowed;
    if (value === 'none') return !row.allowed;
    return row.whoMayMint === (value === 'landowner' ? 'bitmap' : value);
  }
  const actual = get(row, key);
  return typeof value === 'boolean' ? !!actual === value : String(actual ?? '') === String(value);
});
function spec(keys, { order = 'asc', filters = {}, get = field, match } = {}) {
  return { keys: keys.split(' '), sort: keys.split(' ')[0], order, filters, get, match: match ?? ((row, f) => matchFields(get, row, f)) };
}
const rights = spec('block asset amount reason finderUntil', { order: 'desc', filters: {
  ...strings('asset reason'), ...numbers('block'), ...bools('allowed minted pending'),
  whoMayMint: enumFilter(['me', 'finder', 'bitmap', 'landowner', 'public', 'holder', 'none']),
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
  payments: spec('id block action total', { filters: strings('action'), get: (r, k) => k === 'id' ? r.id : !r.consumed ? field(r,k) : field(r.consumed, ({ block: 'blck', total: r.consumed?.total === undefined ? 'amt' : 'total' })[k] ?? k) }),
  ethereum: spec('id amount status payer', { filters: strings('status payer'), get: (r, k) => field(r, k) ?? field(r.deposit, k) }),
  payouts: spec('id beneficiary accrued paid owed', { filters: strings('beneficiary') }),
  owed: spec('id role amount to', { filters: strings('role to') }),
  paid: spec('id amount to', { filters: strings('to'), get: (r,k) => field(r,k === 'to' ? 'beneficiary' : k) }),
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
  plots: spec('height region halving', { order: 'desc', filters: { ...numbers('from to'), ...bools('claimable found linked minted') }, match: (r, f) => Object.entries(f).every(([k, v]) => k === 'from' ? r.height >= v : k === 'to' ? r.height <= v : !!r[k] === v) }),
  finds,
  receipts: spec('id height', { order: 'desc', filters: numbers('height') }),
  jobs: spec('created id type state finished', { order: 'desc', filters: strings('type state') }),
  agents: spec('finds address discoveries crafts mints', { order: 'desc', filters: strings('address q') }),
  components: spec('name state pid', { filters: strings('state') }),
};

export const agentSpecs = {
  balances: playerSpecs.balances, bitmaps: playerSpecs.bitmaps, finds, mintRights: rights,
  discoveries: spec('asset name state opensAt', { filters: strings('asset state q') }),
};
export const eventSpec = spec('sequence at type', { order: 'desc', filters: { ...strings('type actor'), ...numbers('since'), category: enumFilter(['chain','money']) }, match: (r,f) =>
  (!f.type || r.type === f.type) && (!f.actor || [r.data?.actor,r.data?.agent,r.data?.owner,r.data?.finder,r.data?.from,r.data?.to].includes(f.actor)) &&
  (!f.category || (['mint_request','mint_permit','mint_complete','transfer','link'].includes(r.type) ? 'money' : 'chain') === f.category) && (f.since === undefined || r.sequence > f.since) });
agentSpecs.history = eventSpec;
export const patternBlocksSpec = spec('block count finder findHeight', { order: 'desc', filters: { ...numbers('from to'), ...bools('found minted linked') }, match: (r,f) =>
  Object.entries(f).every(([k,v]) => k === 'from' ? r.block >= v : k === 'to' ? r.block <= v : k === 'linked' ? !!r.link === v : !!r[k] === v) });
