import { randomUUID } from 'node:crypto';
import { LinkJobs, linkBlocks, linkCheck } from './link-jobs.mjs';
import { linkSettings } from './link-settings.mjs';
import { Journal } from './journal.mjs';
import { bitcoinAddress } from './addresses.mjs';
import { safeCode } from './errors.mjs';
import { LINK_RENEW_REFUSALS } from './financial-link.mjs';
import { financialLinkId } from '../../rules/src/financial-link.js';
import { wireIdentities } from '../../rules/src/trac-address.js';

const reason = value => ({ bitmap_missing: 'not_a_bitmap', bitmap_not_found: 'not_a_bitmap',
  bitmap_agent_binding: 'not_in_wallet', financial_link_owner: 'not_in_wallet',
  link_exists: 'already_linked' }[value] ?? value);
const finalReasons = new Set(['not_in_wallet', 'already_linked', 'not_a_bitmap', 'link_not_free', 'bulk_link_requires_v2']);
const retryReasons = new Set(['trac_snapshot_changed', 'financial_snapshot_changed', 'financial_transition_pending', 'bitmap_owner']);
const errorCode = error => safeCode(error?.code ?? error?.message, 'link_failed');
const busy = error => error?.status === 429 || error?.status >= 500 || error?.retryAfterMs !== undefined;
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function previewLinkJob(agent, input, settings = agent?.linkSettings) {
  linkCheck(input && Object.keys(input).every(k => ['blocks', 'payer'].includes(k)), 'invalid_blocks');
  const blocks = linkBlocks(input.blocks, linkSettings(settings).maxBlocks);
  let payer;
  try { payer = bitcoinAddress(input.payer ?? agent.ownerConfig?.payer?.tap, agent.bitcoinNetwork, 'payer'); }
  catch { linkCheck(false, 'invalid_payer'); }
  return { state: 'dry-run', action: 'link_bitmaps', blocks, payer, total: blocks.length, signed: false, sent: false };
}

