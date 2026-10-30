import { patternMint } from './mint-assets.mjs';
import { findRankRecord } from './public-rankings.mjs';
import { rules } from './rules.mjs';
import { check, hash, heightKey } from './util.mjs';
import { publicIdentities } from '../../rules/src/trac-address.js';
import { R3_RESOURCES } from './r3-settings.mjs';
import { projectionReady, projectionRevision } from './projection-state.mjs';
export { projectionReady } from './projection-state.mjs';

export const v2Page = (block, size) => String(BigInt(rules.decimalV2(block)) / BigInt(size));
export const v2Dirty = (asset, block, size) => {
  const page = v2Page(block, size);
  return { space: 'feedPages', id: `${asset}/${rules.uintKeyV2(page)}`, value: { asset, pattern: { number: asset.slice(3), key: true }, page } };
};
export function claimedPageV2(store, asset, params, settings = {}) {
  projectionReady(store, 'claimed2/' + asset);
  const s = { ...R3_RESOURCES, ...settings }, limit = Number(params.get('limit') ?? s.patternDetailRows);
  check(/^p2:(0|[1-9][0-9]*)$/.test(asset) && Number.isSafeInteger(limit) && limit > 0 && limit <= s.patternDetailRows, 'claimed_query');
  for (const key of params.keys()) check(['limit', 'cursor', 'found', 'minted', 'order', 'sort'].includes(key) && params.getAll(key).length === 1, 'claimed_query');
  const order = params.get('order') ?? 'asc'; check(['asc', 'desc'].includes(order) && (!params.has('sort') || params.get('sort') === 'block'), 'claimed_order');
  const revision = (store.get('claimedRevision', asset) ?? '0') + '/' + projectionRevision(store, 'mintedAsset/' + asset) + '/' + projectionRevision(store, 'catalogPatterns/' + asset), filters = {};
  for (const key of ['found', 'minted']) if (params.has(key)) { check(['true', 'false'].includes(params.get(key)), 'claimed_filter'); filters[key] = params.get(key) === 'true'; }
  let after = '';
  if (params.has('cursor')) {
    let c; try { c = JSON.parse(Buffer.from(params.get('cursor'), 'base64url')); } catch { throw Error('claimed_cursor'); }
    check(c.asset === asset && c.order === order && c.revision === revision && JSON.stringify(c.filters) === JSON.stringify(filters), 'claimed_cursor_stale', 409);
    after = rules.uintKeyV2(c.after);
  }
  const where = ['asset=?'], args = [asset];
  if (after) { where.push(`heightKey${order === 'asc' ? '>' : '<'}?`); args.push(after); }
  for (const [key, value] of Object.entries(filters)) { where.push(`${key}=?`); args.push(+value); }
  const index = Object.hasOwn(filters, 'found') ? Object.hasOwn(filters, 'minted') ? 'claimedBlocksV2Status' : 'claimedBlocksV2Found' : Object.hasOwn(filters, 'minted') ? 'claimedBlocksV2Minted' : null;
  const rows = store.db.prepare(`SELECT value FROM claimedBlocksV2 ${index ? 'INDEXED BY ' + index : ''} WHERE ${where.join(' AND ')} ORDER BY heightKey ${order} LIMIT ?`).all(...args, limit + 1);
  const catalog = store.get('catalogPatterns', asset), result = { v: 3, patternId: asset, catalogRevision: catalog?.catalogRevision ?? revision,
    projectionRevision: revision, countMeaning: 'verified_submitted_blocks', knownMatchCount: catalog?.knownMatchCount ?? store.countUint('claimed2/' + asset),
    rows: [], nextCursor: null, implicitAwards: '/window-eligibility', absentMeaning: 'not_reported_or_materialized' };
  let more = rows.length > limit;
  for (const row of rows.slice(0, limit)) {
    const value = JSON.parse(row.value), find = store.get('finds', rules.findIdV2(value.height, value.pattern));
    projectionReady(store, 'block/' + value.height);
    const projected = { height: value.height, block: value.height, found: !!find, finder: find?.finder ?? null, minted: !!patternMint(store, asset, value.height), link: store.get('links', heightKey(value.height)), hash: value.hash, count: value.count, contribution: value.contribution,
      find, mint: patternMint(store, asset, value.height), provenance: value.provenance };
    const nextCursor = Buffer.from(JSON.stringify({ asset, revision, order, filters, after: value.height })).toString('base64url');
    if (Buffer.byteLength(JSON.stringify(publicIdentities({ ...result, rows: [...result.rows, projected], nextCursor, next: nextCursor }))) > s.publicPageBytes) {
      check(result.rows.length, 'claimed_row_budget', 503); more = true; break;
    }
    result.rows.push(projected); result.nextCursor = nextCursor;
  }
  if (!more) result.nextCursor = null;
  return result;
}

