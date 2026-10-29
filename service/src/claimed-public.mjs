import { check, heightKey } from './util.mjs';
import { R3_RESOURCES } from './r3-settings.mjs';
import { claimedPage } from './claimed-feeds.mjs';
import { publicIdentities, encodeTracAddress } from '../../rules/src/trac-address.js';
import { rules } from './rules.mjs';
import { projectionReady } from './claimed-v2.mjs';
import { AccountAvailability } from './account-availability.mjs';
import { accountKey, EMPTY_ACCOUNT_ROOT } from '../../contract/account-tree.js';
import { projectionRevision } from './projection-state.mjs';

export function recordPage(store, space, params, { key = 'rows', maxRows = R3_RESOURCES.patternDetailRows, maxBytes = R3_RESOURCES.publicPageBytes, map = r => ({ id: r.id, ...r.value }) } = {}) {
  projectionReady(store, space);
  const requested = Number(params.get('limit') ?? maxRows), limit = Math.min(requested, maxRows), revision = projectionRevision(store, space);
  check(Number.isSafeInteger(requested) && requested > 0, 'page_limit');
  for (const k of params.keys()) check(['limit', 'cursor', 'order', 'sort'].includes(k) && params.getAll(k).length === 1, 'paged_query');
  const order = params.get('order') ?? 'asc', sort = params.get('sort') ?? 'id';
  check(['asc', 'desc'].includes(order) && ['id', 'asset', 'number', 'sequence', 'n', 'address'].includes(sort), 'page_order');
  let after = '';
  if (params.has('cursor')) {
    let c; try { c = JSON.parse(Buffer.from(params.get('cursor'), 'base64url')); } catch { throw Error('page_cursor'); }
    check(c.space === space && c.revision === revision && c.order === order && c.sort === sort && typeof c.after === 'string', 'page_cursor_stale', 409); after = c.after;
  }
  const rows = order === 'asc' ? store.list(space, { after, limit: limit + 1 }) : store.db.prepare(`SELECT id,value FROM records WHERE space=? ${after ? 'AND id<?' : ''} ORDER BY id DESC LIMIT ?`).all(space, ...(after ? [after] : []), limit + 1).map(r => ({ id: r.id, value: JSON.parse(r.value) })); let more = rows.length > limit;
  const result = { v: 3, revision, [key]: [], nextCursor: null, next: null, total: store.countUint(space), limit, sort, order };
  for (const row of rows.slice(0, limit)) {
    const cursor = Buffer.from(JSON.stringify({ space, revision, order, sort, after: row.id })).toString('base64url'), projected = map(row);
    if (Buffer.byteLength(JSON.stringify(publicIdentities({ ...result, [key]: [...result[key], projected], nextCursor: cursor, next: cursor }))) > maxBytes) { check(result[key].length > 0, 'page_row_budget', 503); more = true; break; }
    result[key].push(projected); result.nextCursor = cursor;
  }
  if (!more) result.nextCursor = null; result.next = result.nextCursor; return result;
}
export function claimedPublicRead(store, url, settings = {}) {
  const path = decodeURIComponent(url.pathname), params = url.searchParams;
  const limits = { ...R3_RESOURCES, ...settings };
  const page = (space, options = {}) => recordPage(store, space, params, { maxRows: limits.patternDetailRows, maxBytes: limits.publicPageBytes, ...options });
  if (path === '/mint-rights') {
    const asset = params.get('asset'), owner = params.get('owner');
    check(/^p2:(0|[1-9][0-9]*)$/.test(asset ?? ''), 'rights_asset_required');
    check(/^[0-9a-f]{64}$/.test(owner ?? ''), 'agent_key');
    const query = new URLSearchParams(params); query.delete('asset'); query.delete('owner'); query.set('found', 'true'); query.set('minted', 'false');
    const result = claimedPage(store, asset, query, settings), counted = rules.decimalV2(store.get('meta', 'ruleState').counted);
    return { ...result, owner, scope: 'explicit_finds_for_named_asset', rows: result.rows.map(row => {
      const find = row.find, until = find?.finderUntil;
      check(until, 'rights_policy_missing', 503);
      const link = store.get('links', heightKey(row.height)), exclusive = rules.compareUint(counted, until) < 0,
        bitmap = !exclusive && !rules.bitmapMintOpenActive(settings.document, counted) && link && rules.compareUint(rules.decimalV2(link.linkHeight), rules.decimalV2(find.findHeight)) < 0;
      return { ...row, right: exclusive ? 'finder' : bitmap ? 'bitmap' : 'public',
        eligible: exclusive ? find.finder === owner : bitmap ? null : true, finderUntil: until,
        ...(bitmap ? { requires: 'current_bitmap_ownership_evidence' } : {}) };
    }) };
  }
  const pattern = /^\/patterns\/(p[0-9a-z]+|p2:(?:0|[1-9][0-9]*))\/(claimed-blocks|blocks|claimed-pages)$/.exec(path);
  if (pattern) {
    if (pattern[2] === 'blocks') return { v: 3, deprecated: true, replacement: `/patterns/${pattern[1]}/claimed-blocks`, countMeaning: 'verified_submitted_blocks' };
    if (pattern[2] === 'claimed-blocks') return claimedPage(store, pattern[1], params, settings);
    return page('claimedPageManifests/' + pattern[1]);
  }
  if (path === '/window-eligibility') return page('windowEligibility');
  const detail = /^\/windows\/(\d+)\/(claims|winners|headers)$/.exec(path);
  if (detail) return page(`window/${rules.uintV2(detail[1])}/${detail[2]}`);
  const window = /^\/window-eligibility\/(\d+)$/.exec(path);
  if (window) return { v: 3, draw: store.get('windowEligibility', heightKey(rules.uintV2(window[1]))) };
  const account = /^\/accounts\/([0-9a-f]{64})\/balances\/([^/]+)$/.exec(path);
  if (account) {
    check(!params.size && (rules.assetIdV2(account[2]) || rules.assetId(account[2])), 'account_query');
    const record = store.get('accountRecords', 'ar/' + account[1]) ?? { root: EMPTY_ACCOUNT_ROOT, revision: '0' };
    const proof = new AccountAvailability(store).prove(record.root, [accountKey('balance', account[2])]);
    return { v: 2, owner: account[1], asset: account[2], account: record, proof,
      batch: store.get('meta', 'v2Last'), verification: 'compare_account_root_with_notary' };
  }
  const batch = /^\/records\/batches\/(0|[1-9][0-9]*)$/.exec(path);
  if (batch) { check(!params.size, 'batch_query'); const value = store.get('batches', heightKey(batch[1])); check(value, 'batch_not_found', 404); return value; }
  const sources = { '/patterns': ['catalogPatterns', 'patterns'], '/table': ['catalogPatterns', 'patterns'], '/compounds': ['catalogTypes', 'compounds'], '/agents': ['catalogAgents', 'agents'], '/finds': ['finds', 'finds'],
    '/payouts/beneficiaries': ['payoutTotals', 'beneficiaries'], '/payouts/owed': ['commissionOwed', 'owed'], '/payouts/paid': ['payoutPaid', 'paid'],
    '/events': ['publicEvents', 'events'], '/feed': ['publicEvents', 'events'], '/receipts': ['receiptObservations', 'receipts'], '/records/batches': ['batches', 'batches'] };
  if (sources[path]) return page(sources[path][0], { key: sources[path][1],
    ...(path === '/payouts/beneficiaries' ? { map: ({ id, value }) => ({ id, ...value, owed: String(BigInt(value.accrued) - BigInt(value.paid)) }) } : {}),
    ...(path === '/records/batches' ? { map: ({ value }) => ({ n: value.batch.n, from: value.batch.from, to: value.batch.to, root: value.batch.root, manifest: '/records/batches/' + value.batch.n }) } : {}),
    ...(path === '/receipts' ? { map: ({ id, value }) => ({ id, seal: value.seal, archive: value.archive ?? null }) } : {}) });
  const agent = /^\/agents\/([0-9a-f]{64})(?:\/(finds|assets|discoveries))?$/.exec(path);
  if (agent) {
    if (!agent[2]) { projectionReady(store, 'agent/' + agent[1]); const address = encodeTracAddress(agent[1]), row = store.get('catalogAgents', agent[1]); return { v: 3, address: agent[1], ...row, scores: { finds: row?.findCount ?? '0', discoveries: row?.discoveryCount ?? '0', crafts: row?.craftCount ?? '0', mints: row?.mintCount ?? '0', links: row?.linkCount ?? '0' },
      collections: Object.fromEntries(['finds', 'assets', 'discoveries', 'balances', 'bitmaps', 'history', 'mintRights'].map(k => [k, `/agents/${address}/${k}`])) };
    }
    const spaces = { finds: 'findsByAgent/', assets: 'agentAssets/', discoveries: 'discoveriesByAgent/' };
    return page(spaces[agent[2]] + agent[1], { key: agent[2], ...(agent[2] === 'assets' ? { map: ({ id }) => ({ asset: id, balance: `/accounts/${agent[1]}/balances/${encodeURIComponent(id)}` }) } : {}) });
  }
  return undefined;
}
