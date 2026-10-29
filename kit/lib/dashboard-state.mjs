import { createHash, randomUUID } from 'node:crypto';
import { runTool } from './tools.mjs';
import { stableJSON } from '../../rules/src/index.js';
import { nextCursor } from './api-values.mjs';
import { safeCode } from './errors.mjs';
import { financialMintId } from '../../rules/src/financial-mint.js';
import { wireIdentities } from '../../rules/src/trac-address.js';
import { verifyBinding } from '../../rules/src/payout-bindings.mjs';

export function dashboardCheck(ok, code, status = 400) {
  if (!ok) throw Object.assign(Error(code), { code, status });
}
export const dashboardError = error => safeCode(error?.code ?? error?.message, 'dashboard_request_failed');
const digest = value => createHash('sha256').update(value).digest('hex');
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

// Financial requests have their own sequential queue. Mining's per-tip move
// allowance must not make a human's mint click wait for another Bitcoin block.
export function dashboardJournal(journal) {
  return Object.assign(Object.create(journal), { waitTurn: async getHead => getHead(), finishTurn() {} });
}

export class DashboardState {
  constructor(context) {
    this.context = context; this.agent = context.agent;
    dashboardCheck(!this.agent.dryRun, 'dashboard_requires_live_signer');
    this.journal = this.agent.journal; this.service = this.agent.service;
    this.queue = Promise.resolve(); this.inflight = new Map(); this.names = new Map(); this.closed = false;
    this.batch = null; this.batchTask = null; this.walletLocks = new Map(); this.instance = randomUUID();
    this.journal.db.exec('CREATE TABLE IF NOT EXISTS dashboard_wallet (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,key))');
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
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  savedMints() {
    return this.journal.db.prepare("SELECT id FROM actions WHERE scope=? AND id LIKE 'mint/%' AND id NOT LIKE '%/reservation-v2' ORDER BY rowid DESC")
      .all(this.journal.scope).map(({ id }) => this.journal.get(id)).filter(row => row.body?.request);
  }
  savedSlot(slot) { return this.savedMints().find(row => sameSlot(row.body.request, slot)); }
  idOf(row) { return financialMintId(this.agent.network, row.body.request); }
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
      payoutAddress, payoutError, batch: this.batch };
  }
  async candidate(slot) {
    dashboardCheck(assetId(slot.asset) && integer(slot.block), 'invalid_claim');
    const rows = await this.context.candidates(slot.asset, { block: slot.block, kind: 'tap' });
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
  async name(asset, fallback) { return fallback || (await this.pattern(asset)).name; }
  async claim(row, c, balance) {
    dashboardCheck(assetId(row.asset) && integer(row.block), 'invalid_claim_response', 502);
    const saved = this.savedSlot(row);
    let id = saved ? this.idOf(saved) : c.pending?.id;
    let status = null, statusError = null;
    if (requestId(id)) try { status = await this.status(id, row); } catch (error) { statusError = dashboardError(error); }
    if (statusError === 'not_your_request') { id = null; statusError = null; }
    const minted = !!(row.minted || c.minted || status?.state === 'minted');
    const pending = !minted && status?.state !== 'expired' && !!(c.pending || saved || status);
    const reason = statusError ?? this.mintReason(c, balance);
    return { asset: row.asset, block: String(row.block), count: String(c.find.count),
      name: await this.name(row.asset, row.name ?? row.pattern?.name), minted, pending,
      payable: !minted && status?.payable === true, requestId: requestId(id) ? id : null,
      state: minted ? 'minted' : status?.state ?? (pending ? 'pending' : 'unminted'),
      canMint: !minted && !reason && !saved && !status,
      reason, role: this.role(c), eligibility: { finder: 'own find', bitmap: 'Bitmap holder', public: 'units' }[this.role(c)],
      balance: balance.amount, balanceCurrent: balance.current && c.balance !== null,
      finderUntil: c.finderUntil ?? c.find.finderUntil ?? null,
      findHeight: c.find.findHeight ?? null,
      deploymentLink: !minted && !pending && !saved && reason === 'asset_unregistered'
        ? this.service.deploymentLink(canonicalAsset(row.asset), this.agent.address, this.agent.paymentOrigin) : null,
      paymentLink: requestId(id) ? this.service.paymentLink(id, this.agent.paymentOrigin) : null };
  }
  // asset: one pattern only, in the form the gateway lists it (see patterns()).
  async claims({ cursor, limit = 25, asset } = {}) {
    dashboardCheck(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'invalid_page_limit');
    dashboardCheck(asset === undefined || assetId(asset), 'invalid_asset');
    let position = claimCursor(cursor);
    const claims = [], balances = new Map();
    // The sources are disjoint: own finder-week rows, then other allowed and
    // blocked eligible rows. Each gateway cursor retains its filters/order.
    while (position && claims.length < limit) {
      const { source } = position;
      const options = { limit: limit - claims.length, sort: 'block', order: 'desc', cursor: position.cursor, minted: false, ...(asset ? { asset } : {}) };
      const page = source === 'finds'
        ? await this.service.profile(this.agent.address, { ...options, collection: 'finds' })
        : await this.service.mintRights(this.agent.address, { ...options, allowed: source === 'allowed' });
      const entries = source === 'finds' ? page.finds : page.mintRights;
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
      if (!discoverer || discoverer === this.agent.owner) add(row.asset, { discovered: true, name: row.name ?? null, tier: row.tier ?? null });
    }
    // Patterns with claims: the newest own finds, mint rights and held units.
    const pages = await Promise.all([
      this.service.profile(address, { collection: 'finds', limit: 50, minted: false, sort: 'block', order: 'desc' }).then(p => p.finds),
      this.service.mintRights(address, { limit: 50, minted: false }).then(p => p.mintRights),
      this.service.profile(address, { collection: 'balances', limit: 50 }).then(p => p.balances)].map(read => read.catch(() => [])));
    for (const rows of pages) for (const row of Array.isArray(rows) ? rows : []) if (!row.compound) add(row.asset);
    const list = [...found.values()].sort((a, b) => patternNumber(a.asset) < patternNumber(b.asset) ? -1 : patternNumber(a.asset) > patternNumber(b.asset) ? 1 : 0);
    const shown = list.slice(0, PATTERN_LIMIT), patterns = [];
    for (let i = 0; i < shown.length; i += 4) patterns.push(...await Promise.all(shown.slice(i, i + 4).map(p => this.patternRow(p))));
    return { patterns: patterns.filter(p => p.discovered || p.claims !== 0), more: discoveries.more || list.length > PATTERN_LIMIT };
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
    return { asset: p.asset, id, name: p.name ?? deployment?.displayLabel ?? detail?.name ?? p.asset, tier: p.tier ?? detail?.tier ?? null, discovered: p.discovered,
      token, deploymentState: deployment?.state ?? null,
      // null: the count could not be read this time.
      claims: finds && rights ? new Set([...unique(finds.rows), ...unique(rights.rows)]).size : null, moreClaims: !!(finds?.more || rights?.more),
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
    return { ...result, localWalletProgress: walletProgress, paymentLink: this.service.paymentLink(id, this.agent.paymentOrigin) };
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
        payable: status.state === 'awaiting_payment', error: status.error ?? null, paymentLink: '/link/' + id });
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
  async payment(value) {
    dashboardCheck(value && Object.keys(value).every(k => ['id', 'paymentId', 'inscription'].includes(k)) && requestId(value.id) &&
      ['paymentId', 'inscription'].filter(k => value[k] !== undefined).length === 1 &&
      /^[0-9a-f]{64}i(0|[1-9][0-9]{0,9})$/.test(value.paymentId ?? value.inscription), 'invalid_payment_report');
    await this.status(value.id);
    return this.service.reportMintPayment(value);
  }
  async requests({ offset = 0, limit = 25 } = {}) {
    dashboardCheck(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'invalid_page_limit');
    const saved = this.savedMints(), requests = [];
    for (const row of saved.slice(offset, offset + limit)) {
      const id = this.idOf(row); let status;
      try { status = await this.status(id); } catch (error) { status = { state: 'unknown', error: dashboardError(error) }; }
      if (status.state !== 'minted') requests.push({ asset: row.body.request.asset, block: row.body.request.block, requestId: id,
        state: status.state, payable: status.payable === true, error: status.error ?? null,
        paymentLink: this.service.paymentLink(id, this.agent.paymentOrigin) });
    }
    return { requests, next: offset + limit < saved.length ? offset + limit : null, batch: this.batch };
  }
  mint(slot) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    dashboardCheck(slot && Object.keys(slot).every(k => ['asset', 'block'].includes(k)) && assetId(slot.asset) && integer(slot.block), 'invalid_claim');
    const key = canonicalAsset(slot.asset) + '/' + slot.block;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const task = this.queue.then(() => this.mintNow(slot));
    this.queue = task.catch(() => {});
    this.inflight.set(key, task);
    task.finally(() => this.inflight.delete(key)).catch(() => {});
    return task;
  }
  savedArguments(row, slot) {
    const body = row.body, r = body.request;
    const assets = [...new Set([slot.asset, r.asset, canonicalAsset(r.asset)])];
    const blocks = [r.block, ...(Number.isSafeInteger(Number(r.block)) ? [Number(r.block)] : [])];
    for (const asset of assets) for (const block of blocks) {
      const intent = { asset, block, amount: r.amount, receiver: body.receiver, payer: body.payer, kind: body.kind, compound: false };
      if (digest(stableJSON(intent)) === row.fingerprint) return { ...intent, actionId: row.id.slice(5) };
    }
    dashboardCheck(false, 'saved_mint_intent_unavailable', 409);
  }
  async mintNow(slot) {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    const c = await this.candidate(slot);
    dashboardCheck(!c.minted && !c.void, 'already_minted', 409);
    const payout = await this.payout(), old = this.savedSlot(slot);
    if (old || c.pending) {
      const id = old ? this.idOf(old) : c.pending.id;
      try {
        const status = await this.status(id, slot);
        dashboardCheck(status.state !== 'minted', 'already_minted', 409);
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
      actionId: 'dashboard-' + digest(this.agent.network + '/' + this.agent.owner + '/' + canonicalAsset(slot.asset) + '/' + slot.block).slice(0, 48),
      asset: slot.asset, block: String(slot.block), amount: String(c.find.count), receiver: payout, payer: payout, kind: 'tap', compound: false };
    const result = await runTool(this.context, 'mint_on_chain', args);
    const saved = this.savedSlot(slot), id = saved ? this.idOf(saved) : result.request?.id ?? result.request?.requestId;
    if (!requestId(id)) return { state: result.state, signed: result.signed === true, deploymentLink: result.deploymentLink ?? null };
    // A delayed status read must never erase a successfully saved signature.
    let status;
    try { status = await this.status(id); } catch (error) { status = { state: 'unknown', error: dashboardError(error) }; }
    return { requestId: id, status, paymentLink: this.service.paymentLink(id, this.agent.paymentOrigin) };
  }
  mintAll() {
    dashboardCheck(!this.closed, 'dashboard_stopping', 503);
    if (this.batchTask) return this.batch;
    this.batch = { id: randomUUID(), state: 'running', completed: 0, failed: 0, deploymentNeeded: [], errors: [] };
    this.batchTask = (async () => {
      let cursor, restarts = 0; const seen = new Set(), cursors = new Set();
      do {
        if (this.closed) break;
        let page;
        try { page = await this.claims({ cursor, limit: 25 }); }
        catch (error) {
          if (['page_cursor_stale', 'claimed_cursor_stale'].includes(error.code) && restarts++ < 3) { cursor = undefined; cursors.clear(); continue; }
          throw error;
        }
        for (const row of page.claims) {
          if (this.closed) break;
          const key = canonicalAsset(row.asset) + '/' + row.block;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!row.canMint) {
            if (row.deploymentLink && this.batch.deploymentNeeded.length < 20)
              this.batch.deploymentNeeded.push({ asset: row.asset, block: row.block, state: 'deployment_needed', deploymentLink: row.deploymentLink });
            continue;
          }
          try {
            const result = await this.mint({ asset: row.asset, block: row.block });
            if (result.requestId) this.batch.completed++;
            else if (this.batch.deploymentNeeded.length < 20) this.batch.deploymentNeeded.push({ asset: row.asset, block: row.block, state: result.state, deploymentLink: result.deploymentLink });
          }
          catch (error) { this.batch.failed++; if (this.batch.errors.length < 20) this.batch.errors.push({ asset: row.asset, block: row.block, error: dashboardError(error) }); }
        }
        cursor = page.next;
        dashboardCheck(!cursor || !cursors.has(cursor), 'repeated_cursor', 502); cursors.add(cursor);
      } while (cursor);
      this.batch.state = this.closed ? 'stopped' : 'complete';
    })().catch(error => { this.batch.state = 'failed'; this.batch.error = dashboardError(error); }).finally(() => { this.batchTask = null; });
    return this.batch;
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
    this.closed = true;
    try { await this.batchTask; await this.queue; }
    finally {
      if (this.active) this.journal.db.prepare('DELETE FROM dashboard_runtime WHERE scope=? AND instance=?').run(this.journal.scope, this.instance);
      this.active = false;
    }
  }
}
