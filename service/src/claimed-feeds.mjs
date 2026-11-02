import { patternMint } from './mint-assets.mjs';
import { publicIdentities } from './public-identities.mjs';
import { rules } from './rules.mjs';
import { check, hash, heightKey } from './util.mjs';
import { R3_RESOURCES } from './r3-settings.mjs';
import { claimedPageV2, claimedEventsV2 } from './claimed-v2.mjs';

const defaults = settings => ({ ...R3_RESOURCES, ...settings });
export function claimedPage(store, asset, params = new URLSearchParams(), settings = {}) {
  if (asset.startsWith('p2:')) return claimedPageV2(store, asset, params, settings);
  const s = defaults(settings), limit = Number(params.get('limit') ?? s.patternDetailRows);
  check(Number.isSafeInteger(limit) && limit > 0 && limit <= s.patternDetailRows, 'page_limit');
  for (const key of params.keys()) check(['limit', 'cursor', 'found', 'minted'].includes(key) && params.getAll(key).length === 1, 'claimed_query');
  const revision = store.get('claimedRevision', asset) ?? 0, filters = {};
  for (const key of ['found', 'minted']) if (params.has(key)) { check(['true', 'false'].includes(params.get(key)), 'claimed_filter'); filters[key] = params.get(key) === 'true'; }
  let after = '';
  if (params.has('cursor')) {
    let cursor; try { cursor = JSON.parse(Buffer.from(params.get('cursor'), 'base64url')); } catch { throw Error('claimed_cursor'); }
    check(cursor.asset === asset && cursor.revision === revision && JSON.stringify(cursor.filters) === JSON.stringify(filters), 'claimed_cursor_stale', 409); after = cursor.after;
    check(typeof after === 'string' && /^\d{16}$/.test(after), 'claimed_cursor');
  }
  // Filtered seeks use composite SQL indexes; no total-count query per page.
  const where = ['asset=?', 'height>?'], args = [asset, after ? Number(after) : -1];
  for (const [key, value] of Object.entries(filters)) { where.push(`${key}=?`); args.push(+value); }
  const rows = store.db.prepare(`SELECT height,value FROM claimedBlocks WHERE ${where.join(' AND ')} ORDER BY height LIMIT ?`).all(...args, limit + 1);
  let more = rows.length > limit;
  const result = { v: 3, patternId: asset, catalogRevision: revision, countMeaning: 'verified_submitted_blocks', knownMatchCount: store.count('claimed/' + asset),
    rows: [], nextCursor: null, implicitAwards: '/window-eligibility', absentMeaning: 'not_reported_or_materialized' };
  for (const r of rows.slice(0, limit)) {
    const row = JSON.parse(r.value), find = store.get('finds', rules.findId(r.height, row.pattern));
    const projected = { height: r.height, hash: row.hash, count: row.count, contribution: row.contribution ?? null,
      find: find ?? null, mint: store.get('minted', `${asset}/${r.height}`), provenance: row.provenance ?? null };
    const nextCursor = Buffer.from(JSON.stringify({ asset, revision, filters, after: heightKey(r.height) })).toString('base64url');
    if (Buffer.byteLength(JSON.stringify(publicIdentities({ ...result, rows: [...result.rows, projected], nextCursor }))) > s.publicPageBytes) {
      check(result.rows.length > 0, 'claimed_row_budget', 503); more = true; break;
    }
    result.rows.push(projected); result.nextCursor = nextCursor;
  }
  if (!more) result.nextCursor = null; return result;
}

