import { createRequire } from 'node:module';
import { check } from './util.mjs';
import { rules } from './rules.mjs';
import { same } from './deployments.mjs';
import { KeyedWork } from './keyed-work.mjs';
import { mintAssetDefinition, deploymentAssetId } from './mint-assets.mjs';
const require = createRequire(new URL('../../local/package.json', import.meta.url));
const btc = require('@scure/btc-signer');

// An inscription a player's wallet has broadcast and Bitcoin has not confirmed yet: a deploy, a mint, or the TAP
// transfer (token-auth redeem) that pays a mint's or a Bitmap link's fees. Display only:
// nothing here moves a deployment, a payment, a permit or a mint. The normal indexing and registration
// path stays the only way a state advances; a record simply stops showing once the state has moved on.
export const INFLIGHT_DEFAULTS = Object.freeze({ requestBytes: 1024, recheckMs: 10000, concurrency: 2, capacity: 16, contentBytes: 400000 });
export const INFLIGHT_PHASES = Object.freeze({ deployment: ['element', 'deployment'], ticker: ['deployment'], mint: ['mint', 'payment'], link: ['payment'] });
const TXID = /^[0-9a-f]{64}$/, REQUEST = /^[0-9a-f]{64}$/;
const KEYS = ['kind', 'ref', 'phase', 'attempt', 'commitTxid', 'revealTxid', 'inscriptionId'];

// The ord envelope of a script-path reveal: OP_FALSE OP_IF "ord" <tags> OP_0 <body…> OP_ENDIF.
// Returns the first envelope's body as text, or null when the input carries none.
export function revealText(hex, contentBytes = INFLIGHT_DEFAULTS.contentBytes) {
  let tx;
  try { tx = btc.Transaction.fromRaw(Buffer.from(hex, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true }); }
  catch { return null; }
  const input = tx.getInput(0), witness = input.finalScriptWitness ?? [];
  // A taproot script spend: [..., script, control block], with an optional annex (0x50…) last.
  const items = witness.length >= 2 && witness.at(-1)[0] === 0x50 ? witness.slice(0, -1) : witness;
  if (items.length < 2) return null;
  let ops; try { ops = btc.Script.decode(items.at(-2)); } catch { return null; }
  const bytes = op => op instanceof Uint8Array ? op : Number.isInteger(op) && op >= 1 && op <= 16 ? Uint8Array.of(op) : null;
  for (let i = 0; i + 2 < ops.length; i++) {
    if (ops[i] !== 0 || ops[i + 1] !== 'IF' || !(ops[i + 2] instanceof Uint8Array) || Buffer.from(ops[i + 2]).toString('latin1') !== 'ord') continue;
    let j = i + 3;
    // Tag/value pairs until the body separator OP_0.
    while (j < ops.length && ops[j] !== 0 && ops[j] !== 'ENDIF') j += 2;
    if (ops[j] !== 0) return null;
    const chunks = []; let size = 0;
    for (j++; j < ops.length && ops[j] !== 'ENDIF'; j++) {
      const chunk = bytes(ops[j]); if (!chunk) return null;
      size += chunk.length; if (size > contentBytes) return null; chunks.push(chunk);
    }
    if (ops[j] !== 'ENDIF') return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { return null; }
  }
  return null;
}
export function revealCommit(hex) {
  try { return Buffer.from(btc.Transaction.fromRaw(Buffer.from(hex, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true }).getInput(0).txid).toString('hex'); }
  catch { return null; }
}
const text = value => typeof value === 'string' ? value : JSON.stringify(value);

