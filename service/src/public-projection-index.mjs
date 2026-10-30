import { payoutBalance } from './payout-values.mjs';
import { patternCatalogId } from './mint-assets.mjs';
import { rules } from './rules.mjs';
import { heightKey } from './util.mjs';
import { bumpProjection, projectionStatement } from './projection-state.mjs';
import { rankingSchema, rankFind } from './public-rankings.mjs';
import { publicMintTargetVisible } from './public-mint-privacy.mjs';
import { patternSymbolSchema, assignPatternSymbol, patternSymbol } from './pattern-symbols.mjs';
export const PUBLIC_SORTS = {
  patterns: 'number name tier rarity supply minted madeReal discoverer', compounds: 'id name tier recipe supply madeReal firstMaker rank',
  agents: 'finds address discoveries crafts mints links', finds: 'block asset pattern count finder findHeight',
  discoveries: 'asset name state opensAt', balances: 'asset amount', bitmaps: 'height inscription linked', events: 'sequence at type',
  mints: 'id asset block amount kind state price', payments: 'id block action total', ethereum: 'id amount status payer',
  payouts: 'id beneficiary accrued paid owed', owed: 'id role amount to', paid: 'id amount to', links: 'block id linkHeight owner',
  claims: 'agent window reason', draws: 'window settledAt',
  credits: 'id owner amount revision', custody: 'id owner amount state', linkRequests: 'block id state owner', supply: 'asset outstanding issued burned',
};
const numeric = new Set('number tier rarity supply minted madeReal finds discoveries crafts mints links block pattern count findHeight amount height linked sequence at price total status accrued paid owed linkHeight window settledAt revision outstanding issued burned'.split(' '));

