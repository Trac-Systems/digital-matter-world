import { listFeeCredits, applyMatchingCredit } from './financial-credit.mjs';
import { hashObject } from '../../rules/src/core.js';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { runTool } from './tools.mjs';
import { stableJSON, compoundIdentityV4Active, COMPOUND_IDENTITY_V4_MERGES, validateCompoundMerges } from '../../rules/src/index.js';
import { nextCursor, isAsset } from './api-values.mjs';
import { safeCode } from './errors.mjs';
import { financialMintId } from '../../rules/src/financial-mint.js';
import { quoteBulkMint, makeBulkMint } from './bulk-mint.mjs';
import { wireIdentities, decodeTracAddress, encodeTracAddress } from '../../rules/src/trac-address.js';
import { verifyBinding } from '../../rules/src/payout-bindings.mjs';
import { compoundTickerMessage, validateOfficialTicker } from '../../rules/src/ticker-grammar.js';
import { signBytes } from './signing.mjs';
import { formatTnk } from './tnk-values.mjs';
import { previewCraftNamed } from './craft-v2.mjs';
import { BulkLinkWorker } from './bulk-link.mjs';
import { linkBlocks } from './link-jobs.mjs';

export function dashboardCheck(ok, code, status = 400) {
  if (!ok) throw Object.assign(Error(code), { code, status });
}
export const dashboardError = error => safeCode(error?.code ?? error?.message, 'dashboard_request_failed');

const digest = value => createHash('sha256').update(value).digest('hex');
// Open bulk orders per agent, as the gateway's bulkOrdersPerAgent default; later orders wait for a slot.
const BULK_LIVE_ORDERS = 24;
const assetId = asset => /^p2:(0|[1-9][0-9]{0,77})$/.test(asset ?? '') || /^p[0-9a-z]{1,23}$/.test(asset ?? '');
const canonicalAsset = asset => /^p[0-9a-z]{1,23}$/.test(asset ?? '')
  ? 'p2:' + [...asset.slice(1)].reduce((n, c) => n * 36n + BigInt(parseInt(c, 36)), 0n) : asset;
const sameSlot = (a, b) => canonicalAsset(a.asset) === canonicalAsset(b.asset) && String(a.block) === String(b.block);
const integer = value => (typeof value === 'string' || Number.isSafeInteger(value) && value >= 0) && /^(0|[1-9][0-9]{0,77})$/.test(String(value));
const requestId = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const claimSources = ['finds', 'allowed', 'blocked'];
function claimCursor(value) {
  if (value === undefined) return { source: 'finds' };
  dashboardCheck(typeof value === 'string' && value.length <= 16384, 'invalid_cursor');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { /* validated below */ }
  dashboardCheck(decoded && claimSources.includes(decoded.source) && Object.keys(decoded).every(k => ['source', 'cursor'].includes(k)) &&
    (decoded.cursor === undefined || typeof decoded.cursor === 'string' && decoded.cursor.length <= 8192), 'invalid_cursor');
  return decoded;
}
const encodeClaimCursor = value => value ? Buffer.from(JSON.stringify(value)).toString('base64url') : null;
// The pattern overview reads a few public pages per pattern; it is cached
// briefly so the page's 15 s refresh and its filter clicks share one read.
const PATTERN_TTL = 5000, PATTERN_LIMIT = 24, COUNT_PAGES = 2;
const patternNumber = asset => { try { return BigInt(canonicalAsset(asset).slice(3)); } catch { return 0n; } };
// Token state from the read-only deployment state: deployed, the pattern
// inscription is in a block (the token deployment follows), or not yet.
function tokenState(deployment) {
  if (!deployment) return 'unknown';
  if (deployment.state === 'registered') return 'deployed';
  if (deployment.elementId || deployment.phase === 'deployment' || deployment.state === 'confirming') return 'inscribed';
  return 'not_deployed';
}

// Send units on Trac: one list of rows (recipient trac1…, unit, amount).
// Rows are grouped into one transfer action per recipient, at most 16 units
// each (the transfer move's limit); larger groups split into more actions.
export const SEND_ROWS = 200, SEND_ASSETS = 16, SEND_GROUPS = 50;
const amountText = value => typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value.trim());
// Paste format: one line per row, "address, unit, amount". Commas, tabs,
// semicolons or spaces separate; the unit may be a name of several words.
export function parseSendList(text) {
  dashboardCheck(typeof text === 'string' && text.length <= 100000, 'send_list');
  const rows = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[,;\t ]+/).filter(Boolean);
    rows.push({ line: index + 1, to: parts[0] ?? '', unit: parts.slice(1, -1).join(' '), amount: parts.length > 1 ? parts.at(-1) : '' });
  }
  dashboardCheck(rows.length <= SEND_ROWS, 'send_too_many_rows');
  return rows;
}
// Valid rows → transfer actions: one per recipient, units summed, split
// above SEND_ASSETS. Input order of recipients and units is kept.
export function groupSends(rows) {
  const byRecipient = new Map();
  for (const row of rows) {
    const key = decodeTracAddress(row.to), units = byRecipient.get(key) ?? new Map();
    units.set(row.asset, (units.get(row.asset) ?? 0n) + BigInt(row.amount)); byRecipient.set(key, units);
  }
  const groups = [];
  for (const [key, units] of byRecipient) {
    const assets = [...units].map(([asset, amount]) => [asset, String(amount)]);
    for (let i = 0; i < assets.length; i += SEND_ASSETS) groups.push({ to: encodeTracAddress(key), assets: assets.slice(i, i + SEND_ASSETS) });
  }
  return groups;
}
// Gateway refusals before acceptance that clear with the next batch.
const SEND_LATER = ['sender_rate', 'next_batch_work_capacity', 'next_batch_byte_capacity', 'next_batch_account_capacity', 'closure_backlog_capacity', 'request_rate', 'service_busy'];
const SEND_RECENT = 10, CONFIRM_PAGES = 2, CONFIRM_TTL = 10000;
// TNK, the Trac network's own coin (gas): balance and fee reads are cached a
// few seconds; each send keeps one action ID for every retry.
// Craft: a pattern's charge is its number mod 65521 and its spectrum one bit
// for the header field it matches (rules/src/compounds-v2.js).
const CHARGE_MOD = 65521n, SPECTRUM_FIELD = { 4: 1, 10: 2, 11: 4 }, CRAFT_RECENT = 10, CRAFT_TTL = 60000;
// A compound's name uses its ingredients' names as people read them: dmwnullspar → Nullspar.
const niceName = name => /^dmw[a-z0-9]{2,29}$/.test(name) ? name[3].toUpperCase() + name.slice(4) : name;
const tierValue = tier => tier && typeof tier === 'object' ? tier.value ?? null : Number.isSafeInteger(tier) ? tier : null;
// A compound record's inputs: accepted records list {asset,amount}; older
// projections list [asset, amount].
const compoundInputs = row => (Array.isArray(row?.inputs) ? row.inputs : []).map(i => Array.isArray(i) ? i : [i?.asset, i?.amount])
  .filter(([asset, amount]) => typeof asset === 'string' && integer(amount));
const TNK_TTL = 5000, TNK_RECENT = 10, TNK_RESEND_AFTER = 120000;
const TNK_LATER = ['tnk_validators', 'tnk_fee_unavailable', 'tnk_balance_unavailable', 'tnk_unavailable'];
const tnkFailure = error => {
  const code = dashboardError(error);
  return code.startsWith('tnk_') ? Object.assign(Error(code), { code, status: TNK_LATER.includes(code) ? 503 : 400 }) : error;
};

// Financial requests are independently identified. Mining's per-tip move
// allowance must not make a human's mint click wait for another Bitcoin block.
export function dashboardJournal(journal) {
  return Object.assign(Object.create(journal), { rateJournal: journal, waitTurn: async getHead => getHead(), finishTurn() {} });
}