// One worker per journal scope. Each pass submits at most one item through the
// agent's FIFO queue; rate waits release that queue instead of holding mining.
// Links have their own per-block budget (linkPacing), so mining never uses it up.
export class BulkLinkWorker {
  constructor(agent, { settings = agent.linkSettings, journal = agent.journal.rateJournal ?? agent.journal, pollMs = 5000 } = {}) {
    linkCheck(Number.isSafeInteger(pollMs) && pollMs > 0, 'invalid_link_poll_interval');
    this.agent = agent; this.journal = journal; this.jobs = new LinkJobs(journal, settings);
    this.pollMs = pollMs; this.instance = randomUUID(); this.controller = new AbortController();
    this.stopped = false; this.pending = null; this.task = null;
    const signal = this.controller.signal;
    // Use the ordinary journal gate even when human dashboard clicks bypass it.
    // Guard writes after shutdown, including an action still queued behind mining.
    const paced = Object.create(journal);
    for (const method of ['get', 'reserve', 'mark']) paced[method] = (...args) => {
      signal.throwIfAborted(); return journal[method](...args);
    };
    const checkActive = () => {
      signal.throwIfAborted();
      if (this.sendingItem && this.jobs.record(this.sendingItem.job).cancelled &&
        ['prepared', undefined].includes(journal.get('link/' + this.sendingItem.action_id)?.state))
        throw Object.assign(Error('link_job_cancelled'), { code: 'link_job_cancelled' });
    };
    const readHead = async getHead => { checkActive(); const head = await abortable(getHead(), signal); checkActive(); return head; };
    // The outer turn includes the quote: even a list of invalid or refused
    // Bitmaps must not produce a burst of unpaced preview POSTs.
    paced.waitTurn = getHead => readHead(getHead);
    paced.finishTurn = () => {};
    const service = Object.create(agent.service);
    if (agent.service.request) service.request = (path, options = {}) => {
      signal.throwIfAborted(); return agent.service.request.call(service, path, { ...options, signal, retry: false });
    };
    this.service = service;
    this.sender = Object.assign(Object.create(agent), { journal: paced, service });
    // Links count against their own budget, not the one mining moves use.
    const pace = { scope: journal.scope + '/links', ...this.jobs.settings.linkPacing };
    this.sender.exclusive = fn => abortable(agent.exclusive(async () => {
      await Journal.prototype.waitTurn.call(journal, () => readHead(() => agent.trac.head()), undefined, { waitForTurn: false, pace });
      try { return await fn(); } finally { if (!signal.aborted) journal.finishTurn(pace); }
    }), signal);
  }
  create(input) {
    linkCheck(!this.stopped, 'dashboard_stopping', 503);
    const preview = previewLinkJob(this.agent, input, this.jobs.settings);
    if (this.agent.dryRun) return preview;
    const result = this.jobs.create(preview); this.kicked = true; this.wake?.(); return result;
  }
  start() {
    linkCheck(!this.stopped, 'dashboard_stopping', 503);
    if (this.task || this.agent.dryRun) return;
    this.jobs.transaction(() => {
      const old = this.journal.db.prepare('SELECT * FROM link_job_worker WHERE scope=?').get(this.journal.scope);
      if (old) {
        let alive = true; try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        linkCheck(!alive, 'link_worker_running', 409);
      }
      this.journal.db.prepare('INSERT OR REPLACE INTO link_job_worker(scope,pid,instance) VALUES(?,?,?)').run(this.journal.scope, process.pid, this.instance);
    });
    this.task = this.run();
  }
  async pause(ms) {
    if (this.stopped) return;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); if (this.wake === done) this.wake = null; resolve(); };
      const timer = setTimeout(done, ms); this.wake = done;
    });
  }
  async run() {
    while (!this.stopped) {
      this.kicked = false;
      let worked = false;
      try { worked = await this.step(); } catch (error) { if (!this.stopped) this.lastError = errorCode(error); }
      if (!this.stopped) {
        const now = this.jobs.now(), delays = ['gateway', 'send'].map(kind => this.jobs.delayUntil(kind) - now).filter(ms => ms > 0);
        await this.pause(worked || this.kicked ? 0 : Math.min(this.pollMs, ...delays));
      }
    }
  }
  step() {
    if (this.stopped || this.agent.dryRun) return Promise.resolve(false);
    if (this.pending) return this.pending;
    this.pending = this.pass().finally(() => { this.pending = null; }); return this.pending;
  }
  saved(item) { return this.journal.get('link/' + item.action_id); }
  id(item, saved = this.saved(item)) {
    return item.request_id ?? (saved?.body?.request?.v === 2 ? financialLinkId(this.agent.network, saved.body.request) : null);
  }
  later(item, error) {
    const localPacing = error?.retryAfterMs !== undefined && error.status === undefined && !error.service;
    const until = this.jobs.now() + (localPacing ? error.retryAfterMs : Math.max(this.pollMs, error?.retryAfterMs ?? 0));
    this.jobs.update(item, { retry_at: until });
    if (error?.status === 429 || error?.status >= 500 || error?.service && error.status === undefined || retryReasons.has(errorCode(error)))
      this.jobs.defer('gateway', until);
    else if (error?.retryAfterMs !== undefined) this.jobs.defer('send', until);
  }
  fail(item, code) { this.jobs.update(item, { state: 'failed', reason: reason(code) }); }
  async poll(item) {
    const saved = this.saved(item), id = this.id(item, saved);
    if (!id) return { send: true };
    if (!item.request_id) this.jobs.update(item, { request_id: id });
    try {
      const status = wireIdentities(await abortable(this.service.linkStatus(id), this.controller.signal));
      if (this.stopped) return {};
      linkCheck((status.id ?? status.requestId) === id &&
        (status.block === undefined || status.block === item.block) &&
        (status.owner === undefined || status.owner === this.agent.owner), 'link_status_mismatch', 502);
      if (['accepted', 'linked'].includes(status.state)) this.jobs.update(item, { state: 'linked' });
      else if (['expired', 'credited', 'refunded'].includes(status.state)) this.jobs.renew(item);
      else if (['rejected', 'failed'].includes(status.state)) {
        const code = reason(safeCode(status.reason ?? status.error, 'link_failed'));
        if (LINK_RENEW_REFUSALS.includes(code) || ['request_expired', 'reservation_expired', 'financial_request_expired'].includes(code)) this.jobs.renew(item);
        else this.fail(item, code);
      } else if (status.state === 'authorizing') return { send: true };
      else this.later(item);
    } catch (error) {
      if (this.stopped) return {};
      if (error.status === 404 && errorCode(error) === 'request_not_found') {
        // A missing response alone never retires a signed request. It must be
        // absent at the gateway AND past its independently read deadline.
        const head = await abortable(this.agent.trac.head(), this.controller.signal);
        if (this.stopped) return {};
        if (saved && BigInt(head.counted) > BigInt(saved.body.request.until)) this.jobs.renew(item);
        else if (saved?.state !== 'submitted') return { send: true };
        else this.later(item);
      } else this.later(item, error);
    }
    return {};
  }
  async send(item) {
    if (this.stopped) return;
    if (!this.jobs.update(item, { state: 'in_progress' })) return;
    this.sendingItem = item;
    try {
      const result = await this.sender.linkBitmap({ actionId: item.action_id, height: item.block, payer: item.payer, freeOnly: true });
      if (this.stopped) return;
      const id = this.id(item) ?? result?.request?.id;
      linkCheck(typeof id === 'string' && /^[0-9a-f]{64}$/.test(id), 'link_request_id_missing', 502);
      this.jobs.update(item, { request_id: id, retry_at: this.jobs.now() + this.pollMs });
    } catch (error) {
      if (this.stopped) return;
      const saved = this.saved(item), code = errorCode(error), mapped = reason(code), id = this.id(item, saved);
      if (id) this.jobs.update(item, { request_id: id });
      // No packet was sent (or a first send was explicitly refused). Previous
      // uncertainty survives all later refusals and is resolved by polling.
      const unsent = !saved || ['prepared', 'refused'].includes(saved.state);
      if (code === 'link_job_cancelled' && unsent) this.jobs.update(item, { state: 'cancelled' });
      else if (busy(error) || retryReasons.has(code)) {
        if (unsent) this.jobs.update(item, { state: this.jobs.record(item.job).cancelled ? 'cancelled' : 'waiting' });
        this.later(item, error);
      } else if (unsent && LINK_RENEW_REFUSALS.includes(code)) this.jobs.renew(item);
      else if (unsent && (finalReasons.has(mapped) || error.status >= 400 && error.status < 500)) this.fail(item, mapped);
      else {
        if (!saved) this.jobs.update(item, { state: 'waiting' });
        this.later(item, error);
      }
    } finally { this.sendingItem = null; }
  }
  async pass() {
    if (this.jobs.delayUntil('gateway') > this.jobs.now()) return false;
    let resend;
    for (const item of this.jobs.active().filter(i => i.state === 'in_progress' && i.retry_at <= this.jobs.now())) {
      const result = await this.poll(item);
      if (this.stopped || this.jobs.delayUntil('gateway') > this.jobs.now()) return false;
      if (result.send && !resend) resend = item;
    }
    if (this.jobs.delayUntil('send') > this.jobs.now()) return false;
    if (resend) { await this.send(resend); return true; }
    const active = this.jobs.active();
    if (active.filter(i => i.state === 'in_progress').length >= this.jobs.settings.linkConcurrency) return false;
    const item = active.find(i => i.state === 'waiting' && i.retry_at <= this.jobs.now());
    if (!item) return false;
    await this.send(item); return true;
  }
  async close() {
    this.stopped = true; this.controller.abort(); this.wake?.();
    await this.task; await this.pending;
    this.journal.db.prepare('DELETE FROM link_job_worker WHERE scope=? AND instance=?').run(this.journal.scope, this.instance);
  }
}