export async function claimedPatternPage({ store, files, pattern, page, settings = {}, asset: suppliedAsset }) {
  const s = defaults(settings), size = s.patternPageHeights, asset = suppliedAsset ?? (pattern.key ? rules.patternAssetV2(pattern.number) : rules.patternAsset(pattern)), v2 = asset.startsWith('p2:');
  const from = v2 ? String(BigInt(rules.decimalV2(page)) * BigInt(size)) : page * size;
  check((v2 || Number.isSafeInteger(page) && page >= 0) && Number.isSafeInteger(size) && size > 0, 'pattern_page');
  const rows = v2 ? store.db.prepare('SELECT value FROM claimedBlocksV2 WHERE asset=? AND heightKey>=? AND heightKey<? ORDER BY heightKey').all(asset, rules.uintKeyV2(from), rules.uintKeyV2(rules.addUint(from, String(size)))).map(r => ({ ...r, height: JSON.parse(r.value).height }))
    : store.db.prepare('SELECT height,value FROM claimedBlocks WHERE asset=? AND height>=? AND height<? ORDER BY height').all(asset, from, from + size);
  const found = Buffer.alloc(Math.ceil(size / 8)), minted = Buffer.alloc(found.length), details = [], refs = [];
  for (const r of rows) {
    const occurrence = JSON.parse(r.value), find = store.get('finds', v2 ? rules.findIdV2(r.height, asset.slice(3)) : rules.findId(r.height, pattern.number)), mint = v2 ? patternMint(store, asset, r.height) : store.get('minted', `${asset}/${r.height}`), i = Number(BigInt(r.height) - BigInt(from));
    if (find) found[i >> 3] |= 1 << (i & 7); if (mint) minted[i >> 3] |= 1 << (i & 7);
    details.push(publicIdentities({ height: r.height, count: occurrence.count, hash: occurrence.hash, find, mint, link: store.get('links', heightKey(r.height)) }));
  }
  let part = [];
  const publish = async () => { if (!part.length) return; const bytes = Buffer.from(JSON.stringify({ v: 3, asset, rows: part }));
    refs.push(await files.immutable(`patterns/${asset}/${page}-detail-${hash(bytes)}.json`, bytes)); part = []; };
  for (const row of details) {
    const bytes = Buffer.byteLength(JSON.stringify({ v: 3, asset, rows: [...part, row] }));
    if (part.length && (part.length >= s.patternDetailRows || bytes > s.publicPageBytes)) await publish();
    check(Buffer.byteLength(JSON.stringify({ v: 3, asset, rows: [row] })) <= s.publicPageBytes, 'pattern_detail_budget', 503); part.push(row);
  }
  await publish();
  const allPaths = refs.map(r => r.path);
  // Dense detail manifests are paged too. A small response budget must never
  // strand a page merely because it needs many detail files.
  while (Buffer.byteLength(JSON.stringify(refs)) > s.publicPageBytes / 2 && refs.length > 1) {
    const parents = []; let children = [];
    const parent = async () => {
      const bytes = Buffer.from(JSON.stringify({ v: 3, asset, children }));
      const ref = await files.immutable(`patterns/${asset}/${page}-detail-index-${hash(bytes)}.json`, bytes); parents.push(ref); allPaths.push(ref.path); children = [];
    };
    for (const ref of refs) {
      if (children.length && Buffer.byteLength(JSON.stringify({ v: 3, asset, children: [...children, ref] })) > s.publicPageBytes) await parent();
      children.push(ref);
    }
    if (children.length) await parent();
    check(parents.length < refs.length, 'public_page_minimum_progress', 503); refs.splice(0, refs.length, ...parents);
  }
  const body = { v: 3, asset, from, to: v2 ? rules.addUint(from, String(size - 1)) : from + size - 1, countMeaning: 'verified_submitted_blocks', encoding: 'lsb0-hex',
    found: found.toString('hex'), minted: minted.toString('hex'), details: refs, implicitAwards: '/window-eligibility' };
  const bytes = Buffer.from(JSON.stringify(body)); check(bytes.length <= s.publicPageBytes, 'pattern_manifest_budget', 503);
  const publication = await files.immutable(`patterns/${asset}/${page}-${hash(bytes)}.json`, bytes);
  await files.json(`patterns/${asset}/${page}.json`, publication, { maxBytes: s.publicPageBytes });
  allPaths.push(publication.path);
  const versionKey = `${asset}/${page}`, previous = store.get('claimedPageVersions', versionKey) ?? [], versions = [allPaths, ...previous.filter(v => !v.includes(publication.path))];
  const retained = versions.slice(0, s.feedVersions), keep = new Set(retained.flat());
  await store.transact([{ space: 'claimedPageManifests/' + asset, id: v2 ? rules.uintKeyV2(rules.decimalV2(page)) : heightKey(page), value: publication },
    { space: 'claimedPageVersions', id: versionKey, value: retained },
    ...[...new Set(versions.slice(s.feedVersions).flat())].filter(path => !keep.has(path)).map(path => ({ space: 'fileGarbage', id: path, value: true }))]);
  await files.json(`patterns/${asset}/index.json`, { v: 3, asset, pageSize: size, sparse: true, pages: '/patterns/' + asset + '/claimed-pages',
    countMeaning: 'verified_submitted_blocks', claimedBlocks: '/patterns/' + asset + '/claimed-blocks', absentMeaning: 'not_reported_or_materialized' }, { maxBytes: s.publicPageBytes });
  return publication;
}