// A batch event is bounded by its audit budget. Each phase commits its changes
// with its cursor; no catalog, history or prior event is loaded on restart.
export async function claimedEventsV2(feeds) {
  const { store, history } = feeds, s = { ...R3_RESOURCES, ...feeds.settings };
  for (const { id, value: event } of store.list('feedEvents', { limit: s.feedEventsPerTick })) {
    if (store.get('feedEventComplete', id)) { await store.put('feedEvents', id); continue; }
    const phases = ['occurrences', 'finds', 'discoveries', 'types', 'agents', 'links', 'refinements', 'crafts', 'financial', 'transfers'];
    const cursor = store.get('feedEventCursor', id) ?? { phase: 0, offset: 0 }, phase = phases[cursor.phase];
    const source = event[phase] ?? [], rows = Array.isArray(source) ? source : Object.values(source);
    // Events are bounded by the audit budget. Sort before slicing so chunk
    // boundaries and retries cannot change discovery-time symbol priority.
    if (phase === 'discoveries') rows.sort((a, b) => rules.compareUint(rules.decimalV2(a.record.number), rules.decimalV2(b.record.number)));
    const operations = new Map(), key = (space, id) => `${space}\0${id}`;
    const put = (space, id, value) => operations.set(key(space, id), { space, id, ...(value === undefined ? {} : { value }) });
    const get = (space, id) => operations.has(key(space, id)) ? operations.get(key(space, id)).value : store.get(space, id);
    const score = (owner, field, delta) => {
      const old = get('catalogAgents', owner) ?? { address: owner, findCount: '0', discoveryCount: '0' };
      const n = BigInt(old[field] ?? '0') + BigInt(delta); check(n >= 0n, 'projection_count');
      put('catalogAgents', owner, { ...old, [field]: String(n) });
    };
    const emit = (type, data, identity, provenance) => {
      const eventId = hash('v2-event/' + identity);
      if (get('publicEventKeys', eventId)) return false;
      const sequence = rules.nextUint(rules.decimalV2(get('meta', 'publicSequence') ?? '0'));
      const time = store.get('headers', heightKey(rules.compareOrdinal(event.height, event.tip) <= 0 ? event.height : event.tip))?.fields?.time;
      put('publicEvents', heightKey(sequence), { id: eventId, sequence, type, data,
        at: time == null ? null : rules.safeNumberV2(String(BigInt(time) * 1000n)),
        provenance: provenance ?? { observation: event.observation ?? id, batch: event.batch ?? null } });
      put('publicEventKeys', eventId, sequence); put('meta', 'publicSequence', sequence); return true;
    };
    // Units on Trac follow the ledger's supply leaf for the compound (holds
    // included); made real adds each landed TAP mint. Only touched compounds change.
    const compoundTotals = (asset, minted = '0') => {
      const row = typeof asset === 'string' && asset.startsWith('c2:') && get('catalogTypes', asset);
      if (!row) return;
      put('catalogTypes', asset, { ...row, supply: get('publicSupply', asset)?.outstanding ?? row.supply ?? '0',
        madeReal: String(BigInt(row.madeReal ?? '0') + BigInt(minted)) });
    };
    const chunk = rows.slice(cursor.offset, cursor.offset + s.feedEventRows);
    for (const row of chunk) {
      if (phase === 'occurrences' || phase === 'finds') {
        // Patterns imported from v1 keep their ledger asset (e.g. "p0") in finds and occurrences;
        // the public projection is always keyed by the v2 pattern id.
        const asset = row.pattern != null ? rules.patternAssetV2(rules.decimalV2(row.pattern)) : row.asset;
        check(asset?.startsWith('p2:'), 'projection_asset_version');
        const height = rules.decimalV2(row.block), pattern = asset.slice(3), k = rules.uintKeyV2(height), old = get('claimed2/' + asset, k);
        put('claimed2/' + asset, k, { ...old, height, pattern, count: rules.decimalV2(row.count),
          hash: row.hash ?? old?.hash ?? history.get(height).hash,
          contribution: old?.contribution ?? row.agent ?? null, provenance: old?.provenance ?? row.provenance ?? null,
          found: !!(row.finder || old?.found), minted: !!(store.get('minted', `${asset}/${height}`) || row.asset && store.get('minted', `${row.asset}/${height}`)) });
        put('claimedAt2/' + k, asset, true);
        put('claimedRevision', asset, rules.nextUint(rules.decimalV2(get('claimedRevision', asset) ?? '0')));
        const dirty = v2Dirty(asset, height, s.patternPageHeights); put(dirty.space, dirty.id, dirty.value);
        if (row.finder) {
          const findId = rules.findIdV2(height, pattern);
          if (!get('findsByAgent/' + row.finder, findId)) score(row.finder, 'findCount', 1);
          put('findsByAgent/' + row.finder, findId, { ...row, ranking: get('findsByAgent/' + row.finder, findId)?.ranking ?? findRankRecord(store, findId, row, get('catalogPatterns', asset) ?? store.get('patternsByAsset', asset)) });
          put('agentAssets/' + row.finder, asset, true);
          emit(row.source === 'header' ? 'header_find' : 'find', { ...row, asset }, 'find/' + findId);
        }
      }
      if (phase === 'discoveries') {
        const record = row.record, asset = rules.patternAssetV2(record.number), previous = get('catalogPatterns', asset);
        if (previous?.discoverer !== record.discoverer) {
          if (previous?.discoverer) { score(previous.discoverer, 'discoveryCount', -1); put('discoveriesByAgent/' + previous.discoverer, asset); }
          if (record.discoverer) score(record.discoverer, 'discoveryCount', 1);
        }
        put('catalogPatterns', asset, record);
        if (record.discoverer) put('discoveriesByAgent/' + record.discoverer, asset, record);
        emit('discovery', { ...record, asset, agent: record.discoverer, state: previous ? 'updated' : 'accepted' },
          'discovery/' + id + '/' + asset + '/' + rules.hashObject(record));
      }
      if (phase === 'types') {
        const previous = get('catalogTypes', row.id);
        // A retired compound (merged into its deterministic id) leaves the
        // public lists; its units were reissued under the new id.
        put('catalogTypes', row.id, row.retired ? undefined : { ...row, ...(previous?.tierProgress ? { tierProgress: previous.tierProgress } : {}),
          ...(previous?.supply ? { supply: previous.supply } : {}), ...(previous?.madeReal ? { madeReal: previous.madeReal } : {}) });
        compoundTotals(row.id);
      }
      if (phase === 'refinements') {
        const previous = get('catalogTypes', row.asset);
        check(previous, 'projection_compound_missing');
        // The committed recipe remains immutable; exact tier continuation is
        // a separately authenticated delta, applied in accepted event order.
        put('catalogTypes', row.asset, { ...previous, tierProgress: row.progress });
      }
      if (phase === 'agents') for (const asset of row.assets) put('agentAssets/' + row.owner, asset, true);
      if (phase === 'links') put('feedLinkedBlocks2', rules.uintKeyV2(rules.decimalV2(row)), { block: rules.decimalV2(row), after: '' });
      if (phase === 'crafts') {
        const owner = row.action?.owner ?? row.agent;
        if (emit('craft', { agent: owner, owner, asset: row.id, amount: row.amount, firstMaker: row.firstMaker },
          'craft/' + (row.move ?? rules.hashObject([id, row.action])))) score(owner, 'craftCount', 1);
        for (const asset of new Set([row.id, ...(row.action?.in ?? []).map(([asset]) => asset)])) compoundTotals(asset);
      }
      if (phase === 'transfers') {
        const a = row.action;
        emit('transfer', { owner: a.owner, from: a.owner, to: a.to, asset: a.asset, amount: a.amount, assets: [[a.asset, a.amount]] },
          'transfer/' + row.move + '/' + a.nonce);
      }
      if (phase === 'financial' && emit(row.type, row.data, row.id, row.provenance)) {
        if (row.type === 'mint_complete' && row.data.owner) score(row.data.owner, 'mintCount', 1);
        if (row.type === 'link' && row.data.owner) score(row.data.owner, 'linkCount', 1);
        compoundTotals(row.data.asset, row.type === 'mint_complete' ? row.data.amount ?? '0' : '0');
      }
    }
    let next = { phase: cursor.phase, offset: cursor.offset + chunk.length };
    if (next.offset === rows.length) next = { phase: next.phase + 1, offset: 0 };
    if (next.phase === phases.length) {
      put('feedEvents', id); put('feedEventCursor', id); put('feedEventComplete', id, true);
      emit('batch', { height: rules.decimalV2(event.height), tip: rules.decimalV2(event.tip), occurrences: String(event.occurrences?.length ?? 0),
        finds: String(Object.keys(event.finds ?? {}).length), discoveries: String(event.discoveries?.length ?? 0) }, 'batch/' + id);
      put('meta', 'v2PublicProgress', { observation: event.observation ?? null, batch: event.batch ?? null,
        height: rules.decimalV2(event.height), tip: rules.decimalV2(event.tip) });
    }
    else put('feedEventCursor', id, next);
    put('meta', 'claimedProjectionRevision', hash(`${id}/${cursor.phase}/${cursor.offset}`));
    await store.transact([...operations.values()]);
    // A later small event must not publish its catalog/attribution changes
    // ahead of an earlier event whose occurrence phase needs more pages.
    if (next.phase < phases.length) break;
  }
  // Compounds projected before units and made real were kept: fill them once, one page per tick.
  const fill = store.get('meta', 'compoundTotalsFill') ?? { after: '' };
  if (!fill.done) {
    const rows = store.list('catalogTypes', { after: fill.after, limit: s.feedEventRows });
    await store.transact([...rows.filter(r => r.id.startsWith('c2:') && (r.value.supply === undefined || r.value.madeReal === undefined)).map(r => ({
      space: 'catalogTypes', id: r.id, value: { ...r.value, supply: store.get('publicSupply', r.id)?.outstanding ?? '0', madeReal: r.value.madeReal ?? '0' } })),
    { space: 'meta', id: 'compoundTotalsFill', value: rows.length === s.feedEventRows ? { after: rows.at(-1).id } : { done: true } }]);
  }
  for (const { id, value } of store.list('feedLinkedBlocks2', { limit: s.feedEventsPerTick })) {
    const rows = store.list('claimedAt2/' + id, { after: value.after, limit: s.feedEventRows });
    await store.transact([...rows.map(r => v2Dirty(r.id, value.block, s.patternPageHeights)),
      { space: 'feedLinkedBlocks2', id, ...(rows.length === s.feedEventRows ? { value: { ...value, after: rows.at(-1).id } } : {}) }]);
  }
}