// A payment or mint the gateway has seen on Bitcoin and that waits for its confirmation (display only).
const sentOnBitcoin = (inflight, phases) => /^[0-9a-f]{64}$/.test(inflight?.revealTxid ?? '') && phases.includes(inflight.phase) ? inflight : null;
export class DashboardState {
  constructor(context) {
    this.context = context; this.agent = context.agent;
    dashboardCheck(!this.agent.dryRun, 'dashboard_requires_live_signer');
    this.journal = this.agent.journal; this.service = this.agent.service;
    this.bulkLinks = context.bulkLinks ?? new BulkLinkWorker(this.agent);
    this.inflight = new Map(); this.names = new Map(); this.closed = false;
    this.batch = null; this.batchTask = null; this.walletLocks = new Map(); this.instance = randomUUID();
    this.journal.db.exec('CREATE TABLE IF NOT EXISTS dashboard_wallet (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,key))');
    this.journal.db.exec('CREATE TABLE IF NOT EXISTS dashboard_sends (scope TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,id))');
    this.labels = new Map(); this.sendTail = Promise.resolve(); this.sending = new Set(); this.confirmCache = null;
    this.journal.db.exec('CREATE TABLE IF NOT EXISTS dashboard_tnk (scope TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,id))');
    this.tnkCache = null; this.tnkTail = Promise.resolve(); this.tnkSending = new Set(); this.tnkStatus = new Map();
    this.journal.db.exec('CREATE TABLE IF NOT EXISTS dashboard_crafts (scope TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,id))');
    this.craftTail = Promise.resolve(); this.crafting = new Set(); this.craftEvents = null; this.craftContext = null; this.craftReads = new Map();
    this.journal.db.exec('CREATE TABLE IF NOT EXISTS dashboard_bulk (scope TEXT NOT NULL, action TEXT NOT NULL, order_id TEXT, live INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,action)); CREATE INDEX IF NOT EXISTS dashboard_bulk_live ON dashboard_bulk(scope,live); CREATE INDEX IF NOT EXISTS dashboard_bulk_order ON dashboard_bulk(scope,order_id); CREATE TABLE IF NOT EXISTS dashboard_bulk_planner (scope TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS dashboard_bulk_seen (scope TEXT NOT NULL, planner TEXT NOT NULL, slot TEXT NOT NULL, PRIMARY KEY(scope,planner,slot));');
    const planner = this.journal.db.prepare('SELECT value FROM dashboard_bulk_planner WHERE scope=?').get(this.journal.scope);
    this.batch = planner ? JSON.parse(planner.value) : null;

  }
  activate() {
    const db = this.journal.db;
    db.exec('CREATE TABLE IF NOT EXISTS dashboard_runtime (scope TEXT PRIMARY KEY, pid INTEGER NOT NULL, instance TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = db.prepare('SELECT pid FROM dashboard_runtime WHERE scope=?').get(this.journal.scope);
      if (old) {
        let alive = true;
        try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        dashboardCheck(!alive, 'dashboard_already_running', 409);
      }
      db.prepare('INSERT OR REPLACE INTO dashboard_runtime(scope,pid,instance) VALUES(?,?,?)').run(this.journal.scope, process.pid, this.instance);
      db.exec('COMMIT'); this.active = true;
      this.bulkLinks.start();
      if (this.batch && ['running', 'waiting_slots'].includes(this.batch.state)) this.bulkTimer = setTimeout(() => this.resumeBulkPlanner(), 0).unref();
    } catch (error) {
      if (this.active) { db.prepare('DELETE FROM dashboard_runtime WHERE scope=? AND instance=?').run(this.journal.scope, this.instance); this.active = false; }
      else db.exec('ROLLBACK');
      throw error;
    }
  }
  savedMints() {
    return this.journal.db.prepare("SELECT id FROM actions WHERE scope=? AND id LIKE 'mint/%' AND id NOT LIKE '%/reservation-v2' ORDER BY rowid DESC")
      .all(this.journal.scope).map(({ id }) => this.journal.get(id)).filter(row => row.body?.request && !(row.state === 'rejected' && row.result?.reason === 'financial_request_expired'));
  }
  // Saved requests of this block that expired before the gateway took them; each later click signs anew.
  expiredSlot(slot) {
    return this.journal.db.prepare("SELECT id FROM actions WHERE scope=? AND id LIKE 'mint/%' AND id NOT LIKE '%/reservation-v2' AND state='rejected'")
      .all(this.journal.scope).map(({ id }) => this.journal.get(id)).filter(row => row.body?.request && row.result?.reason === 'financial_request_expired' &&
        sameSlot(row.body.request, slot) && (row.body.request.deployment ?? null) === (slot.deployment ?? null)).length;
  }
  savedSlot(slot) { return this.savedMints().find(row => sameSlot(row.body.request, slot) && (row.body.request.deployment ?? null) === (slot.deployment ?? null)); }
  idOf(row) { return financialMintId(this.agent.network, row.body.request); }
  // Retire only requests that cannot issue a permit: a rejected reservation,
  // or an accepted terminal refund/credit that released its units. Keep the
  // original signed packet in the journal so recovery and retries stay exact.
  retireDead(row, status, error, counted) {
    const dead = status?.state === 'expired' && (status.reason === 'reservation_expired' ||
      ['credited', 'refunded'].includes(status.funding?.state) && ['refunded', 'released', 'expired'].includes(status.reservation)) ||
      error === 'request_not_found' && counted !== undefined && BigInt(row.body.request.until) < BigInt(counted);
    if (dead) this.journal.mark(row.id, 'rejected', { reason: 'financial_request_expired' });
    return dead;
  }
  async countedHeight() { try { return String((await this.agent.trac.head()).counted); } catch { return undefined; } }
  async payout() {
    const binding = wireIdentities((await this.service.payoutBinding(this.agent.address, 'tap')).binding);
    dashboardCheck(binding, 'finder_address_missing', 409);
    verifyBinding(binding, { network: this.agent.network, bitcoinNetwork: this.agent.bitcoinNetwork, members: this.service.receiptSigners });
    dashboardCheck(binding.request.agent === this.agent.owner && binding.request.rail === 'tap', 'payout_binding_mismatch', 409);
    return binding.request.address;
  }
  async info() {
    let payoutAddress = null, payoutError = null;
    try { payoutAddress = await this.payout(); } catch (error) { payoutError = dashboardError(error); }
    return { address: this.agent.address, network: this.agent.network, bitcoinNetwork: this.agent.bitcoinNetwork,
      payoutAddress, payoutError, batch: this.batch, merged: Object.fromEntries(this.merged()) };
  }
  // Older compound ids merged into the compound they became (the published merge record of this network):
  // saved sends and crafts that name an old id show and link the compound it is now.
  merged() { return this.mergedIds ??= COMPOUND_IDENTITY_V4_MERGES.network === this.agent.network ? validateCompoundMerges(COMPOUND_IDENTITY_V4_MERGES) : new Map(); }
  async candidate(slot) {
    dashboardCheck(assetId(slot.asset) && integer(slot.block) && (slot.deployment === undefined || typeof slot.deployment === 'string' && slot.deployment.length > 0), 'invalid_claim');
    const rows = await this.context.candidates(slot.asset, { block: slot.block, kind: 'tap', ...(slot.deployment ? { deployment: slot.deployment } : {}) });
    const candidate = rows.find(row => row.find && sameSlot(row.find, slot));
    dashboardCheck(candidate, 'mint_right_unavailable', 403);
    dashboardCheck(integer(candidate.find.count) && BigInt(candidate.find.count) > 0n, 'invalid_claim_response', 502);
    return candidate;
  }
  role(candidate) { return candidate.right ?? candidate.whoMayMint; }
  eligible(candidate) {
    if (!(candidate.rightAllowed === true || candidate.allowed === true)) return false;
    const role = this.role(candidate);
    return role === 'finder' ? wireIdentities(candidate.find).finder === this.agent.owner :
      role === 'bitmap' ? wireIdentities(candidate).currentHolder === this.agent.owner : role === 'public';
  }
  async balance(asset) {
    let cursor; const seen = new Set();
    do {
      const page = await this.service.profile(this.agent.address, { collection: 'balances', asset, limit: 50, cursor });
      dashboardCheck(Array.isArray(page.balances), 'invalid_balance_page', 502);
      const row = page.balances.find(row => row.asset === asset);
      if (row) {
        dashboardCheck(integer(row.amount), 'invalid_balance_response', 502);
        return { amount: String(row.amount), current: row.current !== false && !row.blocked, reason: row.blocked ?? null };
      }
      cursor = nextCursor(page);
      dashboardCheck(!cursor || !seen.has(cursor), 'repeated_cursor', 502); seen.add(cursor);
    } while (cursor);
    return { amount: '0', current: true, reason: null };
  }
  mintReason(c, balance) {
    if (!this.eligible(c)) return this.role(c) === 'finder' ? 'mint_finder' : this.role(c) === 'bitmap' ? 'mint_bitmap' : 'mint_right_unavailable';
    if (c.minted) return 'already_minted';
    if (c.void) return 'mint_right_unavailable';
    if (c.pending) return 'block_pending';
    if (!balance.current || c.balance === null) return balance.reason ?? 'balance_projection_pending';
    if (BigInt(balance.amount) < BigInt(c.find.count)) return 'insufficient_balance';
    return c.allowed === true ? null : c.reason ?? 'mint_right_unavailable';
  }
  async pattern(asset) {
    const key = canonicalAsset(asset);
    if (!this.names.has(key)) {
      const row = (await this.service.patterns({ asset: key, limit: 1 })).patterns?.[0];
      this.names.set(key, { name: row?.name ?? asset, tier: row?.tier ?? null });
    }
    return this.names.get(key);
  }
  async name(asset, fallback) { return fallback || (await this.unitLabel(asset)).name; }
  async claim(row, c, balance) {
    dashboardCheck(assetId(row.asset) && integer(row.block), 'invalid_claim_response', 502);
    const saved = this.savedSlot(row);
    let id = saved ? this.idOf(saved) : c.pending?.id;
    let status = null, statusError = null;
    if (requestId(id)) try { status = await this.status(id, row); } catch (error) { statusError = dashboardError(error); }
    if (statusError === 'not_your_request') { id = null; statusError = null; }
    if (saved && this.retireDead(saved, status, statusError, this.claimCounted)) return this.claim(row, c, balance);
    // The gateway's hold can belong to a bulk order rather than a single request: no request page to open.
    const bulkHold = !saved && !!c.pending && statusError === 'request_not_found';
    if (bulkHold) { id = null; statusError = null; }
    // A saved request the gateway never took: Mint resumes it with the same signature.
    const resume = !!saved && !c.pending && statusError === 'request_not_found';
    if (resume) statusError = null;
    const minted = !!(row.minted || c.minted || status?.state === 'minted');
    const pending = !minted && status?.state !== 'expired' && !!(c.pending || (saved && !resume) || status);
    const inOrder = !minted && !status && !!this.bulkHeld?.has(canonicalAsset(c.find.asset) + '/' + String(row.block)) || !minted && bulkHold;
    const reason = statusError ?? (inOrder ? 'in_bulk_order' : this.mintReason(c, balance) || null);
    return { asset: row.asset, block: String(row.block), ...(c.deployment ? { deployment: c.deployment } : {}), count: String(c.find.count),
      name: await this.name(row.asset, row.name ?? row.pattern?.name), minted, pending,
      payable: !minted && status?.payable === true, requestId: requestId(id) ? id : null,
      bulkOrder: inOrder ? this.bulkHeld?.get(canonicalAsset(c.find.asset) + '/' + String(row.block)) ?? null : null,
      state: minted ? 'minted' : status?.state ?? (pending ? 'pending' : 'unminted'),
      canMint: !minted && !reason && (!saved || resume) && !status,
      reason, role: this.role(c), eligibility: { finder: 'own find', bitmap: 'Bitmap holder', public: 'units' }[this.role(c)],
      balance: balance.amount, balanceCurrent: balance.current && c.balance !== null,
      finderUntil: c.finderUntil ?? c.find.finderUntil ?? null,
      findHeight: c.find.findHeight ?? null,
      deploymentLink: !minted && !pending && !saved && reason === 'asset_unregistered'
        ? this.service.deploymentLink(canonicalAsset(row.asset), this.agent.address, this.agent.paymentOrigin) : null,
      paymentLink: requestId(id) ? this.service.paymentLink(id, this.agent.paymentOrigin) : null };
  }
  // asset: one pattern only, in the form the gateway lists it (see patterns()).
  async claims({ cursor, limit = 25, asset, deployment } = {}) {
    dashboardCheck(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'invalid_page_limit');
    dashboardCheck(asset === undefined || assetId(asset), 'invalid_asset');
    dashboardCheck(!deployment || asset && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(deployment), 'invalid_deployment');
    let position = claimCursor(cursor);
    const claims = [], balances = new Map();
    this.bulkHeld = this.bulkHeldBlocks(); this.claimCounted = await this.countedHeight();
    // The sources are disjoint: own finder-week rows, then other allowed and
    // blocked eligible rows. Each gateway cursor retains its filters/order.
    while (position && claims.length < limit) {
      const { source } = position;
      const options = { limit: limit - claims.length, sort: 'block', order: 'desc', cursor: position.cursor, minted: false, ...(asset ? { asset } : {}), ...(deployment ? { deployment } : {}) };
      const page = source === 'finds' && !deployment
        ? await this.service.profile(this.agent.address, { ...options, collection: 'finds' })
        : await this.service.mintRights(this.agent.address, { ...options, ...(source === 'finds' ? { whoMayMint: 'finder' } : { allowed: source === 'allowed' }) });
      const entries = source === 'finds' && !deployment ? page.finds : page.mintRights;
      dashboardCheck(Array.isArray(entries), 'invalid_claim_page', 502);
      for (let i = 0; i < entries.length; i += 4) {
        const rows = await Promise.all(entries.slice(i, i + 4).map(async row => {
          if (row.compound || asset && canonicalAsset(row.asset) !== canonicalAsset(asset)) return null;
          const c = await this.candidate(row);
          if (row.minted || c.minted || !this.eligible(c)) return null;
          if ((this.role(c) === 'finder') !== (source === 'finds')) return null;
          if (!balances.has(c.find.asset)) balances.set(c.find.asset, this.balance(c.find.asset));
          return this.claim(row, c, await balances.get(c.find.asset));
        }));
        claims.push(...rows.filter(row => row && !row.minted));
      }
      const continuation = nextCursor(page);
      dashboardCheck(!continuation || continuation !== position.cursor, 'repeated_cursor', 502);
      const sourceIndex = claimSources.indexOf(source) + 1;
      position = continuation ? { source, cursor: continuation } : sourceIndex < claimSources.length ? { source: claimSources[sourceIndex] } : null;
      // Empty work pages still carry a continuation. Do not drain an unbounded
      // gateway traversal inside one dashboard request.
      if (continuation) break;
    }
    return { claims, next: encodeClaimCursor(position), total: null, order: 'finder_then_asset_block' };
  }
  // Up to `pages` public pages of one agent collection.
  async collect(read, key, pages) {
    const rows = []; let cursor; const seen = new Set();
    for (let i = 0; i < pages; i++) {
      const page = await read(cursor);
      dashboardCheck(Array.isArray(page[key]), 'invalid_pattern_page', 502);
      rows.push(...page[key]); cursor = nextCursor(page);
      if (!cursor || seen.has(cursor)) return { rows, more: false };
      seen.add(cursor);
    }
    return { rows, more: true };
  }
  // "Your patterns": every pattern this agent discovered or holds unminted
  // claims in, with its token state and claim count. Public paged reads only;
  // the deployment state read never starts a deployment.
  patterns() {
    if (this.patternCache && Date.now() - this.patternCache.at < PATTERN_TTL) return this.patternCache.value;
    this.patternTask ??= this.loadPatterns().then(value => { this.patternCache = { at: Date.now(), value }; return value; }).finally(() => { this.patternTask = null; });
    return this.patternTask;
  }
  async loadPatterns() {
    const address = this.agent.address, found = new Map();
    const add = (asset, extra = {}) => {
      if (!assetId(asset)) return;
      const key = canonicalAsset(asset), old = found.get(key) ?? { asset: key, ids: new Set(), discovered: false };
      old.ids.add(asset); found.set(key, Object.assign(old, extra));
    };
    const discoveries = await this.collect(cursor => this.service.profile(address, { collection: 'discoveries', limit: 50, cursor }), 'discoveries', 4);
    for (const row of discoveries.rows) {
      const discoverer = wireIdentities(row).discoverer;
      if (!discoverer || discoverer === this.agent.owner) add(row.asset, { discovered: true, name: row.name ?? null, tier: row.tier ?? null,
        ...(row.amountMode ? { amountMode: row.amountMode } : {}) });
    }
    // Patterns with claims: the newest own finds, mint rights and held units.
    const pages = await Promise.all([
      this.service.profile(address, { collection: 'finds', limit: 50, minted: false, sort: 'block', order: 'desc' }).then(p => p.finds),
      this.service.mintRights(address, { limit: 50, minted: false }).then(p => p.mintRights),
      this.service.profile(address, { collection: 'balances', limit: 50 }).then(p => p.balances)].map(read => read.catch(() => [])));
    for (const rows of pages) for (const row of Array.isArray(rows) ? rows : []) if (!row.compound) add(row.asset);
    for (const row of Array.isArray(pages[2]) ? pages[2] : []) if (!row.compound && /^[1-9][0-9]*$/.test(String(row.amount ?? ''))) add(row.asset, { held: true });
    const list = [...found.values()].sort((a, b) => patternNumber(a.asset) < patternNumber(b.asset) ? -1 : patternNumber(a.asset) > patternNumber(b.asset) ? 1 : 0);
    const shown = list.slice(0, PATTERN_LIMIT), patterns = [];
    for (let i = 0; i < shown.length; i += 4) patterns.push(...await Promise.all(shown.slice(i, i + 4).map(p => this.patternRow(p))));
    return { patterns: patterns.filter(p => p.discovered || p.claims !== 0 || p.otherTickers), more: discoveries.more || list.length > PATTERN_LIMIT };
  }
  async patternRow(p) {
    let deployment = null;
    try { deployment = await this.service.deploymentState(p.asset); } catch { /* shown as unknown */ }
    // The gateway lists a pattern's rows under one id: legacy p0 or p2:NUMBER.
    const id = assetId(deployment?.asset) && canonicalAsset(deployment.asset) === p.asset ? deployment.asset
      : [...p.ids].find(id => id !== p.asset) ?? p.asset;
    const unique = rows => rows.filter(row => !row.compound && row.eligible !== false && canonicalAsset(row.asset) === p.asset).map(row => String(row.block));
    const [finds, rights, detail] = await Promise.all([
      this.collect(cursor => this.service.profile(this.agent.address, { collection: 'finds', asset: id, limit: 50, minted: false, cursor }), 'finds', COUNT_PAGES).catch(() => null),
      this.collect(cursor => this.service.mintRights(this.agent.address, { asset: id, limit: 50, minted: false, cursor }), 'mintRights', COUNT_PAGES).catch(() => null),
      p.name && p.tier !== null && p.tier !== undefined ? null : this.pattern(p.asset).catch(() => null)]);
    const token = tokenState(deployment);
    // Every ticker mints each block once. With its official blocks all minted, a pattern whose units the agent
    // still holds stays listed while it has another ticker, so its Tickers choice stays reachable.
    const claims = finds && rights ? new Set([...unique(finds.rows), ...unique(rights.rows)]).size : null;
    const otherTickers = p.held && !p.discovered && claims === 0 && token === 'deployed'
      ? await this.service.assetTickers(p.asset, { limit: 2 }).then(r => Array.isArray(r?.rows) && r.rows.length > 1, () => false) : false;
    return { asset: p.asset, id, name: p.name ?? deployment?.displayLabel ?? (detail && detail.name !== p.asset ? detail.name : 'Pattern #' + p.asset.slice(3)), tier: p.tier ?? detail?.tier ?? null, discovered: p.discovered,
      token, deploymentState: deployment?.state ?? null,
      // A wallet-sent inscription the gateway saw on Bitcoin, until its state moves on.
      inflight: token !== 'deployed' && /^[0-9a-f]{64}$/.test(deployment?.inflight?.revealTxid ?? '') ? deployment.inflight : null,
      ...((p.amountMode ?? deployment?.definition?.amountMode ?? detail?.amountMode) === 'field-value' ? { amountMode: 'field-value' } : {}),
      // The deployed ticker can differ from the name (a taken ticker gets a word added).
      ticker: token === 'deployed' ? deployment?.entry?.tick ?? null : null,
      // During the discoverer's week only the discoverer deploys; after it anyone may.
      deployer: token === 'deployed' ? null : deployment?.deployer ?? null, ownWeek: !!deployment?.deployer && deployment.deployer.discoverer === this.agent.address,
      // null: the count could not be read this time.
      claims, moreClaims: !!(finds?.more || rights?.more), ...(otherTickers ? { otherTickers } : {}),
      deploymentLink: token === 'deployed' ? null : this.service.deploymentLink(p.asset, this.agent.address, this.agent.paymentOrigin) };
  }
  async status(id, slot) {
    dashboardCheck(requestId(id), 'invalid_request');
    const result = await this.service.mintStatus(id);
    dashboardCheck((result.requestId ?? result.id) === id, 'mint_request_id_mismatch', 502);
    // A known journal intent or the gateway's owner-bound payment plan is
    // required; the local server is never an arbitrary gateway proxy.
    const saved = this.savedMints().find(row => this.idOf(row) === id);
    if (!saved) {
      const plan = await this.service.mintPaymentPlan(id);
      dashboardCheck(wireIdentities(plan).owner === this.agent.owner && (!slot || sameSlot(plan, slot)), 'not_your_request', 403);
    }
    const walletProgress = result.receiver ? !!this.walletGet(this.agent.bitcoinNetwork + '/' + result.receiver + '/' + id) : false;
    return { ...result, feeCredits: { href: '/api/credits?request=' + id }, localWalletProgress: walletProgress, paymentLink: this.service.paymentLink(id, this.agent.paymentOrigin) };
  }
  async credits(options = {}) { return listFeeCredits(this.agent, options); }
  async useCredit(value) {
    dashboardCheck(value && Object.keys(value).every(k => ['actionId', 'credit', 'request'].includes(k)) &&
      typeof value.actionId === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(value.actionId) && requestId(value.credit) && requestId(value.request), 'invalid_credit_action');
    await this.status(value.request);
    return applyMatchingCredit(this.agent, value);
  }
  async transferCredit(value) {
    dashboardCheck(value && Object.keys(value).every(k => ['actionId', 'credit', 'to'].includes(k)) &&
      typeof value.actionId === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(value.actionId) && requestId(value.credit) && typeof value.to === 'string', 'invalid_credit_action');
    return runTool(this.context, 'transfer_credit', value);
  }
  async plan(id) {
    await this.status(id);
    const plan = await this.service.mintPaymentPlan(id);
    dashboardCheck((plan.requestId ?? plan.id) === id && wireIdentities(plan).owner === this.agent.owner, 'not_your_request', 403);
    return plan;
  }
  // Bitmap link requests this agent signed, newest first, with their live state.
  async links({ offset = 0, limit = 10 } = {}) {
    dashboardCheck(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'invalid_page_limit');
    const saved = this.journal.db.prepare("SELECT id FROM actions WHERE scope=? AND id LIKE 'link/%' AND id NOT LIKE 'link/%/%' ORDER BY rowid DESC")
      .all(this.journal.scope).map(({ id }) => this.journal.get(id)).filter(row => /^[0-9a-f]{64}$/.test(row?.result?.request?.id ?? row?.result?.next?.[0]?.arguments?.id ?? ''));
    const links = [];
    for (const row of saved.slice(offset, offset + limit)) {
      const id = row.result.request?.id ?? row.result.next[0].arguments.id;
      let status; try { status = await this.service.linkStatus(id); } catch (error) { status = { state: 'unknown', error: dashboardError(error) }; }
      links.push({ requestId: id, block: status.block ?? row.body?.request?.block ?? row.body?.request?.height ?? null, state: status.state,
        ...(status.price === '0' ? { price: '0' } : {}), payable: status.price !== '0' && status.state === 'awaiting_payment', error: status.error ?? null,
        inflight: status.price === '0' ? null : sentOnBitcoin(status.inflight, ['payment']), paymentLink: '/link/' + id });
    }
    return { links, next: offset + limit < saved.length ? offset + limit : null };
  }
  async link(value) {
    dashboardCheck(value && Object.keys(value).every(k => ['height', 'payer'].includes(k)) && integer(value.height) && (value.payer === undefined || typeof value.payer === 'string' && value.payer.length <= 128), 'invalid_link');
    // The TAP Wallet holding the Bitmap pays; default to the bound payout wallet.
    const payer = value.payer ?? await this.payout();
    const result = await this.agent.linkBitmap({ actionId: 'dashboard-link-' + value.height + '-' + payer.slice(-8), height: Number.isSafeInteger(Number(value.height)) ? Number(value.height) : value.height, payer });
    dashboardCheck(typeof result?.paymentLink === 'string', result?.state ? 'link_' + result.state : 'link_unavailable', 409);
    return { paymentLink: result.paymentLink, state: result.state ?? null };
  }
  async linkBulk(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(value && Object.keys(value).every(k => ['blocks', 'payer'].includes(k)), 'invalid_blocks');
    linkBlocks(value.blocks, this.bulkLinks.jobs.settings.maxBlocks);
    const result = this.bulkLinks.create({ ...value, payer: value.payer ?? await this.payout() });
    if (result.existing) throw Object.assign(Error('link_job_running'), { code: 'link_job_running', status: 409, job: result.job });
    return { job: result.job };
  }
  async payment(value) {
    dashboardCheck(value && Object.keys(value).every(k => ['id', 'paymentId', 'inscription'].includes(k)) && requestId(value.id) &&
      ['paymentId', 'inscription'].filter(k => value[k] !== undefined).length === 1 &&
      /^[0-9a-f]{64}i(0|[1-9][0-9]{0,9})$/.test(value.paymentId ?? value.inscription), 'invalid_payment_report');
    await this.status(value.id);
    return this.service.reportMintPayment(value);
  }
  async requests({ offset = 0, limit = 25 } = {}) {
    dashboardCheck(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'invalid_page_limit');
    const saved = this.savedMints(), requests = [], counted = await this.countedHeight();
    for (const row of saved.slice(offset, offset + limit)) {
      const id = this.idOf(row); let status;
      try { status = await this.status(id); } catch (error) { status = { state: 'unknown', error: dashboardError(error) }; }
      if (this.retireDead(row, status, status.error, counted)) continue;
      if (status.state !== 'minted') requests.push({ asset: row.body.request.asset, name: (await this.unitLabel(row.body.request.asset)).name, block: row.body.request.block, requestId: id,
        ...(row.body.request.deployment ? { deployment: row.body.request.deployment } : {}), state: status.state, payable: status.payable === true, error: status.error ?? null, inflight: sentOnBitcoin(status.inflight, ['payment', 'mint']),
        paymentLink: this.service.paymentLink(id, this.agent.paymentOrigin) });
    }
    return { requests, next: offset + limit < saved.length ? offset + limit : null, batch: this.batch };
  }
  mint(slot) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(slot && Object.keys(slot).every(k => ['asset', 'block', 'deployment'].includes(k)) && assetId(slot.asset) && integer(slot.block) && (slot.deployment === undefined || typeof slot.deployment === 'string' && slot.deployment.length > 0), 'invalid_claim');
    const key = canonicalAsset(slot.asset) + '/' + slot.block + (slot.deployment ? '/' + slot.deployment : '');
    if (this.inflight.has(key)) return this.inflight.get(key);
    const task = Promise.resolve().then(() => this.mintNow(slot));
    this.inflight.set(key, task);
    task.finally(() => this.inflight.delete(key)).catch(() => {});
    return task;
  }
  savedArguments(row, slot) {
    const body = row.body, r = body.request;
    const assets = [...new Set([slot.asset, r.asset, canonicalAsset(r.asset)])];
    const blocks = [r.block, ...(Number.isSafeInteger(Number(r.block)) ? [Number(r.block)] : [])];
    for (const asset of assets) for (const block of blocks) {
      const intent = { asset, block, amount: r.amount, ...(r.deployment === undefined ? {} : { deployment: r.deployment }), receiver: body.receiver, payer: body.payer, kind: body.kind, compound: false };
      if (digest(stableJSON(intent)) === row.fingerprint) return { ...intent, actionId: row.id.slice(5) };
    }
    dashboardCheck(false, 'saved_mint_intent_unavailable', 409);
  }
  async mintNow(slot, retried = false) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    if (slot.deployment !== undefined) dashboardCheck(/^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(slot.deployment), 'invalid_deployment');
    const debug = process.env.DMW_DASHBOARD_DEBUG === '1', readsAt = Date.now();
    const c = await this.candidate(slot);
    dashboardCheck(!c.minted && !c.void, 'already_minted', 409);
    const payout = await this.payout(), old = this.savedSlot(slot);
    if (debug) process.stderr.write(`mint timing: dashboard candidate and payout reads ${Date.now() - readsAt}ms\n`);
    if (old || c.pending) {
      const id = old ? this.idOf(old) : c.pending.id;
      try {
        const status = await this.status(id, slot);
        dashboardCheck(status.state !== 'minted', 'already_minted', 409);
        if (old && !retried && this.retireDead(old, status)) return this.mintNow(slot, true);
        // An authorizing request still needs the original account signature.
        if (status.state !== 'authorizing') return { requestId: id, status, paymentLink: this.service.paymentLink(id, this.agent.paymentOrigin), replayed: true };
      } catch (error) { if (!(old && error.status === 404)) throw error; }
      dashboardCheck(old, 'block_pending', 409);
    }
    if (!old) {
      const reason = this.mintReason(c, await this.balance(c.find.asset));
      dashboardCheck(!reason, reason, reason === 'mint_finder' || reason === 'mint_bitmap' ? 403 : 409);
    }
    const body = old?.body;
    dashboardCheck(!body || body.receiver === payout && body.payer === payout && body.kind === 'tap', 'saved_payout_changed', 409);
    const args = old ? this.savedArguments(old, slot) : {
      actionId: 'dashboard-' + digest(this.agent.network + '/' + this.agent.owner + '/' + canonicalAsset(slot.asset) + '/' + slot.block + (slot.deployment ? '/' + slot.deployment : '')).slice(0, 48) +
        (this.expiredSlot(slot) ? '-' + this.expiredSlot(slot) : ''),
      asset: slot.asset, block: String(slot.block), ...(slot.deployment === undefined ? {} : { deployment: slot.deployment }), amount: String(c.find.count), receiver: payout, payer: payout, kind: 'tap', compound: false };
    let result;
    try { result = await runTool(this.context, 'mint_on_chain', args); }
    catch (error) {
      // A saved request that expired before the gateway took it is retired; sign a fresh one once.
      if (old && !retried && /financial_request_expired/.test(error.code ?? error.message)) return this.mintNow(slot, true);
      throw error;
    }
    const saved = this.savedSlot(slot), id = saved ? this.idOf(saved) : result.request?.id ?? result.request?.requestId;
    if (!requestId(id)) return { state: result.state, signed: result.signed === true, deploymentLink: result.deploymentLink ?? null };
    // A delayed status read must never erase a successfully saved signature.
    let status;
    try { status = await this.status(id); } catch (error) { status = { state: 'unknown', error: dashboardError(error) }; }
    return { requestId: id, status, paymentLink: this.service.paymentLink(id, this.agent.paymentOrigin) };
  }
  saveBulkPlanner() {
    this.journal.db.prepare('INSERT INTO dashboard_bulk_planner(scope,value) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value')
      .run(this.journal.scope, JSON.stringify(this.batch));
  }
  saveBulkOrder(row) {
    this.journal.db.prepare('INSERT INTO dashboard_bulk(scope,action,order_id,live,value) VALUES(?,?,?,?,?) ON CONFLICT(scope,action) DO UPDATE SET order_id=excluded.order_id,live=excluded.live,value=excluded.value')
      .run(this.journal.scope, row.actionId, row.orderId ?? null, row.terminal ? 0 : 1, JSON.stringify(row));
  }
  bulkOrder(id) {
    const row = this.journal.db.prepare('SELECT value FROM dashboard_bulk WHERE scope=? AND order_id=?').get(this.journal.scope, id);
    return row ? JSON.parse(row.value) : null;
  }
  bulkLive() {
    // One more than the open-order limit, so the planner sees when every slot is taken.
    return this.journal.db.prepare('SELECT value FROM dashboard_bulk WHERE scope=? AND live=1 ORDER BY rowid LIMIT ?')
      .all(this.journal.scope, (this.bulkLiveOrders ?? BULK_LIVE_ORDERS) + 1).map(row => JSON.parse(row.value));
  }
  // Blocks in this agent's open bulk orders; their single Mint stays hidden until the order ends.
  bulkHeldBlocks() {
    const held = new Map();
    for (const { value } of this.journal.db.prepare('SELECT value FROM dashboard_bulk WHERE scope=? AND live=1').all(this.journal.scope)) {
      const row = JSON.parse(value), terms = row.quote?.terms;
      for (const member of terms?.members ?? []) held.set(canonicalAsset(terms.asset) + '/' + member.block, row.orderId ?? null);
    }
    return held;
  }
  async bulkTerms(id) {
    dashboardCheck(requestId(id), 'invalid_bulk_order');
    const { validateBulkTerms, validateBulkFees, bulkOrderId } = await import('../../rules/src/bulk-mint.js');
    const response = await this.service.bulkMintTerms(id), terms = validateBulkTerms(response.terms);
    validateBulkFees(terms, response.feeManifest);
    dashboardCheck(response.orderId === id && terms.owner === this.agent.owner && terms.network === this.agent.network &&
      terms.bitcoinNetwork === this.agent.bitcoinNetwork && bulkOrderId(terms.network, terms.owner, terms.nonce) === id, 'not_your_request', 403);
    const saved = this.bulkOrder(id);
    dashboardCheck(!saved?.quote || hashObject(terms) === saved.quote.quoteId, 'bulk_terms_changed', 409);
    return response;
  }
  async bulkStatus(id) {
    dashboardCheck(requestId(id), 'invalid_bulk_order');
    const [status, response] = await Promise.all([this.service.bulkMintStatus(id), this.bulkTerms(id)]);
    dashboardCheck(status.orderId === id && status.termsHash === hashObject(response.terms), 'bulk_terms_changed', 409);
    return status;
  }
  async bulkPage(id, kind, page) {
    const { BULK_LIMITS } = await import('../../rules/src/bulk-mint.js');
    dashboardCheck(Number.isSafeInteger(page.offset) && page.offset >= 0 && page.offset < BULK_LIMITS.members &&
      Number.isSafeInteger(page.limit) && page.limit >= 1 && page.limit <= (kind === 'permit' ? BULK_LIMITS.permitPage : BULK_LIMITS.members), 'invalid_bulk_page');
    await this.bulkTerms(id);
    return kind === 'members' ? this.service.bulkMintMembers(id, page) : this.service.bulkMintPermit(id, page);
  }
  async bulkQuote(value) {
    const payout = await this.payout();
    dashboardCheck(value && Object.keys(value).every(k => ['actionId', 'asset', 'deployment', 'blocks', 'payer', 'receiver'].includes(k)), 'invalid_bulk_quote');
    try { return await runTool(this.context, 'quote_bulk_mint', { ...value, payer: value.payer ?? payout, receiver: value.receiver ?? payout }); }
    catch (error) { if (!error.status) error.status = 400; throw error; }
  }
  async bulkRequest(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    // The kit validates the ceilings and signs only the saved quote.
    dashboardCheck(typeof value?.actionId === 'string', 'invalid_bulk_request');
    const saved = this.journal.db.prepare('SELECT value FROM dashboard_bulk WHERE scope=? AND action=?').get(this.journal.scope, value.actionId);
    let result;
    try { result = await runTool(this.context, 'mint_bulk_on_chain', value); }
    catch (error) { if (!error.status) error.status = 400; throw error; }
    if (saved && result.state !== 'dry-run') {
      const row = JSON.parse(saved.value); this.completeBulkOrder(row, result);
      if (this.batch?.state === 'needs_attention') { this.batch.state = 'running'; this.saveBulkPlanner(); this.resumeBulkPlanner(); }
    }
    return result;
  }
  async bulkPayment(value) {
    dashboardCheck(value && Object.keys(value).sort().join(',') === 'commitTxid,orderId,paymentId,revealTxid' && requestId(value.orderId) &&
      (value.paymentId === null || /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(value.paymentId)) &&
      ['commitTxid', 'revealTxid'].every(k => value[k] === null || requestId(value[k])) &&
      [value.paymentId, value.commitTxid, value.revealTxid].some(Boolean), 'invalid_bulk_payment');
    await this.bulkTerms(value.orderId);
    return this.service.reportBulkPayment(value);
  }
  async refreshBulkOrder(row) {
    if (!row.orderId || !row.prepared) return row;
    try {
      const status = await this.bulkStatus(row.orderId); row.status = status; row.error = null;
      // Issued unresolved orders retain a slot. No local inference from time,
      // a Bitcoin broadcast, or an absent index row can free it.
      row.terminal = ['minted', 'expired', 'credited'].includes(status.state) && status.progress?.unresolved === 0;
      this.saveBulkOrder(row);
    } catch (error) { row.error = dashboardError(error); this.saveBulkOrder(row); }
    return row;
  }
  async bulkOrders({ offset = 0, limit = 25 } = {}) {
    dashboardCheck(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'invalid_page_limit');
    // Keep unresolved orders visible even after newer completed orders fill a page.
    const rows = this.journal.db.prepare('SELECT value FROM dashboard_bulk WHERE scope=? ORDER BY live DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(this.journal.scope, limit + 1, offset).map(row => JSON.parse(row.value));
    const orders = [];
    for (let i = 0; i < Math.min(limit, rows.length); i += 4) orders.push(...await Promise.all(rows.slice(i, Math.min(i + 4, limit)).map(row => this.refreshBulkOrder(row))));
    this.resumeBulkPlanner();
    return { orders, next: rows.length > limit ? offset + limit : null, planner: this.batch };
  }
  // filter: one pattern (as the claims list takes it), one ticker deployment of
  // it, and at most `limit` blocks; saved with the planner, so a restart keeps it.
  mintAll({ asset, deployment, limit, ...rest } = {}) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(!Object.keys(rest).length && (asset === undefined || assetId(asset)) &&
      (deployment === undefined || asset !== undefined && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(deployment)) &&
      (limit === undefined || Number.isSafeInteger(limit) && limit >= 1), 'invalid_mint_all');
    const filter = { ...(asset ? { asset } : {}), ...(deployment ? { deployment } : {}), ...(limit ? { limit } : {}) };
    const same = this.batch && stableJSON(this.batch.filter ?? {}) === stableJSON(filter);
    // One Mint all at a time: the running one is shown again; another filter waits until it ends.
    if (this.batch && (this.batchTask || ['running', 'waiting_slots'].includes(this.batch.state))) {
      dashboardCheck(same, 'mint_all_running', 409);
      this.resumeBulkPlanner(); return this.batch;
    }
    if (!this.batch || this.batch.state === 'complete' || !same) {
      // A new filter after a failure starts a new planner; saved unprepared orders are still retried first.
      for (const row of this.bulkLive()) if (!row.prepared && row.error) { row.error = null; this.saveBulkOrder(row); }
      this.batch = { id: randomUUID(), state: 'running', completed: 0, failed: 0, deploymentNeeded: [], errors: [], cursor: null,
        sourceEnd: false, pending: [], restarts: 0, cursors: [], filter, taken: 0 };
      this.saveBulkPlanner();
    } else if (['failed', 'needs_attention'].includes(this.batch.state)) {
      // An explicit repeat resumes the same cursor, nonce and any signed packet.
      // A transient quote/admission error never strands the planner or starts a new order.
      for (const row of this.bulkLive()) if (!row.prepared) { row.error = null; this.saveBulkOrder(row); }
      this.batch.state = 'running'; delete this.batch.error; this.saveBulkPlanner();
    }
    this.resumeBulkPlanner(); return this.batch;
  }
  resumeBulkPlanner() {
    if (this.closed || this.batchTask || !this.batch || !['running', 'waiting_slots'].includes(this.batch.state)) return;
    this.batchTask = this.runBulkPlanner().catch(error => {
      this.batch.state = 'failed'; this.batch.error = dashboardError(error); this.saveBulkPlanner();
    }).finally(() => {
      this.batchTask = null;
      if (!this.closed && ['running', 'waiting_slots'].includes(this.batch.state)) { clearTimeout(this.bulkTimer); this.bulkTimer = setTimeout(() => this.resumeBulkPlanner(), 5000).unref(); }
    });
  }
  async runBulkPlanner() {
    const { BULK_LIMITS } = await import('../../rules/src/bulk-mint.js');
    const planner = this.batch; planner.state = 'running'; this.saveBulkPlanner();
    await Promise.all(this.bulkLive().map(row => this.refreshBulkOrder(row)));
    while (!this.closed) {
      const live = this.bulkLive();
      // Finish a saved preparation/submission before considering another nonce.
      const unfinished = live.find(row => !row.prepared && !row.error);
      if (unfinished) { await this.prepareBulkOrder(unfinished); continue; }
      if (live.some(row => row.error && !row.prepared)) { planner.state = 'needs_attention'; break; }
      if (live.length >= (this.bulkLiveOrders ?? BULK_LIVE_ORDERS)) { planner.state = 'waiting_slots'; break; }
      // Read a bounded number of authenticated claim pages per turn. Cursor and
      // deduplication survive stale snapshots and process restarts.
      let pages = 0;
      const filter = planner.filter ?? {};
      while (!planner.sourceEnd && planner.pending.length < BULK_LIMITS.members && pages++ < 3) {
        let page;
        try { page = await this.claims({ cursor: planner.cursor ?? undefined, limit: 50, ...(filter.asset ? { asset: filter.asset } : {}), ...(filter.deployment ? { deployment: filter.deployment } : {}) }); }
        catch (error) {
          if (['page_cursor_stale', 'claimed_cursor_stale'].includes(error.code ?? error.message) && planner.restarts++ < 3) {
            planner.cursor = null; planner.cursors = []; this.saveBulkPlanner(); continue;
          }
          throw error;
        }
        const payout = page.claims.some(row => row.canMint) ? await this.payout() : null;
        const additions = [], seen = [];
        let full = false;
        for (const row of page.claims) {
          // Stop after the chosen number of blocks; later rows stay unseen.
          if (filter.limit && (planner.taken ?? 0) + additions.length >= filter.limit) { full = true; break; }
          const slot = stableJSON([row.asset, row.deployment ?? null, row.block]);
          if (this.journal.db.prepare('SELECT 1 FROM dashboard_bulk_seen WHERE scope=? AND planner=? AND slot=?').get(this.journal.scope, planner.id, slot)) continue;
          seen.push(slot);
          if (filter.asset && canonicalAsset(row.asset) !== canonicalAsset(filter.asset) || filter.deployment && row.deployment && row.deployment !== filter.deployment) continue;
          if (!row.canMint) {
            if (row.deploymentLink && planner.deploymentNeeded.length < 20) planner.deploymentNeeded.push(row);
            continue;
          }
          const candidate = await this.candidate(filter.deployment ? { ...row, deployment: filter.deployment } : row);
          let deployment = filter.deployment ?? row.deployment ?? candidate.deployment;
          if (!deployment) {
            const state = await this.service.deploymentState(row.asset);
            deployment = state.entry?.id ?? state.deploymentId ?? state.deployment?.inscription ?? state.deployment?.id ?? state.inscription;
          }
          if (!/^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(deployment ?? '')) {
            if (planner.deploymentNeeded.length < 20) planner.deploymentNeeded.push({ ...row, state: 'deployment_needed', deploymentLink: this.service.deploymentLink(row.asset, this.agent.address, this.agent.paymentOrigin) });
            continue;
          }
          additions.push({ asset: candidate.find.asset, deployment, block: String(row.block), payer: payout, receiver: payout });
        }
        dashboardCheck(!page.next || !planner.cursors.includes(page.next), 'repeated_cursor', 502);
        planner.cursor = page.next ?? null; planner.sourceEnd = !page.next || full ||
          !!filter.limit && (planner.taken ?? 0) + additions.length >= filter.limit;
        if (page.next) planner.cursors.push(page.next);
        planner.pending.push(...additions); planner.taken = (planner.taken ?? 0) + additions.length;
        this.journal.db.exec('BEGIN IMMEDIATE');
        try {
          for (const slot of seen) this.journal.db.prepare('INSERT OR IGNORE INTO dashboard_bulk_seen(scope,planner,slot) VALUES(?,?,?)').run(this.journal.scope, planner.id, slot);
          this.saveBulkPlanner(); this.journal.db.exec('COMMIT');
        } catch (error) { this.journal.db.exec('ROLLBACK'); throw error; }
      }
      if (!planner.pending.length) {
        if (planner.sourceEnd) { planner.state = 'complete'; break; }
        // Empty pages with a cursor are work pages, not the end of the list.
        planner.state = 'waiting_slots'; break;
      }
      const first = planner.pending[0], group = row => stableJSON([row.asset, row.deployment, row.payer, row.receiver]);
      const selected = planner.pending.filter(row => group(row) === group(first)).sort((a, b) => BigInt(a.block) < BigInt(b.block) ? -1 : 1).slice(0, BULK_LIMITS.members);
      const chosen = new Set(selected);
      const row = { actionId: 'bulk-' + randomUUID(), planner: planner.id, input: { asset: first.asset, deployment: first.deployment, payer: first.payer, receiver: first.receiver, blocks: selected.map(row => row.block) }, terminal: false };
      planner.pending = planner.pending.filter(row => !chosen.has(row));
      // Save the selected set and its action ID atomically before quoting.
      this.journal.db.exec('BEGIN IMMEDIATE');
      try { this.saveBulkOrder(row); this.saveBulkPlanner(); this.journal.db.exec('COMMIT'); }
      catch (error) { this.journal.db.exec('ROLLBACK'); throw error; }
      await this.prepareBulkOrder(row);
    }
    this.saveBulkPlanner();
  }
  completeBulkOrder(row, status) {
    // Concurrent exact HTTP retries may both have loaded the pre-submit row.
    // Use the latest durable row before advancing the cursor/counters once.
    const persisted = this.journal.db.prepare('SELECT value FROM dashboard_bulk WHERE scope=? AND action=?').get(this.journal.scope, row.actionId);
    if (persisted && JSON.parse(persisted.value).prepared) row = JSON.parse(persisted.value);
    if (row.prepared) { row.status = status; row.error = null; this.saveBulkOrder(row); return; }
    row.status = status; row.error = null; row.prepared = true;
    if (this.batch?.id === row.planner) {
      this.batch.completed += row.quote.terms.members.length;
      const { blocks, ...input } = row.input;
      for (const member of row.quote.deferred) this.batch.pending.push({ ...input, block: member.block });
    }
    this.journal.db.exec('BEGIN IMMEDIATE');
    try { this.saveBulkOrder(row); if (this.batch) this.saveBulkPlanner(); this.journal.db.exec('COMMIT'); }
    catch (error) { this.journal.db.exec('ROLLBACK'); throw error; }
  }
  async prepareBulkOrder(row) {
    try {
      row.quote ??= await quoteBulkMint(this.agent, { actionId: row.actionId, ...row.input });
      row.orderId = row.quote.orderId; this.saveBulkOrder(row);
      if (!row.quote.terms) { row.terminal = true; this.saveBulkOrder(row); return; }
      // Admission signs a saved set. Each order still requires its own wallet
      // approval; preparing later orders grants no wallet spending authority.
      const status = await makeBulkMint(this.agent, { actionId: row.actionId, quoteId: row.quote.quoteId,
        maxPayableFeeAtoms: row.quote.terms.payableFeeAtoms, maxSetAsideSats: row.quote.terms.mintFunding.satoshis });
      this.completeBulkOrder(row, status);
    } catch (error) {
      row.error = dashboardError(error); this.saveBulkOrder(row);
      this.batch.failed++; this.batch.state = 'needs_attention';
      if (this.batch.errors.length < 20) this.batch.errors.push({ actionId: row.actionId, ...row.input, error: row.error });
      this.saveBulkPlanner();
    }
  }
  // Human label of a ledger key: pattern name, compound recipe or imported
  // pattern name. The key itself is only shown as a muted detail.
  async unitLabel(asset) {
    if (this.labels.has(asset)) return this.labels.get(asset);
    let label, final = true;
    if (this.merged().has(asset)) label = { ...await this.unitLabel(this.merged().get(asset)), mergedInto: this.merged().get(asset) };
    else if (asset.startsWith('c2:')) {
      let row = null;
      try { row = (await this.service.compounds({ asset, limit: 1 })).compounds?.find(c => c.id === asset || c.asset === asset) ?? null; } catch { final = false; }
      const all = compoundInputs(row), inputs = all.filter(i => i[0] !== asset).slice(0, 4);
      const names = [];
      for (const [input] of inputs) names.push((await this.unitLabel(input)).name);
      label = { kind: 'compound', tier: tierValue(row?.tierProgress?.value ?? row?.tier),
        name: names.length ? `${names.map(niceName).join(' + ')}${all.length > inputs.length ? ' + …' : ''} ${row.recipe === 'resonance' ? 'resonance' : 'fusion'}` : 'Compound #' + asset.slice(3, 11) };
    } else {
      let p = null;
      try { p = await this.pattern(asset); } catch { final = false; }
      const known = p && p.name !== asset, pattern = asset.startsWith('p2:');
      label = { kind: pattern ? 'pattern' : 'legacy', tier: p?.tier ?? null,
        name: known ? p.name : pattern ? 'Pattern #' + asset.slice(3) : 'Imported units ' + asset };
    }
    if (final) this.labels.set(asset, label);
    return label;
  }
  // Units on their way out in sends not yet confirmed.
  pendingUnits() {
    const out = new Map();
    for (const send of this.savedSends(SEND_RECENT * 3)) for (const g of send.groups) {
      if (['confirmed', 'failed', 'stale', 'replaced'].includes(this.groupState(g).state)) continue;
      for (const [asset, amount] of g.assets) out.set(asset, (out.get(asset) ?? 0n) + BigInt(amount));
    }
    return out;
  }
  // Spendable units: the agent's public available balances (held units are
  // excluded by the gateway) minus units in unconfirmed sends. Bounded pages.
  async units() {
    const { rows, more } = await this.collect(cursor => this.service.profile(this.agent.address, { collection: 'balances', limit: 50, cursor }), 'balances', 4);
    const pending = this.pendingUnits(), held = rows.filter(r => typeof r.asset === 'string' && isAsset(r.asset) && integer(r.amount) && r.amount !== '0');
    const units = [];
    for (let i = 0; i < held.length; i += 4) units.push(...await Promise.all(held.slice(i, i + 4).map(async r => {
      const out = pending.get(r.asset) ?? 0n, amount = BigInt(r.amount);
      return { asset: r.asset, ...await this.unitLabel(r.asset), amount: String(r.amount), pending: String(out),
        available: String(amount > out ? amount - out : 0n), current: r.current !== false && !r.blocked };
    })));
    return { units, more, address: this.agent.address };
  }
  // Check every row before anything is signed: address checksum, a unit the
  // agent holds (by name or key), positive amount, totals within available.
  async review(value) {
    dashboardCheck(value && Object.keys(value).length === 1 && (Array.isArray(value.rows) || typeof value.text === 'string'), 'invalid_send');
    const input = value.text !== undefined ? parseSendList(value.text) : value.rows;
    dashboardCheck(input.length > 0 && input.length <= SEND_ROWS, input.length ? 'send_too_many_rows' : 'send_empty');
    const { units } = await this.units(), totals = new Map();
    const find = unit => {
      const text = String(unit ?? '').trim(), lower = text.toLowerCase();
      // A key as shown under a unit's name: "#7" is pattern p2:7, "#e9f0843e" a compound key prefix.
      const exact = units.filter(u => u.asset === text || /^#(0|[1-9][0-9]*)$/.test(text) && u.asset === 'p2:' + text.slice(1));
      if (exact.length) return exact;
      return units.filter(u => u.name.toLowerCase() === lower || u.kind === 'compound' && lower.length >= 8 && u.asset.slice(3).startsWith(lower.replace(/^(compound\s*)?#?/, '')));
    };
    const rows = input.map((row, index) => {
      const out = { line: row?.line ?? index + 1, to: String(row?.to ?? '').trim(), unit: String(row?.unit ?? '').trim(), amount: String(row?.amount ?? '').trim(), error: null };
      let key = null;
      try { key = decodeTracAddress(out.to); } catch { out.error = 'send_address'; }
      if (key && key === this.agent.owner) out.error = 'send_self';
      const matches = find(out.unit);
      if (matches.length === 1) Object.assign(out, { asset: matches[0].asset, name: matches[0].name, kind: matches[0].kind });
      else out.error ??= matches.length ? 'send_unit_ambiguous' : 'send_unit_unknown';
      if (!amountText(out.amount)) out.error ??= 'send_amount';
      if (!out.error) totals.set(out.asset, (totals.get(out.asset) ?? 0n) + BigInt(out.amount));
      return out;
    });
    const over = [...totals].filter(([asset, total]) => total > BigInt(units.find(u => u.asset === asset).available)).map(([asset]) => asset);
    for (const row of rows) if (!row.error && over.includes(row.asset)) row.error = 'send_over_available';
    const ok = rows.every(r => !r.error), groups = ok ? groupSends(rows) : [];
    dashboardCheck(groups.length <= SEND_GROUPS, 'send_too_many_recipients');
    return { ok, rows, groups: await Promise.all(groups.map(async g => ({ ...g, labels: await Promise.all(g.assets.map(async ([asset]) => (await this.unitLabel(asset)).name)) }))),
      totals: await Promise.all([...totals].map(async ([asset, total]) => ({ asset, name: (await this.unitLabel(asset)).name, amount: String(total),
        available: units.find(u => u.asset === asset).available }))) };
  }
  savedSends(limit = SEND_RECENT) {
    return this.journal.db.prepare('SELECT value FROM dashboard_sends WHERE scope=? ORDER BY rowid DESC LIMIT ?').all(this.journal.scope, limit).map(r => JSON.parse(r.value));
  }
  saveSend(send) {
    this.journal.db.prepare('INSERT INTO dashboard_sends(scope,id,value) VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET value=excluded.value').run(this.journal.scope, send.id, JSON.stringify(send));
  }
  loadSend(id) {
    dashboardCheck(typeof id === 'string' && /^[0-9a-f]{12}$/.test(id), 'invalid_send');
    const row = this.journal.db.prepare('SELECT value FROM dashboard_sends WHERE scope=? AND id=?').get(this.journal.scope, id);
    dashboardCheck(row, 'send_not_found', 404); return JSON.parse(row.value);
  }
  // A group's state from the transfer journal; the dashboard row only adds
  // the last plain error and a public confirmation.
  groupState(g) {
    const intent = this.journal.get(`tx/${g.actionId}/v2-intent`), move = this.journal.get(`tx/${g.actionId}/v2-move`);
    const running = this.sending.has(g.actionId), batch = move?.result?.batch ?? null;
    if (g.replacedBy) return { state: 'replaced', batch };
    if (g.confirmed) return { state: 'confirmed', batch: g.confirmed.batch ?? batch };
    if (move && ['received', 'accepted'].includes(move.state)) return { state: 'received', batch };
    if (move?.state === 'rejected') return { state: 'failed', batch, error: 'send_rejected' };
    if (running) return { state: 'sending', batch };
    if (move && ['sending', 'unknown'].includes(move.state)) return { state: 'uncertain', batch, error: g.error ?? null };
    if (['transfer_intent_stale', 'transfer_intent_expired'].includes(g.error) && (!move || ['prepared', 'refused'].includes(move.state))) return { state: 'stale', batch, error: g.error };
    if (g.error && SEND_LATER.includes(g.error)) return { state: 'queued', batch, error: g.error, signed: !!intent };
    if (g.error) return { state: 'failed', batch, error: g.error, signed: !!intent };
    return { state: g.tried ? 'uncertain' : 'waiting', batch, signed: !!intent };
  }
  // Public confirmation: the accepted transfer's event in this agent's
  // history (event id from the receipt's move and each action nonce).
  async confirmations(groups) {
    const wanted = new Map();
    for (const g of groups) {
      const move = this.journal.get(`tx/${g.actionId}/v2-move`), intent = this.journal.get(`tx/${g.actionId}/v2-intent`);
      const receipt = move?.result, nonce = intent?.body?.actions?.[0]?.nonce;
      if (typeof receipt?.move === 'string' && typeof nonce === 'string') wanted.set(digest('v2-event/transfer/' + receipt.move + '/' + nonce), g);
    }
    if (!wanted.size) return;
    let events = this.confirmCache && Date.now() - this.confirmCache.at < CONFIRM_TTL ? this.confirmCache.rows : null;
    if (!events) {
      events = (await this.collect(cursor => this.service.profile(this.agent.address, { collection: 'history', type: 'transfer', limit: 50, cursor }), 'history', CONFIRM_PAGES)).rows;
      this.confirmCache = { at: Date.now(), rows: events };
    }
    for (const event of events) {
      const g = wanted.get(event?.id);
      if (g) g.confirmed = { batch: event.provenance?.batch ?? null, sequence: event.sequence ?? null };
    }
  }
  async sendView(send) {
    const open = send.groups.filter(g => !g.confirmed && !g.replacedBy && this.journal.get(`tx/${g.actionId}/v2-move`)?.result?.move);
    if (open.length) {
      try { await this.confirmations(open); if (open.some(g => g.confirmed)) this.saveSend(send); } catch { /* shown as waiting */ }
    }
    const groups = await Promise.all(send.groups.map(async g => ({ actionId: g.actionId, to: g.to, replacedBy: g.replacedBy ?? null,
      assets: await Promise.all(g.assets.map(async ([asset, amount]) => ({ asset, amount, name: (await this.unitLabel(asset)).name }))), ...this.groupState(g) })));
    return { id: send.id, createdAt: send.createdAt, running: this.sendRunning === send.id, waiting: this.sendRunning === send.id ? this.sendWaiting ?? null : null, groups };
  }
  async sends() {
    const sends = [];
    for (const send of this.savedSends()) sends.push(await this.sendView(send));
    return { sends };
  }
  // Save every transfer action with its stable ID before anything is
  // submitted, then send them one by one through the kit's transfer action.
  async send(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(value && Object.keys(value).length === 1 && Array.isArray(value.rows), 'invalid_send');
    const review = await this.review({ rows: value.rows });
    dashboardCheck(review.ok, review.rows.find(r => r.error)?.error ?? 'invalid_send');
    const id = randomBytes(6).toString('hex');
    const send = { id, createdAt: Date.now(), groups: review.groups.map((g, i) => ({ actionId: `dash-send-${id}-${i + 1}`, to: g.to, assets: g.assets })) };
    this.saveSend(send);
    this.runSend(id);
    return this.sendView(send);
  }
  // Retry only the unsent or uncertain actions, each with its saved ID.
  async retrySend(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(value && Object.keys(value).length === 1, 'invalid_send');
    const send = this.loadSend(value.id);
    dashboardCheck(send.groups.some(g => ['failed', 'uncertain', 'queued', 'waiting'].includes(this.groupState(g).state)), 'send_nothing_to_retry', 409);
    this.runSend(send.id);
    return this.sendView(send);
  }
  // A never-submitted action whose signature went stale (an earlier send
  // changed the account first) is signed again under a new action ID, only
  // when the player asks; the old authorization can no longer execute.
  async resignSend(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(value && Object.keys(value).length === 2 && typeof value.actionId === 'string', 'invalid_send');
    const send = this.loadSend(value.id), g = send.groups.find(g => g.actionId === value.actionId);
    dashboardCheck(g && this.groupState(g).state === 'stale' && !this.sending.has(g.actionId), 'send_not_stale', 409);
    const n = send.groups.length + 1, actionId = `dash-send-${send.id}-${n}`;
    g.replacedBy = actionId; send.groups.push({ actionId, to: g.to, assets: g.assets, replaces: g.actionId });
    this.saveSend(send); this.runSend(send.id);
    return this.sendView(send);
  }
  runSend(id) {
    const task = this.sendTail.then(() => this.sendNow(id));
    this.sendTail = task.catch(() => {});
    return task;
  }
  async sendNow(id) {
    this.sendRunning = id;
    try {
      for (let pass = 0; pass < 6 && !this.closed; pass++) {
        let later = null;
        for (const g of this.loadSend(id).groups) {
          if (this.closed) return;
          if (!['failed', 'uncertain', 'queued', 'waiting'].includes(this.groupState(g).state) || later) continue;
          this.sending.add(g.actionId);
          let error = null;
          try { await runTool(this.context, 'transfer', { actionId: g.actionId, to: g.to, assets: g.assets }); }
          catch (e) {
            // The kit keeps an unanswered packet that is too old to resend.
            error = /^Saved packet outcome is unknown/.test(e?.message) ? 'send_outcome_unknown' : dashboardError(e);
            if (e.retryAfterMs !== undefined || e.status === 429) later = { error, retryAfterMs: e.retryAfterMs }; }
          finally { this.sending.delete(g.actionId); }
          const send = this.loadSend(id), saved = send.groups.find(r => r.actionId === g.actionId);
          saved.tried = true; if (error) saved.error = error; else delete saved.error;
          this.saveSend(send);
        }
        if (!later) return;
        // The next batch is full or the gateway paces this sender: the rest
        // waits for the next Bitcoin block instead of failing.
        const wait = Math.min(Math.max(later.retryAfterMs ?? 60000, 2000), 15 * 60000);
        this.sendWaiting = { reason: later.error, until: Date.now() + wait };
        await new Promise(resolve => { const timer = setTimeout(resolve, wait); this.wakeSend = () => { clearTimeout(timer); resolve(); }; });
        this.sendWaiting = null; this.wakeSend = null;
      }
    } finally { this.sendRunning = null; this.sendWaiting = null; }
  }
  // TNK balance, the current network fee per send and the most that can be
  // sent (balance − fee). A missing account is "no TNK yet", not an error.
  async tnk() {
    if (!this.tnkCache || Date.now() - this.tnkCache.at >= TNK_TTL) {
      let balance = null, error = null;
      try { balance = await this.agent.tnkBalance(); } catch (e) { error = dashboardError(e); }
      this.tnkCache = { at: Date.now(), balance, error };
    }
    const { balance: b, error } = this.tnkCache;
    if (!b) return { address: this.agent.address, ready: false, error };
    const out = await this.tnkOut(), max = BigInt(b.balanceAtoms) - BigInt(b.feeAtoms) - out;
    return { address: this.agent.address, ready: true, accountExists: b.accountExists, balanceTnk: b.balanceTnk, feeTnk: b.feeTnk,
      outTnk: formatTnk(out), maxTnk: b.accountExists && max > 0n ? formatTnk(max) : '0' };
  }
  // TNK on its way out (amount + fee) in this dashboard's unconfirmed sends:
  // the network balance drops only once they confirm.
  async tnkOut() {
    let out = 0n;
    for (const send of this.savedTnk()) {
      if (send.totalAtoms && ['waiting', 'sending', 'sent', 'pending', 'uncertain'].includes((await this.tnkState(send)).state)) out += BigInt(send.totalAtoms);
    }
    return out;
  }
  // Unsigned check of one TNK send: address, amount, balance and fee.
  async tnkReview(value) {
    dashboardCheck(value && Object.keys(value).length === 2 && typeof value.to === 'string' && typeof value.amount === 'string', 'invalid_tnk_send');
    const to = value.to.trim(), amount = value.amount.trim();
    dashboardCheck(amount !== 'max', 'tnk_invalid_amount');
    let quote;
    try { quote = await this.agent.prepareTnkTransfer({ to, amount }); } catch (error) { throw tnkFailure(error); }
    const left = BigInt(quote.remainingAtoms) - await this.tnkOut();
    if (left < 0n) throw tnkFailure({ code: 'tnk_insufficient' });
    return { to, amount: quote.amountTnk, feeTnk: quote.feeTnk, totalTnk: quote.totalTnk, totalAtoms: quote.totalAtoms, balanceTnk: quote.balanceTnk, remainingTnk: formatTnk(left) };
  }
  savedTnk() {
    return this.journal.db.prepare('SELECT value FROM dashboard_tnk WHERE scope=? ORDER BY rowid DESC LIMIT ?').all(this.journal.scope, TNK_RECENT).map(r => JSON.parse(r.value));
  }
  saveTnk(send) {
    this.journal.db.prepare('INSERT INTO dashboard_tnk(scope,id,value) VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET value=excluded.value').run(this.journal.scope, send.id, JSON.stringify(send));
  }
  loadTnk(id) {
    dashboardCheck(typeof id === 'string' && /^[0-9a-f]{12}$/.test(id), 'invalid_tnk_send');
    const row = this.journal.db.prepare('SELECT value FROM dashboard_tnk WHERE scope=? AND id=?').get(this.journal.scope, id);
    dashboardCheck(row, 'tnk_send_not_found', 404); return JSON.parse(row.value);
  }
  // The network's answer for a sent TNK transfer, cached a few seconds.
  async tnkNetwork(actionId) {
    const cached = this.tnkStatus.get(actionId);
    if (cached && Date.now() - cached.at < TNK_TTL) return cached.value;
    let value;
    try { value = await this.agent.tnkTransferStatus(actionId); } catch { value = { state: 'unknown', code: 'tnk_unknown_status' }; }
    this.tnkStatus.set(actionId, { at: Date.now(), value });
    return value;
  }
  // A send's state from the kit's TNK journal row; the dashboard row adds
  // only the last plain error. retry: Retry may resend under the same ID.
  async tnkState(send) {
    const row = this.journal.get('tnk/' + send.actionId), packet = row?.body?.packet, tx = packet?.tx ?? null;
    if (this.tnkSending.has(send.actionId)) return { state: 'sending', tx, retry: false };
    if (row?.state === 'accepted') return { state: 'confirmed', tx, retry: false };
    if (!row) return send.error ? { state: 'failed', tx, error: send.error, retry: true } : { state: 'waiting', tx, retry: true };
    // A signing claim without a saved packet: never signed a second time.
    if (!packet) return { state: 'uncertain', tx, error: 'tnk_interrupted', retry: false };
    if (packet.blockedCode) return { state: 'failed', tx, error: packet.blockedCode, retry: false, signed: true };
    if (row.state === 'prepared') return { state: 'failed', tx, error: send.error ?? 'tnk_validators', retry: true, signed: true };
    const status = await this.tnkNetwork(send.actionId);
    if (status.state === 'confirmed') return { state: 'confirmed', tx, retry: false };
    if (status.state === 'pending') return { state: 'pending', tx, retry: false };
    if (row.state === 'submitted') return { state: 'sent', tx, retry: Date.now() - (send.sentAt ?? send.createdAt) > TNK_RESEND_AFTER };
    return { state: 'uncertain', tx, error: 'tnk_unknown_status', retry: true };
  }
  async tnkView(send) {
    return { id: send.id, actionId: send.actionId, createdAt: send.createdAt, to: send.to, amount: send.amount, feeTnk: send.feeTnk, ...await this.tnkState(send) };
  }
  async tnkSends() {
    const sends = [];
    for (const send of this.savedTnk()) sends.push(await this.tnkView(send));
    return { sends };
  }
  // Save the TNK send with its action ID first, then sign and send it
  // through the kit's native TNK transfer.
  async tnkSend(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    const review = await this.tnkReview(value), id = randomBytes(6).toString('hex');
    const send = { id, actionId: `dash-tnk-${id}`, to: review.to, amount: review.amount, feeTnk: review.feeTnk, totalAtoms: review.totalAtoms, createdAt: Date.now() };
    this.saveTnk(send);
    this.runTnk(id);
    return this.tnkView(send);
  }
  // Retry resends the saved transfer under its saved action ID: the kit
  // rebroadcasts the same signed bytes, or signs once if nothing was signed.
  async tnkRetry(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(value && Object.keys(value).length === 1, 'invalid_tnk_send');
    const send = this.loadTnk(value.id);
    dashboardCheck((await this.tnkState(send)).retry, 'tnk_nothing_to_retry', 409);
    this.runTnk(send.id);
    return this.tnkView(send);
  }
  runTnk(id) {
    // Queued counts as sending: a second click cannot queue the same send twice.
    const { actionId } = this.loadTnk(id);
    this.tnkSending.add(actionId);
    const task = this.tnkTail.then(() => this.tnkNow(id, actionId));
    this.tnkTail = task.catch(() => {});
    return task;
  }
  async tnkNow(id, actionId) {
    if (this.closed) { this.tnkSending.delete(actionId); return; }
    const { to, amount } = this.loadTnk(id);
    let error = null, result = null;
    try { result = await this.agent.sendTnkTransfer({ actionId, to, amount }); }
    catch (e) { error = dashboardError(e); }
    finally { this.tnkSending.delete(actionId); }
    const saved = this.loadTnk(id);
    saved.tried = true; if (error) saved.error = error; else delete saved.error;
    if (result?.sent) saved.sentAt = Date.now();
    this.tnkStatus.delete(actionId); this.tnkCache = null;
    this.saveTnk(saved);
  }
  // Craft: the agent's units as ingredients with their properties, the
  // gateway's verified preview, warnings for claimed blocks, then the kit's
  // craft action with an action ID saved before it runs.
  // The page refresh reuses the activated settings for a minute; a preview
  // always reads them fresh with the accepted catalog root.
  async craftSettings(fresh = false) {
    if (fresh || !this.craftContext || Date.now() - this.craftContext.at >= CRAFT_TTL) {
      const context = await this.agent.namedContext?.();
      dashboardCheck(context?.settings, 'craft_unavailable', 409);
      this.craftContext = { at: Date.now(), context };
    }
    const { context } = this.craftContext;
    return { context, maxInputs: context.settings.values.compoundInputs, ratio: context.settings.values.compoundRatio };
  }
  // Catalog rows for ingredient properties and compound records, kept for a
  // minute so the page refresh stays a few reads.
  async craftRead(key, read) {
    const hit = this.craftReads.get(key);
    if (hit && Date.now() - hit.at < CRAFT_TTL) return hit.value;
    const value = await read();
    if (this.craftReads.size >= 200) this.craftReads.clear();
    // A compound not readable yet (just crafted) is asked again next time.
    if (value !== null) this.craftReads.set(key, { at: Date.now(), value });
    return value;
  }
  compoundRecord(asset) {
    return this.craftRead('c/' + asset, async () => (await this.service.compounds({ asset, limit: 1 })).compounds?.find(c => c.id === asset || c.asset === asset) ?? null);
  }
  // Each ingredient's properties as the rules pin them: a pattern's charge is
  // its number mod 65521, its spectrum the header field it was found in, and
  // generation 0; a compound carries the properties of its accepted record.
  async ingredient(u, active = false) {
    const base = { asset: u.asset, name: u.name, kind: u.kind, tier: u.tier, available: u.available, current: u.current };
    if (u.kind === 'pattern' || u.kind === 'legacy') {
      let p = null;
      try { p = await this.craftRead('p/' + canonicalAsset(u.asset), async () => (await this.service.patterns({ asset: canonicalAsset(u.asset), limit: 1 })).patterns?.[0] ?? null); } catch { /* properties unknown */ }
      const number = /^p2:(0|[1-9][0-9]*)$/.exec(canonicalAsset(u.asset))?.[1];
      const recognized = u.kind !== 'legacy' || p?.legacy?.asset === u.asset;
      if (!recognized || number === undefined) return { ...base, craftable: false, reason: 'craft_unit_unknown' };
      const craftable = u.kind !== 'legacy' || active;
      return { ...base, craftable, ...(!craftable ? { reason: recognized ? 'craft_upgrade_pending' : 'craft_unit_unknown' } : {}), properties: { charge: Number(BigInt(number) % CHARGE_MOD), spectrum: SPECTRUM_FIELD[p?.fld] ?? null, generation: '0',
        matches: integer(p?.knownMatchCount) ? String(p.knownMatchCount) : null } };
    }
    let record = null;
    try { record = await this.compoundRecord(u.asset); } catch { /* properties unknown */ }
    const props = record?.properties;
    return { ...base, craftable: true, properties: props ? { charge: props.charge, spectrum: Number.isSafeInteger(props.spectrum) ? props.spectrum : null, generation: String(props.generation), matches: null } : null };
  }
  // Units available to craft: available to send, minus units in crafts that
  // have not confirmed yet.
  async ingredients(units) {
    const active = compoundIdentityV4Active((await this.agent.trac.head()).counted);
    const pending = this.craftPending(), owned = units.filter(u => BigInt(u.available) > 0n).map(u => {
      const out = pending.get(u.asset) ?? 0n, left = BigInt(u.available) - out;
      return { ...u, available: String(left > 0n ? left : 0n) };
    }), ingredients = [];
    for (let i = 0; i < owned.length; i += 4) ingredients.push(...await Promise.all(owned.slice(i, i + 4).map(u => this.ingredient(u, active))));
    return ingredients;
  }
  async craft() {
    const { maxInputs, ratio } = await this.craftSettings();
    const { units, more } = await this.units(), ingredients = await this.ingredients(units);
    const compounds = [];
    for (const u of units.filter(u => u.kind === 'compound')) compounds.push(await this.compoundView(u));
    const crafts = [];
    for (const c of this.savedCrafts()) crafts.push(await this.craftView(c));
    return { maxInputs, ratio, ingredients, compounds, crafts, more };
  }
  async compoundView(u) {
    let record = null;
    try { record = await this.compoundRecord(u.asset); } catch { /* shown without details */ }
    const tier = record ? tierValue(record.tierProgress?.value ?? record.tier) : u.tier;
    const from = [];
    for (const input of compoundInputs(record).slice(0, 8)) from.push({ asset: input[0], amount: input[1], name: (await this.unitLabel(input[0])).name });
    const refine = this.savedCrafts(CRAFT_RECENT * 3).find(c => c.kind === 'refine' && c.asset === u.asset);
    const p = record?.properties ?? {}, maker = record ? wireIdentities(record).firstMaker : null;
    const firstMaker = !!maker && maker === this.agent.owner, token = await this.compoundToken(u.asset);
    const deployment = token === 'not_deployed' ? await this.craftRead('d/' + u.asset, async () => {
      const d = await this.service.deploymentState(u.asset);
      return d ? { inflight: d.inflight ?? null, state: d.state ?? null, reason: d.reason ?? null, chosenTicker: d.chosenTicker ?? null } : null;
    }).catch(() => null) : null;
    const inflight = deployment?.inflight ?? null;
    return { asset: u.asset, name: u.name, amount: u.amount, available: u.available, tier, recipe: record?.recipe ?? null, from,
      generation: p.generation === undefined ? null : String(p.generation), charge: p.charge ?? null, spectrum: p.spectrum ?? null,
      firstMaker, token, ticker: token === 'deployed' ? await this.compoundTicker(u.asset) : null,
      inflight: /^[0-9a-f]{64}$/.test(inflight?.revealTxid ?? '') ? inflight : null,
      // The first maker deploys the token on the same deployment page as patterns, with the agent's address filled in.
      deploymentLink: firstMaker && token === 'not_deployed' ? this.service.deploymentLink(u.asset, this.agent.address, this.agent.paymentOrigin) : null,
      // The official ticker the first maker chose (null: not chosen yet). It can change until the deploy is in a block.
      tickerChoice: firstMaker && token === 'not_deployed' && deployment ? { state: deployment.state, reason: deployment.reason,
        tick: deployment.chosenTicker?.tick ?? null, revision: deployment.chosenTicker?.revision ?? 0 } : null,
      needsRefine: !!record && tier === null, refine: refine ? await this.craftView(refine) : null };
  }
  // The first maker's agent signs the compound's official ticker; the gateway checks it like
  // "deploy your own ticker" and answers with the deployment, now waiting for the deploy.
  async chooseCompoundTicker(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(value && Object.keys(value).sort().join(',') === 'asset,ticker' && /^c2:[0-9a-f]{64}$/.test(value.asset) && typeof value.ticker === 'string', 'invalid_ticker_request');
    let ticker; try { ticker = validateOfficialTicker(value.ticker); } catch (error) { dashboardCheck(false, error.message); }
    const record = await this.compoundRecord(value.asset);
    dashboardCheck(record && wireIdentities(record).firstMaker === this.agent.owner, 'not_first_maker', 403);
    const state = await this.service.deploymentState(value.asset);
    const revision = (state?.chosenTicker?.revision ?? 0) + 1, expiry = Date.now() + 600000;
    const message = compoundTickerMessage({ network: this.agent.network, asset: value.asset, ticker, revision, expiry, firstMaker: this.agent.address });
    const job = await this.service.chooseCompoundTicker({ asset: value.asset, ticker, revision, expiry, agentSignature: signBytes(this.agent.wallet, Buffer.from(message)) });
    this.craftReads.delete('d/' + value.asset);
    return { asset: value.asset, state: job.state, tick: job.chosenTicker?.tick ?? null, revision: job.chosenTicker?.revision ?? revision,
      deploymentLink: this.service.deploymentLink(value.asset, this.agent.address, this.agent.paymentOrigin) };
  }
  // A deployed compound's ticker, from its registered deployment.
  async compoundTicker(asset) {
    try { return await this.craftRead('k/' + asset, async () => { const d = await this.service.deploymentState(asset); return d?.state === 'registered' ? d.entry?.tick ?? null : null; }); }
    catch { return null; }
  }
  // A compound's TAP token: 'deployed' once its first maker registered the deployment, else 'not_deployed'.
  async compoundToken(asset) {
    try {
      const row = await this.craftRead('t/' + asset, async () => ((await this.service.mintRights(this.agent.address, { asset, limit: 1 })).mintRights ?? []).find(r => r.asset === asset) ?? null);
      return row ? row.deploymentRegistered === true ? 'deployed' : 'not_deployed' : 'unknown';
    } catch { return 'unknown'; }
  }
  // Make units of a held compound real on TAP: the agent signs a mint request for `amount` units;
  // payment and inscription continue on the request page with the wallet checks there.
  mintCompound(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(value && Object.keys(value).sort().join(',') === (value.deployment === undefined ? 'amount,asset' : 'amount,asset,deployment') && (value.deployment === undefined || typeof value.deployment === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(value.deployment)) && /^c2:[0-9a-f]{64}$/.test(value.asset) && amountText(String(value.amount)) && BigInt(value.amount) > 0n, 'invalid_compound_mint');
    const key = 'compound/' + value.asset;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const task = Promise.resolve().then(() => this.mintCompoundNow(value.asset, String(value.amount).trim(), value.deployment));
    this.inflight.set(key, task);
    task.finally(() => this.inflight.delete(key)).catch(() => {});
    return task;
  }
  // The newest saved compound mint for this asset; a refused one is never resent.
  savedCompoundMint(asset) {
    return this.savedMints().find(row => row.body.request.asset === asset && row.body.request.block === undefined && row.state !== 'rejected');
  }
  // The saved action exactly as it was signed: same action ID, same intent.
  savedCompoundArguments(row) {
    const body = row.body, intent = { asset: body.request.asset, amount: body.request.amount, ...(body.request.deployment === undefined ? {} : { deployment: body.request.deployment }), receiver: body.receiver, payer: body.payer, kind: body.kind, compound: true };
    dashboardCheck(digest(stableJSON(intent)) === row.fingerprint, 'saved_mint_intent_unavailable', 409);
    return { ...intent, actionId: row.id.slice(5) };
  }
  async mintCompoundNow(asset, amount, deployment) {
    const payout = await this.payout(), old = this.savedCompoundMint(asset);
    let args;
    if (old) {
      // Until the saved request is minted or expired, a retry continues it and never signs a second one.
      const id = this.idOf(old);
      let status = null;
      try { status = await this.status(id); } catch (error) { if (error.status !== 404) throw error; }
      if (!status || !['minted', 'expired'].includes(status.state)) {
        if (status && status.state !== 'authorizing') return { requestId: id, status, paymentLink: this.service.paymentLink(id, this.agent.paymentOrigin), replayed: true, amount: old.body.request.amount };
        dashboardCheck(old.body.receiver === payout && old.body.payer === payout && old.body.kind === 'tap', 'saved_payout_changed', 409);
        args = this.savedCompoundArguments(old);
      }
    }
    if (!args) {
      dashboardCheck(await this.compoundToken(asset) === 'deployed', 'compound_not_deployed', 409);
      const held = (await this.units()).units.find(u => u.asset === asset);
      dashboardCheck(held && BigInt(amount) <= BigInt(held.available), 'compound_over_available', 409);
      args = { actionId: 'dashboard-' + digest(this.agent.network + '/' + this.agent.owner + '/' + asset + '/' + amount + '/' + Date.now()).slice(0, 48),
        asset, amount, ...(deployment === undefined ? {} : { deployment }), receiver: payout, payer: payout, kind: 'tap', compound: true };
    }
    const result = await runTool(this.context, 'mint_on_chain', args);
    const saved = this.journal.get('mint/' + args.actionId), id = saved?.body?.request ? this.idOf(saved) : result.request?.id ?? result.request?.requestId;
    if (!requestId(id)) return { state: result.state ?? 'unknown', signed: result.signed === true };
    return { requestId: id, paymentLink: this.service.paymentLink(id, this.agent.paymentOrigin), ...(args.amount === amount ? {} : { replayed: true, amount: args.amount }) };
  }
  // Inputs as the craft action takes them: canonical pairs sorted by key.
  craftInputs(value) {
    dashboardCheck(value && ['fusion', 'resonance'].includes(value.recipe) && Array.isArray(value.inputs) && value.inputs.length <= 16, 'invalid_craft');
    const inputs = value.inputs.map(row => {
      dashboardCheck(Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && amountText(String(row[1])), 'craft_amount');
      dashboardCheck(/^(p2:(0|[1-9][0-9]{0,77})|p[0-9a-z]{1,23}|c2:[0-9a-f]{64})$/.test(row[0]), 'invalid_craft');
      return [row[0], String(row[1]).trim()];
    }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    dashboardCheck(inputs.length >= 2 && inputs.every(([a], i) => !i || a !== inputs[i - 1][0]), 'craft_two_inputs');
    return { recipe: value.recipe, inputs };
  }
  // Read-only: the verified result before anything is signed, the units each
  // ingredient keeps, and claimed blocks those units may be needed for.
  async craftPreview(value) {
    dashboardCheck(value && Object.keys(value).every(k => ['recipe', 'inputs'].includes(k)), 'invalid_craft');
    const { recipe, inputs } = this.craftInputs(value), { context, maxInputs } = await this.craftSettings(true);
    dashboardCheck(inputs.length <= maxInputs, 'craft_too_many_inputs');
    const ingredients = await this.ingredients((await this.units()).units), rows = inputs.map(([asset, amount]) => {
      const i = ingredients.find(i => i.asset === asset);
      dashboardCheck(i?.craftable, i?.reason ?? 'craft_unit_unknown');
      dashboardCheck(BigInt(amount) <= BigInt(i.available), 'craft_over_available');
      return { asset, amount, name: i.name, available: i.available, left: String(BigInt(i.available) - BigInt(amount)) };
    });
    let result;
    // A rules refusal (resonance_charge, compound_ratio, craft_preview_proof, …) is the player's answer, not a dashboard failure.
    try { ({ result } = await this.preview({ recipe, inputs }, context)); }
    catch (error) { if (error.status === undefined && /^[a-z][a-z0-9_]{0,80}$/.test(error.message)) error.status = 400; throw error; }
    const record = result.record, names = [...new Map(rows.map(r => [canonicalAsset(r.asset), r.name]))]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, name]) => name);
    return { recipe, inputs: rows,
      result: { id: record.id, amount: result.amount, existing: !!result.existing, tier: tierValue(record.tier), label: `${names.map(niceName).join(' + ')} ${recipe}`,
        properties: { charge: record.properties.charge, spectrum: record.properties.spectrum, generation: String(record.properties.generation) }, snapshot: record.snapshot?.height ?? null },
      warnings: await this.craftWarnings(rows) };
  }
  preview(args, context) { return previewCraftNamed(this.agent, args, context); }
  // Claimed blocks this agent may mint, per pattern ingredient, with the units
  // they need. Bounded: two pages of mint rights per ingredient.
  async craftWarnings(rows) {
    const warnings = [];
    for (const r of rows.filter(r => assetId(r.asset))) {
      let page;
      try { page = await this.collect(cursor => this.service.mintRights(this.agent.address, { asset: r.asset, minted: false, limit: 50, cursor }), 'mintRights', 2); }
      catch { warnings.push({ code: 'craft_claims_unknown', asset: r.asset, name: r.name }); continue; }
      const blocks = new Map();
      for (const row of page.rows) if (!row.minted && !row.void && this.eligible(row) && integer(row.find?.count)) blocks.set(String(row.find.block ?? row.block), BigInt(row.find.count));
      if (!blocks.size) continue;
      const need = [...blocks.values()].reduce((n, v) => n + v, 0n);
      warnings.push({ code: BigInt(r.left) < need ? 'craft_uses_mint_units' : 'craft_mint_units_ok', asset: r.asset, name: r.name, blocks: blocks.size, more: page.more,
        units: String(need), left: r.left, available: r.available });
    }
    return warnings;
  }
  savedCrafts(limit = CRAFT_RECENT) {
    return this.journal.db.prepare('SELECT value FROM dashboard_crafts WHERE scope=? ORDER BY rowid DESC LIMIT ?').all(this.journal.scope, limit).map(r => JSON.parse(r.value));
  }
  saveCraft(craft) {
    this.journal.db.prepare('INSERT INTO dashboard_crafts(scope,id,value) VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET value=excluded.value').run(this.journal.scope, craft.id, JSON.stringify(craft));
  }
  loadCraft(id) {
    dashboardCheck(typeof id === 'string' && /^[0-9a-f]{12}$/.test(id), 'invalid_craft');
    const row = this.journal.db.prepare('SELECT value FROM dashboard_crafts WHERE scope=? AND id=?').get(this.journal.scope, id);
    dashboardCheck(row, 'craft_not_found', 404); return JSON.parse(row.value);
  }
  // Units going into crafts that have not confirmed yet.
  craftPending() {
    const out = new Map();
    for (const c of this.savedCrafts(CRAFT_RECENT * 3)) {
      if (c.kind === 'refine' || ['confirmed', 'failed'].includes(this.craftState(c).state)) continue;
      for (const [asset, amount] of c.inputs) out.set(asset, (out.get(asset) ?? 0n) + BigInt(amount));
    }
    return out;
  }
  // A craft's state from the kit's journal: the signed intent, then the
  // gateway receipt; the dashboard row only adds the last error and the
  // public confirmation.
  craftState(c) {
    const key = c.kind === 'refine' ? `compound-refine/${c.actionId}` : `craft/${c.actionId}`;
    const intent = this.journal.get(c.kind === 'refine' ? `${key}/intent` : `${key}/v2-intent`), move = this.journal.get(key);
    const running = this.crafting.has(c.actionId), batch = move?.result?.batch ?? null, signed = !!intent;
    if (c.confirmed) return { state: 'confirmed', batch: c.confirmed.batch ?? batch, signed };
    if (c.complete) return { state: 'confirmed', batch, signed };
    if (move?.state === 'rejected') return { state: 'failed', batch, error: 'craft_rejected', signed };
    if (move && ['received', 'accepted'].includes(move.state)) return { state: 'received', batch, signed };
    if (running) return { state: 'crafting', batch, signed };
    if (move && ['sending', 'unknown'].includes(move.state)) return { state: 'uncertain', batch, error: c.error ?? null, signed };
    if (c.error && SEND_LATER.includes(c.error)) return { state: 'queued', batch, error: c.error, signed };
    if (c.error) return { state: signed ? 'uncertain' : 'failed', batch, error: c.error, signed };
    return { state: c.tried ? 'uncertain' : 'waiting', batch, signed };
  }
  async craftConfirm(open) {
    // The accepted craft's public event: its id from the receipt's move, or
    // this agent's craft event of the snapshot-bound compound key.
    const wanted = new Map(), made = new Map();
    for (const c of open) {
      const receipt = this.journal.get(`craft/${c.actionId}`)?.result, asset = this.journal.get(`craft/${c.actionId}/v2-intent`)?.body?.result?.record?.id;
      if (typeof receipt?.move === 'string') wanted.set(digest('v2-event/craft/' + receipt.move), c);
      if (typeof asset === 'string') made.set(asset, c);
    }
    if (!wanted.size) return;
    let events = this.craftEvents && Date.now() - this.craftEvents.at < CONFIRM_TTL ? this.craftEvents.rows : null;
    if (!events) {
      events = (await this.collect(cursor => this.service.profile(this.agent.address, { collection: 'history', type: 'craft', limit: 50, cursor }), 'history', CONFIRM_PAGES)).rows;
      this.craftEvents = { at: Date.now(), rows: events };
    }
    for (const event of events) {
      const c = wanted.get(event?.id) ?? (event?.type === 'craft' && wireIdentities(event.data ?? {}).owner === this.agent.owner ? made.get(event.data.asset) : undefined);
      if (c && !c.confirmed) { c.confirmed = { batch: event.provenance?.batch ?? null }; this.saveCraft(c); }
    }
  }
  async craftView(c) {
    if (c.kind !== 'refine' && !c.confirmed && this.journal.get(`craft/${c.actionId}`)?.result?.move) {
      try { await this.craftConfirm([c]); } catch { /* shown as sent */ }
    }
    const intent = c.kind === 'refine' ? null : this.journal.get(`craft/${c.actionId}/v2-intent`);
    const out = intent?.body?.result;
    return { id: c.id, kind: c.kind ?? 'craft', createdAt: c.createdAt, recipe: c.recipe ?? null, label: c.label ?? null, asset: c.asset ?? out?.record?.id ?? null,
      amount: out?.amount ?? null, inputs: await Promise.all((c.inputs ?? []).map(async ([asset, amount]) => ({ asset, amount, name: (await this.unitLabel(asset)).name }))),
      ...this.craftState(c) };
  }
  // Save the action ID, then run the kit's craft action. The action itself
  // verifies the same preview again and signs only what it shows.
  async craftStart(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    const preview = await this.craftPreview(value);
    const id = randomBytes(6).toString('hex');
    const craft = { id, actionId: `dash-craft-${id}`, createdAt: Date.now(), recipe: preview.recipe, inputs: preview.inputs.map(r => [r.asset, r.amount]), label: preview.result.label };
    this.saveCraft(craft); this.runCraft(id);
    return this.craftView(craft);
  }
  async craftRetry(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(value && Object.keys(value).length === 1, 'invalid_craft');
    const craft = this.loadCraft(value.id);
    dashboardCheck(['failed', 'uncertain', 'queued', 'waiting'].includes(this.craftState(craft).state) && this.craftState(craft).error !== 'craft_rejected' && !this.crafting.has(craft.actionId), 'craft_nothing_to_retry', 409);
    this.runCraft(craft.id);
    return this.craftView(craft);
  }
  // Exact tier work for a compound whose tier is still open; one saved
  // action ID per step, reused until that step is answered.
  async craftRefine(value) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(value && Object.keys(value).length === 1 && /^c2:[0-9a-f]{64}$/.test(value.asset ?? ''), 'invalid_craft');
    const { units } = await this.units();
    dashboardCheck(units.some(u => u.asset === value.asset), 'craft_unit_unknown');
    const open = this.savedCrafts(CRAFT_RECENT * 3).find(c => c.kind === 'refine' && c.asset === value.asset && !['confirmed', 'received'].includes(this.craftState(c).state));
    const id = open?.id ?? randomBytes(6).toString('hex');
    const refine = open ?? { id, kind: 'refine', actionId: `dash-refine-${id}`, createdAt: Date.now(), asset: value.asset, inputs: [] };
    dashboardCheck(!this.crafting.has(refine.actionId), 'craft_running', 409);
    this.saveCraft(refine); this.runCraft(id);
    return this.craftView(refine);
  }
  runCraft(id) {
    const task = this.craftTail.then(() => this.craftNow(id));
    this.craftTail = task.catch(() => {});
    return task;
  }
  async craftNow(id) {
    if (this.closed) return;
    const c = this.loadCraft(id);
    this.crafting.add(c.actionId);
    let error = null, complete = false;
    try {
      const result = c.kind === 'refine' ? await runTool(this.context, 'refine_compound', { actionId: c.actionId, asset: c.asset })
        : await runTool(this.context, 'craft', { actionId: c.actionId, recipe: c.recipe, inputs: c.inputs });
      complete = result?.state === 'complete';
    } catch (e) { error = /^Saved packet outcome is unknown/.test(e?.message) ? 'craft_outcome_unknown' : dashboardError(e); }
    finally { this.crafting.delete(c.actionId); }
    const saved = this.loadCraft(id);
    saved.tried = true; if (error) saved.error = error; else delete saved.error;
    if (complete) saved.complete = true;
    this.saveCraft(saved); this.labels.clear();
  }
  walletKey(key) {
    dashboardCheck(typeof key === 'string' && key.length <= 300 && key.startsWith(this.agent.bitcoinNetwork + '/') && /^[a-zA-Z0-9/:-]+$/.test(key), 'invalid_wallet_key');
    return key;
  }
  // The browser session survives dashboard restarts: it is kept with the
  // player's private journal, never in a terminal or log.
  session(create) {
    const db = this.journal.db, key = '\u0000dashboard-session';
    const row = db.prepare('SELECT value FROM dashboard_wallet WHERE scope=? AND key=?').get(this.journal.scope, key);
    if (row && /^[A-Za-z0-9_-]{43}$/.test(row.value)) return row.value;
    const value = create();
    db.prepare('INSERT OR REPLACE INTO dashboard_wallet(scope,key,value) VALUES(?,?,?)').run(this.journal.scope, key, value);
    return value;
  }
  walletGet(key) {
    const row = this.journal.db.prepare('SELECT value FROM dashboard_wallet WHERE scope=? AND key=?').get(this.journal.scope, this.walletKey(key));
    return row ? JSON.parse(row.value) : null;
  }
  walletLock({ key, owner, release = false }) {
    this.walletKey(key); dashboardCheck(typeof owner === 'string' && /^[0-9a-f-]{36}$/.test(owner), 'invalid_wallet_lock');
    const current = this.walletLocks.get(key);
    dashboardCheck(release ? current === owner : !current, 'wallet_busy', 409);
    if (release) this.walletLocks.delete(key); else this.walletLocks.set(key, owner);
    return { locked: !release };
  }
  walletPut({ key, owner, value }) {
    this.walletKey(key); dashboardCheck(this.walletLocks.get(key) === owner && owner, 'wallet_lock_required', 409);
    dashboardCheck(value && typeof value === 'object' && !Array.isArray(value), 'invalid_wallet_record');
    this.journal.db.prepare('INSERT INTO dashboard_wallet(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value')
      .run(this.journal.scope, key, JSON.stringify(value));
    return { saved: true };
  }
  async close() {
    this.closed = true; clearTimeout(this.bulkTimer); this.wakeSend?.();
    try { await this.bulkLinks.close(); await this.batchTask; await Promise.allSettled([...this.inflight.values()]); await this.sendTail; await this.tnkTail; await this.craftTail; }
    finally {
      if (this.active) this.journal.db.prepare('DELETE FROM dashboard_runtime WHERE scope=? AND instance=?').run(this.journal.scope, this.instance);
      this.active = false;
    }
  }
}