// Each chunk changes its projection rows and completion cursor in one atomic
// transaction. Retrying after a crash neither double-counts nor skips a row.
export async function claimedEvents(feeds) {
  if (feeds.store.get('meta', 'ruleState')?.batchVersion === 2) return claimedEventsV2(feeds);
  const { store, history, files } = feeds, s = defaults(feeds.settings);
  for (const { id, value: event } of store.list('feedEvents', { limit: s.feedEventsPerTick })) {
    if (store.get('feedEventComplete', id)) { await store.put('feedEvents', id); continue; }
    const phases = ['occurrences', 'finds', 'discoveries', 'types', 'agents', 'links'];
    const cursor = store.get('feedEventCursor', id) ?? { phase: 0, offset: 0 }, phase = phases[cursor.phase];
    const source = event[phase] ?? (['finds', 'types'].includes(phase) ? {} : []), rows = Array.isArray(source) ? source : Object.values(source);
    const chunk = rows.slice(cursor.offset, cursor.offset + s.feedEventRows), operations = new Map();
    const put = (space, key, value) => operations.set(`${space}\0${key}`, { space, id: key, ...(value === undefined ? {} : { value }) });
    const get = (space, key) => operations.get(`${space}\0${key}`)?.value ?? store.get(space, key);
    const score = (owner, field) => { const old = get('catalogAgents', owner) ?? { address: owner, findCount: 0, discoveryCount: 0 }; put('catalogAgents', owner, { ...old, [field]: old[field] + 1 }); };
    const dirty = (asset, block) => put('feedPages', `${asset}/${heightKey(Math.floor(block / s.patternPageHeights))}`, { pattern: { number: parseInt(asset.slice(1), 36) }, page: Math.floor(block / s.patternPageHeights) });
    const claim = row => {
      const asset = row.asset ?? rules.patternAsset(row.pattern), key = heightKey(row.block), old = get('claimed/' + asset, key);
      put('claimed/' + asset, key, { ...old, pattern: row.pattern, count: row.count, hash: row.hash ?? old?.hash ?? history.get(row.block).hash,
        contribution: row.agent ?? old?.contribution ?? null, provenance: row.provenance ?? old?.provenance ?? null, found: !!(row.finder || old?.found), minted: !!store.get('minted', `${asset}/${row.block}`) });
      put('claimedAt/' + key, asset, true); put('claimedRevision', asset, (get('claimedRevision', asset) ?? 0) + 1); dirty(asset, row.block);
    };
    for (const row of chunk) {
      if (phase === 'finds' || phase === 'occurrences') {
        claim(row);
        if (row.finder) {
          put('agentAssets/' + row.finder, row.asset, true);
          const findId = rules.findId(row.block, row.pattern);
          if (!get('findsByAgent/' + row.finder, findId)) score(row.finder, 'findCount');
          put('findsByAgent/' + row.finder, findId, row);
        }
      }
      if (phase === 'agents') for (const asset of row.assets) put('agentAssets/' + row.owner, asset, true);
      if (phase === 'discoveries' && row.record.discoverer) {
        const owner = row.record.discoverer; put('discoverers', owner, (get('discoverers', owner) ?? 0) + 1);
        put('catalogPatterns', rules.patternAsset(row.record), row.record);
        put('discoveriesByAgent/' + owner, rules.patternAsset(row.record), row.record); score(owner, 'discoveryCount');
      }
      if (phase === 'types') put('catalogTypes', row.id, row);
      if (phase === 'links') put('feedLinkedBlocks', heightKey(row), { block: row, after: '' });
    }
    let next = { phase: cursor.phase, offset: cursor.offset + chunk.length };
    if (next.offset === rows.length) next = { phase: cursor.phase + 1, offset: 0 };
    if (next.phase === phases.length) { put('feedEvents', id); put('feedEventCursor', id); put('feedEventComplete', id, true); }
    else put('feedEventCursor', id, next);
    put('meta', 'claimedProjectionRevision', hash(`${id}/${cursor.phase}/${cursor.offset}`));
    await store.transact([...operations.values()]);
  }
  // A link touches only explicitly known assets at its block, with continuation.
  for (const { id, value } of store.list('feedLinkedBlocks', { limit: s.feedEventsPerTick })) {
    const rows = store.list('claimedAt/' + id, { after: value.after, limit: s.feedEventRows }), ops = rows.map(r => ({ space: 'feedPages', id: `${r.id}/${heightKey(Math.floor(value.block / s.patternPageHeights))}`, value: { pattern: { number: parseInt(r.id.slice(1), 36) }, page: Math.floor(value.block / s.patternPageHeights) } }));
    ops.push({ space: 'feedLinkedBlocks', id, ...(rows.length === s.feedEventRows ? { value: { ...value, after: rows.at(-1).id } } : {}) }); await store.transact(ops);
  }
}
