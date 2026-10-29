import { patternCatalogId } from './mint-assets.mjs';
import { rules } from './rules.mjs';
import { heightKey } from './util.mjs';
import { bumpProjection } from './projection-state.mjs';
import { rankingSchema, rankFind } from './public-rankings.mjs';
import { publicMintTargetVisible } from './public-mint-privacy.mjs';
export const PUBLIC_SORTS = {
  patterns: 'number name tier rarity supply minted madeReal discoverer', compounds: 'id name tier recipe supply madeReal firstMaker mass',
  agents: 'finds address discoveries crafts mints links', finds: 'block asset pattern count finder findHeight',
  discoveries: 'asset name state opensAt', balances: 'asset amount', bitmaps: 'height inscription linked', events: 'sequence at type',
  mints: 'id asset block amount kind state price', payments: 'id block action total', ethereum: 'id amount status payer',
  payouts: 'id beneficiary accrued paid owed', owed: 'id role amount to', paid: 'id amount to', links: 'block id linkHeight owner',
  claims: 'agent window reason', draws: 'window settledAt',
  credits: 'id owner amount revision', custody: 'id owner amount state', linkRequests: 'block id state owner', supply: 'asset outstanding issued burned',
};
const numeric = new Set('number tier rarity supply minted madeReal mass finds discoveries crafts mints links block pattern count findHeight amount height linked sequence at price total status accrued paid owed linkHeight window settledAt revision outstanding issued burned'.split(' '));

// All rows are projections of accepted/local verified records. No source reads
// occur here. Schema/index updates are part of the record's atomic transaction.
export function publicProjectionSchema(db) {
  rankingSchema(db);
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
export function projectPublicRecord(store, op, previous) {
  const { db } = store, id = String(op.id), row = op.value;
  const item = (kind, scope, key, value, position = key) => {
    bumpProjection(store, `items/${kind}/${scope}`);
    const existed = !!db.prepare('SELECT 1 FROM publicItemsV2 WHERE kind=? AND scope=? AND id=?').get(kind, scope, key);
    if (existed !== (value != null)) {
      const prior = db.prepare('SELECT n FROM publicItemCountsV2 WHERE kind=? AND scope=?').get(kind, scope)?.n ?? '0';
      const n = BigInt(prior) + (value == null ? -1n : 1n);
      db.prepare('INSERT OR REPLACE INTO publicItemCountsV2 VALUES(?,?,?)').run(kind, scope, String(n));
    }
    db.prepare('DELETE FROM publicOrderV2 WHERE kind=? AND scope=? AND id=?').run(kind, scope, key);
    if (value == null) db.prepare('DELETE FROM publicItemsV2 WHERE kind=? AND scope=? AND id=?').run(kind, scope, key);
    else db.prepare('INSERT OR REPLACE INTO publicItemsV2 VALUES(?,?,?,?,?,?,?,?,?)').run(kind, scope, key, JSON.stringify(value), position,
      value.owner ?? value.finder ?? value.agent ?? '', value.asset ?? '', value.block == null ? '' : rules.decimalV2(value.block), value.state ?? value.action ?? '');
    if (value != null) for (const sort of (PUBLIC_SORTS[kind] ?? 'id').split(' ')) {
      let v = sort === 'id' ? key : value[sort] ?? (sort === 'mass' ? value.properties?.mass : undefined);
      if (typeof v === 'boolean') v = Number(v);
      const order = v == null ? '' : numeric.has(sort) && /^(0|[1-9][0-9]*)$/.test(String(v)) ? rules.uintKeyV2(String(v)) : String(v);
      db.prepare('INSERT INTO publicOrderV2 VALUES(?,?,?,?,?,?,?,?,?)').run(kind, scope, sort, order, key,
        value.owner ?? value.finder ?? value.agent ?? '', value.asset ?? '', value.block == null ? '' : rules.decimalV2(value.block), value.state ?? value.action ?? '');
    }
  };
  const block = (height, field, delta) => {
    bumpProjection(store, 'world');
    const h = rules.decimalV2(height), k = rules.uintKeyV2(h);
    db.prepare('INSERT OR IGNORE INTO publicBlocksV2(heightKey,height) VALUES(?,?)').run(k, h);
    db.prepare(`UPDATE publicBlocksV2 SET ${field}=${field}+? WHERE heightKey=?`).run(delta, k);
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
    if (row) db.prepare('INSERT OR REPLACE INTO publicRightsV2 VALUES(?,?,?,?,?,?,?,?)').run(id, row.asset, h, pos, row.finder,
      rules.uintKeyV2(rules.decimalV2(row.finderUntil)), rules.uintKeyV2(rules.decimalV2(row.count)), JSON.stringify(row));
    else db.prepare('DELETE FROM publicRightsV2 WHERE id=?').run(id);
  }
  if (op.space.startsWith('findsByAgent/') && row) rankFind(store, id, row, store.get('catalogPatterns', row.asset) ?? store.get('patternsByAsset', row.asset));
  if (op.space === 'rankExpiry' && row) db.prepare('DELETE FROM publicRanksV2 WHERE kind=? AND id=?').run(row.kind, row.id);
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
    db.prepare('UPDATE claimedBlocksV2 SET minted=? WHERE asset=? AND heightKey=?').run(Number(!!row), asset, rules.uintKeyV2(height));
    bumpProjection(store, 'mintedAsset/' + asset);
  }
  if (op.space === 'publicBalances') {
    const value = row ?? previous;
    if (row) db.prepare('INSERT OR REPLACE INTO publicBalancesV2 VALUES(?,?,?,?)').run(row.owner, row.asset, row.amount, rules.uintKeyV2(row.amount));
    else if (value) db.prepare('DELETE FROM publicBalancesV2 WHERE owner=? AND asset=?').run(value.owner, value.asset);
    if (value) item('balances', value.owner, value.asset, row);
  }
  if (op.space === 'submittedBitmaps') {
    if (previous) item('bitmaps', previous.agent, id, null);
    if (row) {
      db.prepare('INSERT OR REPLACE INTO publicBitmapV2 VALUES(?,?,?,?)').run(row.block, row.agent, row.address, JSON.stringify(row));
      item('bitmaps', row.agent, id, { ...row, height: row.block, linked: !!store.get('links', heightKey(row.block)) }, id);
    } else if (previous) db.prepare('DELETE FROM publicBitmapV2 WHERE block=?').run(previous.block);
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
    item(kind, '', id, row && { id, ...row, ...(kind === 'payouts' ? { owed: String(BigInt(row.accrued) - BigInt(row.paid)) } : {}) });
  }
  if (op.space.startsWith('window/')) {
    const [, window, kind] = op.space.split('/'), value = row?.row ?? previous?.row;
    if (value?.block != null) item(kind === 'winners' ? 'draws' : kind, rules.decimalV2(value.block), id, row && { ...value, window, provenance: { batch: row.batch, audit: row.audit, root: row.root } });
  }
}