export class Inflight {
  // bitcoin: { transaction(txid) → raw hex | null, confirmations(inscriptionId) → integer | null }, point reads only.
  constructor({ store, provisioner, mints, links, bitcoin, settings = {}, now = Date.now }) {
    this.settings = { ...INFLIGHT_DEFAULTS, ...settings };
    for (const key of Object.keys(INFLIGHT_DEFAULTS)) check(Number.isSafeInteger(this.settings[key]) && this.settings[key] > 0, 'inflight_settings');
    Object.assign(this, { store, provisioner, mints, links, bitcoin, now });
    this.work = new KeyedWork({ concurrency: this.settings.concurrency, capacity: this.settings.capacity });
  }
  static key({ kind, ref, phase }) { return `${kind}/${ref}/${phase}`; }
  // The text the gateway itself expects for this kind/ref/phase/attempt, or an error when that phase is not waiting.
  async expected({ kind, ref, phase, attempt }) {
    if (kind === 'deployment') {
      check(deploymentAssetId(ref), 'deployment_asset');
      let job = this.store.get('provisioning', ref);
      if (!job) job = this.store.get('provisioning', (await mintAssetDefinition(this.store, ref)).asset);
      check(job, 'deployment_not_found', 404);
      const current = job.phase === 'element' ? job.elementAttempt : job.tickerAttempt;
      const item = job.attempts?.find(a => a.phase === phase && a.attempt === attempt);
      check(job.state === 'awaiting_player_deploy' && job.phase === phase && current === attempt && item && !item.inscription, 'inflight_not_waiting', 409);
      return { asset: job.asset, text: text(job.inscriptionText ?? item.text), alt: item.text };
    }
    if (kind === 'ticker') {
      check(REQUEST.test(ref) && attempt === 0, 'inflight_ref');
      const job = this.store.get('tickerProvisioning', ref);
      check(job, 'deployment_not_found', 404);
      check(job.state === 'awaiting_player_deploy', 'inflight_not_waiting', 409);
      return { asset: ref, text: text(job.inscriptionText ?? job.content), alt: job.content };
    }
    check(['mint', 'link'].includes(kind) && REQUEST.test(ref) && attempt === 0, 'inflight_ref');
    if (phase === 'payment') {
      // A TAP fee payment: the request still waits for exactly the fee items its redeem must carry.
      const status = kind === 'mint' ? await this.mints?.public(ref) : this.links?.financialVersion === 2 ? await this.links.public(ref) : null;
      check(status?.requestId === ref, 'request_not_found', 404);
      check(paymentWaits(status), 'inflight_not_waiting', 409);
      return { asset: ref, fees: status.missing, progress: paymentProgress(status) };
    }
    const status = await this.mints?.public(ref);
    check(status?.requestId === ref, 'request_not_found', 404);
    check(status.state === 'permit_issued' && status.mintContent !== undefined, 'inflight_not_waiting', 409);
    return { asset: ref, text: text(status.mintContent), alt: status.mintContent };
  }
  async report(input) {
    check(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(k => KEYS.includes(k)), 'inflight_payload');
    const { kind, ref, phase, attempt = 0 } = input;
    check(Object.hasOwn(INFLIGHT_PHASES, kind) && INFLIGHT_PHASES[kind].includes(phase) && typeof ref === 'string' && ref.length <= 80, 'inflight_payload');
    check(Number.isSafeInteger(attempt) && attempt >= 0 && attempt <= 1000000, 'inflight_payload');
    const revealTxid = input.revealTxid ?? input.inscriptionId?.slice(0, 64);
    // DMW's wallet flows put the one inscription of a reveal in its first input.
    check(TXID.test(revealTxid ?? '') && (input.inscriptionId ?? revealTxid + 'i0') === revealTxid + 'i0', 'inflight_payload');
    check(input.commitTxid === undefined || TXID.test(input.commitTxid), 'inflight_payload');
    return this.work.run(Inflight.key({ kind, ref, phase }), async () => {
      const expected = await this.expected({ kind, ref, phase, attempt });
      // A deployment is kept under its job's asset, whichever catalog or legacy id the page used.
      const key = Inflight.key({ kind, ref: expected.asset, phase }), known = this.store.get('inflight', key);
      if (known && known.attempt === attempt && known.revealTxid === revealTxid && known.progress === expected.progress && this.now() - known.checkedAt < this.settings.recheckMs) return { inflight: view(known) };
      const hex = await this.bitcoin.transaction(revealTxid);
      check(typeof hex === 'string', 'inflight_transaction_unknown', 404);
      const content = revealText(hex, this.settings.contentBytes);
      check(content !== null && (expected.fees ? matchesPayment(content, expected.fees) : content === expected.text || matchesJSON(content, expected.alt)), 'inflight_content');
      const commitTxid = revealCommit(hex);
      check(input.commitTxid === undefined || input.commitTxid === commitTxid, 'inflight_commit');
      const confirmations = await this.bitcoin.confirmations(revealTxid + 'i0').catch(() => null);
      const row = { kind, ref: expected.asset, phase, attempt, commitTxid, revealTxid, inscriptionId: revealTxid + 'i0',
        seenAt: known?.revealTxid === revealTxid && known.attempt === attempt ? known.seenAt : this.now(), checkedAt: this.now(),
        confirmations: Number.isSafeInteger(confirmations) && confirmations > 0 ? confirmations : null,
        ...(expected.progress ? { progress: expected.progress } : {}) };
      // One record per kind/ref/phase: the latest accepted attempt replaces an earlier one.
      await this.store.put('inflight', key, row);
      return { inflight: view(row) };
    }, { join: true });
  }
  // The public projection: present only while the same phase/attempt still waits for its inscription.
  decorate(kind, result) {
    if (!result || typeof result !== 'object') return result;
    const row = this.current(kind, result);
    return row ? { ...result, inflight: view(row) } : result;
  }
  current(kind, result) {
    if (kind === 'deployment') {
      if (result.state !== 'awaiting_player_deploy' || !['element', 'deployment'].includes(result.phase)) return null;
      const row = this.store.get('inflight', Inflight.key({ kind, ref: result.asset, phase: result.phase }))
        ?? (result.catalogAsset && result.catalogAsset !== result.asset ? this.store.get('inflight', Inflight.key({ kind, ref: result.catalogAsset, phase: result.phase })) : null);
      const attempt = result.phase === 'element' ? result.elementAttempt : result.tickerAttempt;
      const item = result.attempts?.find(a => a.phase === result.phase && a.attempt === attempt);
      return row && row.attempt === attempt && item && !item.inscription ? row : null;
    }
    if (kind === 'ticker') return result.state === 'awaiting_player_deploy' && REQUEST.test(result.id ?? '') ? this.store.get('inflight', Inflight.key({ kind, ref: result.id, phase: 'deployment' })) : null;
    if (!REQUEST.test(result.requestId ?? '')) return null;
    // A payment shows until the request's funding moves (the payment, or any other, is counted) or it stops waiting.
    if (paymentWaits(result)) {
      const row = this.store.get('inflight', Inflight.key({ kind, ref: result.requestId, phase: 'payment' }));
      return row?.progress === paymentProgress(result) ? row : null;
    }
    return kind === 'mint' && result.state === 'permit_issued' ? this.store.get('inflight', Inflight.key({ kind, ref: result.requestId, phase: 'mint' })) : null;
  }
}
const view = row => ({ phase: row.phase, commitTxid: row.commitTxid, revealTxid: row.revealTxid, inscriptionId: row.inscriptionId, seenAt: row.seenAt, confirmations: row.confirmations });
// A request waits for a TAP payment while fee items remain; a free link (price 0) has none, so nothing is in flight.
const paymentWaits = status => ['awaiting_payment', 'partly_paid'].includes(status?.state) && (status.payBy?.rail ?? status.kind) === 'tap' &&
  status.price !== '0' && Array.isArray(status.missing) && status.missing.length > 0 && !status.payment?.length;