// All rows are projections of accepted/local verified records. No source reads
// occur here. Schema/index updates are part of the record's atomic transaction.
export function publicProjectionSchema(db) {
  rankingSchema(db);
  patternSymbolSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS publicItemCountsV2(kind TEXT,scope TEXT,n TEXT,PRIMARY KEY(kind,scope)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS publicItemsV2(kind TEXT,scope TEXT,id TEXT,value TEXT,position TEXT,owner TEXT,asset TEXT,block TEXT,state TEXT,PRIMARY KEY(kind,scope,id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS publicItemsV2Page ON publicItemsV2(kind,scope,position,id);
    CREATE INDEX IF NOT EXISTS publicItemsV2Owner ON publicItemsV2(kind,scope,owner,position,id);
    CREATE INDEX IF NOT EXISTS publicItemsV2Asset ON publicItemsV2(kind,scope,asset,position,id);
    CREATE INDEX IF NOT EXISTS publicItemsV2Block ON publicItemsV2(kind,scope,block,position,id);
    CREATE INDEX IF NOT EXISTS publicItemsV2State ON publicItemsV2(kind,scope,state,position,id);
    CREATE TABLE IF NOT EXISTS publicBlocksV2(heightKey TEXT PRIMARY KEY,height TEXT,finds INTEGER DEFAULT 0,mints INTEGER DEFAULT 0,linked INTEGER DEFAULT 0) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS publicBlocksV2Found ON publicBlocksV2(finds,heightKey);
    CREATE TABLE IF NOT EXISTS publicRightsV2(id TEXT PRIMARY KEY,asset TEXT,block TEXT,heightKey TEXT,finder TEXT,untilKey TEXT,countKey TEXT,value TEXT) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS publicRightsV2Asset ON publicRightsV2(asset,heightKey,id);
    CREATE INDEX IF NOT EXISTS publicRightsV2Finder ON publicRightsV2(finder,untilKey,heightKey,id);
    CREATE INDEX IF NOT EXISTS publicRightsV2Height ON publicRightsV2(heightKey,id);
    CREATE TABLE IF NOT EXISTS publicBalancesV2(owner TEXT,asset TEXT,amount TEXT,amountKey TEXT,PRIMARY KEY(owner,asset)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS publicBitmapV2(block TEXT PRIMARY KEY,agent TEXT,address TEXT,value TEXT) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS publicBitmapV2Agent ON publicBitmapV2(agent,block);`);
  db.exec(`CREATE TABLE IF NOT EXISTS publicOrderV2(kind TEXT,scope TEXT,sort TEXT,key TEXT,id TEXT,owner TEXT,asset TEXT,block TEXT,state TEXT,PRIMARY KEY(kind,scope,sort,key,id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS publicOrderV2Identity ON publicOrderV2(kind,scope,id);
    CREATE INDEX IF NOT EXISTS publicOrderV2Owner ON publicOrderV2(kind,scope,sort,owner,key,id);
    CREATE INDEX IF NOT EXISTS publicOrderV2Asset ON publicOrderV2(kind,scope,sort,asset,key,id);
    CREATE INDEX IF NOT EXISTS publicOrderV2Block ON publicOrderV2(kind,scope,sort,block,key,id);
    CREATE INDEX IF NOT EXISTS publicOrderV2State ON publicOrderV2(kind,scope,sort,state,key,id);`);
}
// Pattern ledger assets: v2 p2:N, and imported v1 patterns that keep their ledger asset (p0).
export const patternLedgerAsset = asset => typeof asset === 'string' && (asset.startsWith('p2:') || /^p[0-9a-z]{1,23}$/.test(asset));
const publicSpaces = new Set(['catalogPatterns', 'catalogTypes', 'catalogAgents', 'finds', 'rankExpiry', 'links', 'minted',
  'publicBalances', 'submittedBitmaps', 'publicEvents', 'publicSupply', 'mints', 'linkRequests', 'payoutTotals', 'commissionOwed', 'payoutPaid']);
export const consumesPublicRecord = space => publicSpaces.has(space) || ['discoveriesByAgent/', 'findsByAgent/', 'publicResults/', 'window/'].some(prefix => space.startsWith(prefix));
const sortsByKind = new Map(Object.entries(PUBLIC_SORTS).map(([kind, sorts]) => [kind, sorts.split(' ')]));
// v2 compounds carry their tier as { value, expression }.
const tierOf = value => value?.tier?.value ?? value?.tier;
// Compound standing: highest tier, then highest generation, then newest snapshot.
const rankKey = value => [tierOf(value), value.properties?.generation, value.snapshot?.height]
  .map(v => rules.uintKeyV2(/^(0|[1-9][0-9]*)$/.test(String(v ?? '')) ? String(v) : '0')).join('');
function sortKey(value, sort, id) {
  if (sort === 'rank') return rankKey(value);
  let v = sort === 'id' ? id : sort === 'tier' ? tierOf(value) : value[sort];
  if (typeof v === 'boolean') v = Number(v);
  return v == null ? '' : numeric.has(sort) && /^(0|[1-9][0-9]*)$/.test(String(v)) ? rules.uintKeyV2(String(v)) : String(v);
}
function writeItem(store, { kind, scope, key, value, position, rebuild }) {
  const sql = text => projectionStatement(store.db, text);
  const previous = sql('SELECT value,position,owner,asset,block,state FROM publicItemsV2 WHERE kind=? AND scope=? AND id=?').get(kind, scope, key);
  if (!!previous !== (value != null)) {
    const prior = sql('SELECT n FROM publicItemCountsV2 WHERE kind=? AND scope=?').get(kind, scope)?.n ?? '0';
    sql('INSERT OR REPLACE INTO publicItemCountsV2 VALUES(?,?,?)').run(kind, scope, String(BigInt(prior) + (value == null ? -1n : 1n)));
  }
  if (value == null) {
    if (previous) {
      sql('DELETE FROM publicOrderV2 WHERE kind=? AND scope=? AND id=?').run(kind, scope, key);
      sql('DELETE FROM publicItemsV2 WHERE kind=? AND scope=? AND id=?').run(kind, scope, key);
    }
    return;
  }
  const text = JSON.stringify(value), columns = [value.owner ?? value.finder ?? value.agent ?? '', value.asset ?? '',
    value.block == null ? '' : rules.decimalV2(value.block), value.state ?? value.action ?? ''];
  const changedColumns = previous && ['owner', 'asset', 'block', 'state'].some((name, i) => previous[name] !== columns[i]);
  if (!rebuild && previous && previous.value === text && previous.position === position && !changedColumns) return;
  sql('INSERT INTO publicItemsV2 VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,scope,id) DO UPDATE SET value=excluded.value,position=excluded.position,owner=excluded.owner,asset=excluded.asset,block=excluded.block,state=excluded.state')
    .run(kind, scope, key, text, position, ...columns);
  if (changedColumns) sql('UPDATE publicOrderV2 SET owner=?,asset=?,block=?,state=? WHERE kind=? AND scope=? AND id=?').run(...columns, kind, scope, key);
  // Explicit migrations repair old/inconsistent sort rows as well as values.
  if (rebuild) sql('DELETE FROM publicOrderV2 WHERE kind=? AND scope=? AND id=?').run(kind, scope, key);
  const old = !rebuild && previous ? JSON.parse(previous.value) : null;
  for (const sort of sortsByKind.get(kind) ?? ['id']) {
    const order = sortKey(value, sort, key), prior = old === null ? null : sortKey(old, sort, key);
    if (old !== null && order === prior) continue;
    if (old !== null) sql('DELETE FROM publicOrderV2 WHERE kind=? AND scope=? AND sort=? AND key=? AND id=?').run(kind, scope, sort, prior, key);
    sql('INSERT INTO publicOrderV2 VALUES(?,?,?,?,?,?,?,?,?)').run(kind, scope, sort, order, key, ...columns);
  }
}
export function flushPublicItems(store) {
  for (const item of store.projectionItems?.values() ?? []) writeItem(store, item);
  store.projectionItems?.clear();
}
export function projectPublicRecord(store, op, previous, { rebuild = false } = {}) {
  const { db } = store, id = String(op.id);
  let row = op.value;
  if (row && op.space === 'catalogPatterns') row = { ...row, symbol: assignPatternSymbol(store, id, row.name) };
  if (row && op.space.startsWith('discoveriesByAgent/')) row = { ...row, symbol: patternSymbol(store, id) };
  const item = (kind, scope, key, value, position = key) => {
    // Preserve every logical invalidation, even when physical writes coalesce.
    bumpProjection(store, `items/${kind}/${scope}`);
    const entry = { kind, scope, key, value, position, rebuild }, identity = JSON.stringify([kind, scope, key]);
    if (!store.projectionItems) return writeItem(store, entry);
    // Iterable journal transactions can be arbitrarily large. Keep this bounded.
    const pending = store.projectionItems.get(identity);
    if (store.projectionItems.size >= 128 || pending &&
      (pending.position !== position || JSON.stringify(pending.value ?? null) !== JSON.stringify(value ?? null))) flushPublicItems(store);
    store.projectionItems.set(identity, entry);
  };
  const block = (height, field, delta) => {
    bumpProjection(store, 'world');
    const h = rules.decimalV2(height), k = rules.uintKeyV2(h);
    projectionStatement(db, 'INSERT OR IGNORE INTO publicBlocksV2(heightKey,height) VALUES(?,?)').run(k, h);
    projectionStatement(db, `UPDATE publicBlocksV2 SET ${field}=${field}+? WHERE heightKey=?`).run(delta, k);
  };
  if (op.space.startsWith('discoveriesByAgent/')) item('discoveries', op.space.slice(19), id, row && { ...row, asset: id, state: 'accepted' });
  if (op.space === 'catalogPatterns') item('patterns', '', id, row && { ...row, asset: id, rarity: row.knownMatchCount, countMeaning: 'verified_submitted_blocks' }, row ? rules.uintKeyV2(rules.decimalV2(row.number)) : id);
  if (op.space === 'catalogTypes') item('compounds', '', id, row);
  if (op.space === 'catalogAgents') item('agents', '', id, row && { ...row, finds: row.findCount, discoveries: row.discoveryCount,
    crafts: row.craftCount ?? '0', mints: row.mintCount ?? '0', links: row.linkCount ?? '0' }, row ? rules.uintKeyV2(rules.decimalV2(row.findCount)) : id);
  if (op.space === 'finds' && patternLedgerAsset((row ?? previous)?.asset)) {
    const f = row ?? previous, h = rules.decimalV2(f.block), pos = rules.uintKeyV2(h);
    for (const scope of ['', 'owner/' + f.finder, 'block/' + h]) item('finds', scope, id, row, pos);
    block(h, 'finds', Number(!!row) - Number(!!previous));
    if (row) projectionStatement(db, 'INSERT OR REPLACE INTO publicRightsV2 VALUES(?,?,?,?,?,?,?,?)').run(id, row.asset, h, pos, row.finder,
      rules.uintKeyV2(rules.decimalV2(row.finderUntil)), rules.uintKeyV2(rules.decimalV2(row.count)), JSON.stringify(row));
    else projectionStatement(db, 'DELETE FROM publicRightsV2 WHERE id=?').run(id);
  }
  if (op.space.startsWith('findsByAgent/') && row) rankFind(store, id, row, store.get('catalogPatterns', row.asset) ?? store.get('patternsByAsset', row.asset));
  if (op.space === 'rankExpiry' && row) projectionStatement(db, 'DELETE FROM publicRanksV2 WHERE kind=? AND id=?').run(row.kind, row.id);
  if (op.space === 'links') {
    const value = row ?? previous;
    if (value?.block != null) {
      const h = rules.decimalV2(value.block);
      item('links', '', id, row, rules.uintKeyV2(h)); block(h, 'linked', Number(!!row) - Number(!!previous));
    }
  }
  if (op.space === 'minted' && patternLedgerAsset(id.split('/')[0])) {
    const [ledger, height] = id.split('/'), asset = patternCatalogId(ledger);
    block(height, 'mints', Number(!!row) - Number(!!previous));
    projectionStatement(db, 'UPDATE claimedBlocksV2 SET minted=? WHERE asset=? AND heightKey=?').run(Number(!!row), asset, rules.uintKeyV2(height));
    bumpProjection(store, 'mintedAsset/' + asset);
  }
  if (op.space === 'publicBalances') {
    const value = row ?? previous;
    if (row) projectionStatement(db, 'INSERT OR REPLACE INTO publicBalancesV2 VALUES(?,?,?,?)').run(row.owner, row.asset, row.amount, rules.uintKeyV2(row.amount));
    else if (value) projectionStatement(db, 'DELETE FROM publicBalancesV2 WHERE owner=? AND asset=?').run(value.owner, value.asset);
    if (value) item('balances', value.owner, value.asset, row);
  }
  if (op.space === 'submittedBitmaps') {
    if (previous) item('bitmaps', previous.agent, id, null);
    if (row) {
      projectionStatement(db, 'INSERT OR REPLACE INTO publicBitmapV2 VALUES(?,?,?,?)').run(row.block, row.agent, row.address, JSON.stringify(row));
      item('bitmaps', row.agent, id, { ...row, height: row.block, linked: !!store.get('links', heightKey(row.block)) }, id);
    } else if (previous) projectionStatement(db, 'DELETE FROM publicBitmapV2 WHERE block=?').run(previous.block);
  }
  if (op.space === 'publicEvents') {
    item('events', '', id, row, row ? rules.uintKeyV2(rules.decimalV2(row.sequence)) : id);
    for (const owner of new Set(Object.values((previous ?? {}).data ?? {}).filter(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)))) item('events', owner, id, null);
    for (const owner of new Set(Object.values(row?.data ?? {}).filter(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)))) item('events', owner, id, row, rules.uintKeyV2(rules.decimalV2(row.sequence)));
  }
  // Producers write only verified public results, never raw payer requests,
  // quote authorizations, signatures or secrets. Financial integrations retain
  // this named write contract for each terminal/change event.
  if (op.space.startsWith('publicResults/')) item(op.space.slice(14), '', id, row);
  if (op.space === 'publicSupply') item('supply', '', id, row);
  if (op.space === 'mints' && (row ?? previous)?.request?.v !== 2) {
    item('mints', '', id, row && !publicMintTargetVisible(store, row) ? { id, requestId: id, kind: row.kind, state: row.state, price: row.quote?.price ?? null } : row && { id, requestId: id, asset: row.request.asset, block: row.request.block ?? null,
      amount: row.request.amount, owner: row.request.owner, receiver: row.receiver, kind: row.kind,
      state: row.state, price: row.quote?.price ?? null, inscription: row.mintInscription ?? null,
      checkedAt: row.checkedAt ?? null, source: 'verified_request_projection' });
    for (const receipt of row?.payment?.receipts ?? []) if (receipt.accepted) item('payments', '', receipt.key, {
      id: receipt.key, requestId: receipt.origin ?? id, reference: receipt.reference ?? null, payer: row.payer,
      role: receipt.role, to: receipt.to, ticker: receipt.ticker, amount: receipt.amount, total: receipt.amount,
      confirmations: receipt.confirmations, final: receipt.confirmations >= (row.payment.requiredConfirmations ?? 1), action: 'paid' });
    if (row?.kind === 'ethereum' && row.payment?.depositFinal) item('ethereum', '', id, { id,
      payer: row.payer, amount: row.payment.depositAmount, state: row.state, split: row.payment.split ?? null,
      checkedAt: row.checkedAt ?? null, source: 'verified_request_projection' });
  }
  if (op.space === 'linkRequests' && row?.paymentEvidence) item('payments', '', row.paymentId, {
    id: row.paymentId, requestId: id, block: row.request.height, action: row.paymentEvidence.consumed ? 'consumed' : 'funded',
    total: row.paymentEvidence.total ?? row.paymentEvidence.amount ?? null, source: 'verified_link_payment',
    confirmations: row.paymentEvidence.confirmations ?? null });
  if (['payoutTotals', 'commissionOwed', 'payoutPaid'].includes(op.space)) {
    const kind = { payoutTotals: 'payouts', commissionOwed: 'owed', payoutPaid: 'paid' }[op.space];
    item(kind, '', id, row && { id, ...row, ...(kind === 'payouts' ? payoutBalance(store, row) : {}) });
  }
  if (op.space.startsWith('window/')) {
    const [, window, kind] = op.space.split('/'), value = row?.row ?? previous?.row;
    if (value?.block != null) item(kind === 'winners' ? 'draws' : kind, rules.decimalV2(value.block), id, row && { ...value, window, provenance: { batch: row.batch, audit: row.audit, root: row.root } });
  }
  // Catalog/discovery records are themselves public projections. Persist the
  // derived display field there too, without changing the journal operation,
  // patternsByAsset, accepted feed events or authenticated evidence.
  return row === op.value ? op : { ...op, value: row };
}