const paymentProgress = status => rules.stableJSON({ paid: status.funding?.paid ?? null, missing: status.missing.map(fee => [fee.dta ?? null, fee.amount]) });
// TAP Wallet's one-transaction transfer is a token-auth redeem. It pays this request when every item is one of the
// request's own remaining fee items (recipient, ticker and request-bound data), each once, for no more than is due.
export function matchesPayment(content, fees) {
  let payload; try { payload = JSON.parse(content); } catch { return false; }
  const items = payload?.p === 'tap' && payload.op === 'token-auth' && Array.isArray(payload.redeem?.items) ? payload.redeem.items : null;
  if (!items?.length || items.length > fees.length) return false;
  const used = new Set();
  return items.every(item => {
    const index = fees.findIndex((fee, i) => !used.has(i) && fee.tt === 'a' && typeof fee.dta === 'string' && fee.dta === item?.dta && fee.to === item.address && fee.ticker === item.tick);
    if (index < 0) return false;
    used.add(index);
    let amount; try { amount = BigInt(rules.parseTapAmount(item.amt)); } catch { return false; }
    return amount > 0n && amount <= BigInt(fees[index].amount);
  });
}
function matchesJSON(content, expected) {
  if (!expected || typeof expected !== 'object') return false;
  try { return same(JSON.parse(content), expected); } catch { return false; }
}

// The gateway's existing ord source: the reveal by txid (bytes re-hashed to the txid by the client) and, when ord
// has indexed the inscription, its height against the tip. ord does not serve unconfirmed transactions, so an
// optional mempool reader (one point read by txid) fills in; its bytes are re-hashed to the txid as well.
export function ordInflightReads(client, { mempoolTransaction = null } = {}) {
  const missing = error => error?.status === 404 || error?.details?.status === 404;
  return {
    async transaction(txid) {
      try { return (await client.transaction(txid)).hex; } catch (error) { if (!missing(error)) throw error; }
      const hex = mempoolTransaction ? await mempoolTransaction(txid) : null;
      if (typeof hex !== 'string' || !/^[0-9a-f]+$/.test(hex) || hex.length > 800000) return null;
      return client.decode(hex).txid === txid ? hex : null;
    },
    async confirmations(id) {
      let inscription;
      try { inscription = await client.source.request('/inscription/' + id); } catch (error) { if (missing(error)) return null; throw error; }
      if (inscription?.id !== id || !Number.isSafeInteger(Number(inscription.height))) return null;
      const tip = Number(await client.source.request('/r/blockheight'));
      return Number.isSafeInteger(tip) && tip >= Number(inscription.height) ? tip - Number(inscription.height) + 1 : null;
    },
  };
}
