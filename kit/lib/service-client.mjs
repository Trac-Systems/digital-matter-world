import { validateTracAddress, publicIdentities } from '../../rules/src/trac-address.js';
import { stableJSON, decodeBinary, verifyReceiptRoot, verifyReceipt, verifyRootAttestations, verifyMerkle, moveId as legacyMoveId, moveIdV2, claimWindow } from '../../rules/src/index.js';
import { check, gatewayOrigin, hex32, integer, sha256 } from './check.mjs';
import { presentRead, readQuery, publicRoute } from './reads.mjs';
import { serviceError, safeCode, isMoveRefusal } from './errors.mjs';
import { verifyReceiptV2 } from '../../rules/src/receipt-v2.js';
import { financialAsset } from '../../rules/src/financial-mint.js';
import { verifyRenewedAudit } from './receipt-renewal.mjs';
import { KIT_UPGRADE_CODE } from '../../rules/src/kit-release.js';
import { readInteger, nextCursor } from './api-values.mjs';
import timers from 'node:timers/promises';
const GATEWAY_BUSY = new Set(['request_pending', 'service_busy', 'http_capacity', 'resource_busy', 'financial_snapshot_changed', 'read_snapshot_changed', 'read_not_ready']);
const BATCH_FULL = new Set(['next_batch_work_capacity', 'next_batch_byte_capacity', 'next_batch_account_capacity', 'closure_backlog_capacity']);
const moveId = move => move.v === 2 ? moveIdV2(move) : legacyMoveId(move);
const deploymentAsset = asset => typeof asset === 'string' && /^(?:[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/.test(asset);

async function requestOnce(client, path, { value, body, limit, binary, query, retry, signal }) {
  signal?.throwIfAborted();
  check(typeof path === 'string' && /^\/[a-zA-Z0-9/_.:-]+$/.test(path) && !path.includes('..') && !path.includes('//'), 'Invalid service path');
  const search = query ? new URLSearchParams(query).toString() : '';
  const method = value === undefined ? 'GET' : 'POST';
  const mutation = method === 'POST' && (path === '/mint/quote' && !!value?.request || ['/mint/bulk/request', '/mint/bulk/payment', '/mint/bulk/finish', '/moves', '/link/request', '/payout-bindings/request', '/payout-bindings/complete', '/mint/payment', '/mint/deployment', '/mint/deployment-ticker', '/mint/deploy-ticker', '/mint/ticker-payment', '/link/payment'].includes(path));
  const failure = (code, reason, status, submission = false) => serviceError({ service: 'Gateway service', origin: client.origin, route: path, method, status, code, reason, submission });
  let response;
  for (let attempt = 0; ; attempt++) try {
    response = await client.fetchImpl(client.origin + path + (search ? '?' + search : ''), { method: value === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: value === undefined ? { accept: binary ? 'application/octet-stream' : 'application/json' } : { 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(client.timeoutMs)]) : AbortSignal.timeout(client.timeoutMs) });
    break;
  } catch (error) {
    const code = error.cause?.code ?? error.code ?? error.name;
    // An idle keep-alive socket can close just as the next read begins.
    // Only retry a GET that failed before receiving an HTTP response.
    if (retry && method === 'GET' && attempt === 0 && ['ECONNRESET', 'UND_ERR_SOCKET'].includes(code)) continue;
    throw failure(safeCode(code), 'service unavailable or request blocked before an HTTP response', undefined, mutation);
  }
  if (response.headers.get('content-length') && Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw failure('response_limit', 'response too large', response.status, mutation);
  }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error(), { code: 'response_limit' });
      chunks.push(chunk);
    }
  } catch (error) { throw failure(safeCode(error.code ?? error.cause?.code), error.code === 'response_limit' ? 'response too large' : 'response body interrupted', response.status, mutation); }
  const bytes = Buffer.concat(chunks);
  if (!response.ok) {
    let code; try { const body = JSON.parse(bytes); code = body.code ?? body.error; } catch {}
    if (code === KIT_UPGRADE_CODE) code = 'upgrade_required';
    const refusedBeforeAcceptance = method === 'POST' && path === '/moves' && isMoveRefusal(response.status, code);
    const hint = response.headers.get('retry-after'), seconds = /^\d+$/.test(hint ?? '') ? Number(hint) : NaN;
    const delay = Number.isNaN(seconds) && /^[A-Za-z]{3}, /.test(hint ?? '') ? Math.max(0, Date.parse(hint) - Date.now()) : seconds * 1000;
    const retryAfterMs = Number.isSafeInteger(delay) && delay >= 0 && delay <= 2147483000 ? delay : undefined;
    throw Object.assign(failure(safeCode(code, 'http_error'), 'request refused', response.status, mutation && !refusedBeforeAcceptance),
      { refusedBeforeAcceptance, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }
  if (binary) return bytes;
  try { return JSON.parse(bytes); }
  catch { throw failure('invalid_json', 'response is not valid JSON', response.status, mutation); }
}

// All gateway HTTP routes live here. No private key or wallet enters this client.
export class ServiceClient {
  constructor({ origin = 'http://127.0.0.1:5570', mode = 'regtest', network, gateway, receiptSigners, fetchImpl = fetch, timeoutMs = 10000, busyRetries = 30,
    batchWaitMs = 300000, onBatchWait = () => {} } = {}) {
    check(['regtest', 'mainnet'].includes(mode), 'Client network mode');
    check(Number.isSafeInteger(batchWaitMs) && batchWaitMs >= 0 && typeof onBatchWait === 'function', 'Invalid batch wait options');
    this.origin = gatewayOrigin(origin, mode); Object.assign(this, { network, mode, gateway, fetchImpl, timeoutMs, busyRetries, batchWaitMs, onBatchWait });
    if (receiptSigners !== undefined) {
      check(Array.isArray(receiptSigners) && receiptSigners.length === 5 && receiptSigners.every(m => typeof m.id === 'string' && m.id.length > 0 && hex32(m.identity)) &&
        new Set(receiptSigners.map(m => m.id)).size === 5 && new Set(receiptSigners.map(m => m.identity)).size === 5, 'Pin five distinct receipt signers');
    }
    Object.defineProperty(this, 'receiptSigners', { value: receiptSigners && Object.freeze(receiptSigners.map(m => Object.freeze({ id: m.id, identity: m.identity }))) });
  }
  async request(path, { value, limit = 60000, binary = false, query, busyRetries = 0, retry = true, signal } = {}) {
    // Serialize once: a refused move keeps the exact signed packet throughout the wait.
    const body = value === undefined ? undefined : stableJSON(value);
    let batchWaitedMs = 0;
    for (;;) {
      try { return await requestOnce(this, path, { value, body, limit, binary, query, retry, signal }); }
      catch (error) {
        if (retry && value !== undefined && path === '/moves' && error.status === 429 && BATCH_FULL.has(error.code) && error.refusedBeforeAcceptance) {
          const waitMs = Math.max(2000, Math.min(error.retryAfterMs ?? 2000, 30000));
          if (signal?.aborted || waitMs > this.batchWaitMs - batchWaitedMs) throw error;
          this.onBatchWait({ code: error.code, waitMs });
          // Cancellation between sends retains the definite refusal. A failed resend
          // instead leaves its own unknown outcome untouched.
          try { await timers.setTimeout(waitMs, undefined, { signal }); } catch { throw error; }
          if (signal?.aborted) throw error;
          batchWaitedMs += waitMs;
          continue;
        }
        // A busy answer while a batch is signed is retried as before, also during a batch wait.
        if (retry && error.status !== 429 && error.refusedBeforeAcceptance !== undefined &&
          (error.status === 503 && GATEWAY_BUSY.has(error.code) || error.code === 'trac_snapshot_changed') && busyRetries < this.busyRetries) {
          await timers.setTimeout(Math.min(error.retryAfterMs ?? 2000, 10000));
          busyRetries++;
          continue;
        }
        throw error;
      }
    }
  }
  health() { return this.request('/health'); }
  accountProof(owner, asset, limit) {
    check(hex32(owner) && financialAsset(asset) && integer(limit), 'Invalid account proof read');
    return this.request(`/account-proof/${owner}/${asset}`, { limit });
  }
  craftPreview(value, limit) { return this.request('/craft-preview', { value, limit }); }
  compoundProof(asset, kind, limit) {
    check(/^c2:[0-9a-f]{64}$/.test(asset) && ['assets', 'tiers', 'maker'].includes(kind), 'Invalid compound read');
    return this.request(`/named-record/compound/${kind}/${asset}`, { limit });
  }
  namedCommitmentProof(agent, commitment, limit) {
    check(hex32(agent) && hex32(commitment) && integer(limit), 'Invalid named commitment read');
    return this.request(`/named-record/commit/${agent}/${commitment}`, { limit });
  }
  payoutBinding(owner, rail, { history = false, ...query } = {}) {
    validateTracAddress(owner); check(['tap', 'ethereum'].includes(rail), 'Invalid payout binding');
    return this.request(`/payout-bindings/${owner}/${rail}${history ? '/history' : ''}`, { query, limit: 1000000 }).then(publicIdentities);
  }
  requestPayoutBinding(value) { return this.request('/payout-bindings/request', { value }); }
  latest() { return this.request('/latest.json'); }
  takenSlotsPage(query = {}) {
    check(Object.entries(query).every(([k, v]) => ['since', 'cursor'].includes(k) && typeof v === 'string' && v.length <= 8192) &&
      !(query.since && query.cursor), 'Invalid taken query');
    // The mining pass owns a strict request budget, including retries.
    return this.request('/patterns/taken', { query, retry: false });
  }
  async renewalProof(id, observation, { batchRoot, settingsByHash, renewalSlice, limit = 1500000 } = {}) {
    check(hex32(id) && /^(0|[1-9][0-9]*)$/.test(String(observation)) &&
      typeof batchRoot === 'function' && typeof settingsByHash === 'function', 'Independent renewal reads required');
    const descriptor = await this.request(`/receipt-renewals/${id}/${observation}`);
    return { ...await this.publication(descriptor, { limit }), batchRoot, settingsByHash, renewalSlice };
  }
  async readPage(route, options = {}) {
    const { path, query } = publicRoute(route);
    for (const [key, value] of Object.entries(readQuery(options))) query[key] = value;
    publicRoute(path + '?' + new URLSearchParams(query));
    return presentRead(await this.request(path, { query, limit: 2000000 }), { route: query.source ?? path, contextPath: query.path, asset: query.asset });
  }
  publicStatus(options) { return this.readPage('/status', options); }
  blocks(options) { return this.readPage('/blocks', options); }
  patterns(options) { return this.readPage('/patterns', options); }
  compounds(options) { return this.readPage('/compounds', options); }
  finds(options) { return this.readPage('/finds', options); }
  receipts(options) { return this.readPage('/receipts', options); }
  block(height, { collection, ...options } = {}) {
    height = readInteger(height);
    check(collection === undefined || ['matches', 'slotList', 'claims', 'draws', 'finds', 'mintRights'].includes(collection), 'Invalid block collection');
    return this.readPage(`/blocks/${height}${collection ? '/' + collection : ''}`, options);
  }
  mintRights(owner, options = {}) { validateTracAddress(owner); return this.readPage(`/agents/${owner}/mintRights`, options); }
  events(options = {}) { return this.readPage('/events', { order: 'asc', ...options }); }
  event(sequence) { check(integer(sequence) || typeof sequence === 'string' && /^(0|[1-9][0-9]*)$/.test(sequence), 'Invalid event sequence'); return this.readPage(`/events/${sequence}`); }
  results({ collection, ...options } = {}) {
    check(collection === undefined || ['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links', 'credits', 'custody', 'linkRequests', 'supply'].includes(collection), 'Invalid result collection');
    return this.readPage('/results' + (collection ? '/' + collection : ''), options);
  }
  agents(options) { return this.readPage('/agents', options); }
  profile(owner, { collection, ...options } = {}) {
    validateTracAddress(owner);
    check(collection === undefined || ['balances', 'bitmaps', 'finds', 'mintRights', 'discoveries', 'history', 'assets'].includes(collection), 'Invalid profile collection');
    return this.readPage(`/agents/${owner}${collection ? '/' + collection : ''}`, options);
  }
  claimedBlocks(asset, options = {}) {
    check(/^p2:(0|[1-9][0-9]*)$/.test(asset), 'Invalid submitted-block asset');
    check(options.limit === undefined || integer(options.limit) && options.limit >= 1 && options.limit <= 50, 'Claimed-block limit must be between 1 and 50');
    return this.readPage(`/patterns/${asset}/claimed-blocks`, { limit: 50, ...options });
  }
  submitBitmap({ block, inscription }) {
    check(integer(block) || typeof block === 'string' && /^(0|[1-9][0-9]*)$/.test(block), 'Invalid bitmap block');
    check(inscription === undefined || /^[0-9a-f]{64}i(0|[1-9][0-9]*)$/.test(inscription), 'Invalid bitmap inscription');
    return this.request('/bitmaps/submit', { value: { block: String(block), ...(inscription ? { inscription } : {}) } });
  }
  async mintQuote(value) {
    check(value && financialAsset(value.asset) && (value.block === undefined || integer(value.block) || typeof value.block === 'string' && /^(0|[1-9][0-9]*)$/.test(value.block)) &&
      (value.amount === undefined || typeof value.amount === 'string' && /^[1-9][0-9]{0,77}$/.test(value.amount)) &&
      (value.kind === undefined || ['tap', 'ethereum'].includes(value.kind)) &&
      (value.deployment === undefined || typeof value.deployment === 'string' && value.deployment.length > 0) &&
      [value.payer, value.receiver].every(x => x === undefined || typeof x === 'string' && x.length > 0 && x.length <= 128) &&
      Object.keys(value).every(k => ['asset', 'block', 'amount', 'kind', 'payer', 'receiver', 'deployment'].includes(k)), 'Invalid quote');
    const result = await this.quote(value);
    if (result.deploymentNeeded) {
      result.deploymentLink = this.deploymentLink(result.catalogAsset ?? result.asset ?? value.asset);
      result.next = [{ tool: 'inscribe_deployment', arguments: { asset: result.asset ?? value.asset } }];
    }
    return presentRead(result, { route: '/mint/quote', asset: value.asset });
  }
  async publication(descriptor, { binary = false, limit = 1000000 } = {}) {
    check(descriptor && hex32(descriptor.hash) && integer(descriptor.bytes) && descriptor.bytes <= limit, 'Invalid publication descriptor');
    const bytes = await this.request(descriptor.path, { binary: true, limit });
    check(bytes.length === descriptor.bytes && sha256(bytes) === descriptor.hash, 'Publication hash mismatch');
    return binary ? bytes : JSON.parse(bytes);
  }
  async audit(publication, { hashAt, commitment, renewal } = {}) {
    const bytes = await this.publication(publication.audit, { binary: true, limit: 1500000 }), file = decodeBinary(bytes);
    check(String(file.height) === String(publication.height) && file.receiptRoot.network === this.network &&
      (publication.observation === undefined || String(file.observation) === String(publication.observation)), 'Foreign audit file');
    if (commitment) check(verifyMerkle(bytes, commitment.proof, commitment.root), 'Audit does not match contract batch root');
    if (file.renewal && renewal && !renewal.reservationBatch) renewal = await this.renewalProof(file.renewal, file.observation, renewal);
    const renewed = file.renewal ? await verifyRenewedAudit(file, bytes, renewal ?? {},
      { network: this.network, gateway: this.gateway, members: this.receiptSigners }) : null;
    check(hex32(this.gateway) && typeof hashAt === 'function', 'Pinned gateway and verified header hashes required');
    const tipHash = await hashAt(readInteger(file.tip));
    check(tipHash === file.tipHash, 'Audit tip differs from verified chain');
    // Empty repeated observations prove no inclusion; their receiptReference
    // points callers back to the original witnessed observation.
    check(verifyReceiptRoot(file.receiptRoot, file.receipts, { network: this.network, gateway: this.gateway, tip: file.tip, hash: file.tipHash }), 'Invalid receipt root');
    const witnessed = file.receipts.length > 0;
    if (witnessed || file.rootAttestations?.length) check(verifyRootAttestations(file.receiptRoot, file.rootAttestations, this.receiptSigners), 'Invalid receipt signer quorum');
    const receipts = new Map(file.receipts.map(r => [r.move, r]));
    check(receipts.size === file.receipts.length && file.moves.length === receipts.size && new Set(file.moves.map(r => moveId(r.move))).size === receipts.size, 'Audit move/receipt mismatch');
    for (const { move } of file.moves) {
      const receipt = receipts.get(moveId(move));
      check(receipt.tip === file.tip && receipt.hash === file.tipHash && (move.v === 2 ? verifyReceiptV2 : verifyReceipt)(receipt, move, {
        network: this.network, gateway: this.gateway, hashAt: h => h === file.tip ? tipHash : null,
        ...(move.v === 2 ? { batch: file.batchSequence, renewal: renewed?.renewal } : {}) }), 'Invalid audit receipt');
      check(!['claim', 'claim-v2'].includes(move.t) || claimWindow(readInteger(move.p.window), readInteger(receipt.tip)), 'Claim receipt outside window');
    }
    return { file, witnessed, contractCommitted: !!commitment || !!renewed };
  }
  async inclusion(move, { publication, receipt, hashAt, commitment, renewal } = {}) {
    if (!publication) publication = await this.receiptPublication(move, receipt);
    const audit = await this.audit(publication, { hashAt, commitment, renewal });
    const included = audit.file.receipts.find(r => r.move === moveId(move));
    check(audit.witnessed && included && (!receipt || stableJSON(receipt) === stableJSON(included)), 'Receipt missing from witnessed observation. Wait for publication, or pass the saved claim’s provenance from block collection claims as publication {height,observation,audit}. Height is the audit counted height, not the receipt tip; for a discovery use receipts at the commitment receipt tip.');
    return { verified: true, inclusion: 'witnessed', publication: { height: audit.file.height, observation: audit.file.observation, audit: publication.audit },
      note: 'Verified receipt inclusion with pinned witnesses; reportedOutcome is the audit’s game result. contractCommitted requires a supplied batch Merkle proof. Inclusion alone does not prove a settled win.',
      receipt: included, seal: audit.file.receiptRoot, attestations: audit.file.rootAttestations, contractCommitted: audit.contractCommitted,
      reportedOutcome: audit.file.moves.find(entry => moveId(entry.move) === included.move).reason };
  }
  async receiptPublication(move, receipt) {
    const height = readInteger(move.b), heights = receipt ? [readInteger(receipt.tip)] : [height, height + 1, height + 2], id = moveId(move);
    // Activated receipt collections do not accept the legacy height filter.
    // Traverse their bounded pages and inspect only matching seal tips/hashes.
    for (const height of move.v === 2 ? [null] : heights) {
      let cursor; const seen = new Set();
      do {
        const page = await this.receipts({ ...(height === null ? {} : { height }), limit: 50, sort: 'id', order: move.v === 2 ? 'desc' : 'asc', cursor });
        const next = nextCursor(page);
        check(Array.isArray(page.receipts) && (next === null || !seen.has(next)), 'Invalid receipt page');
        for (const row of page.receipts) {
          if (!row.archive || receipt && row.seal?.hash !== receipt.hash) continue;
          if (move.v === 2 && (!row.seal || !heights.includes(readInteger(row.seal.tip)))) continue;
          const file = decodeBinary(await this.publication(row.archive, { binary: true, limit: 1500000 }));
          if (file.receipts.some(r => r.move === id)) return { height: file.height, observation: file.observation, audit: row.archive };
        }
        cursor = next; seen.add(cursor);
      } while (cursor !== null);
    }
    return this.latest();
  }
  async submit(move, { hashAt, signal } = {}) {
    check(move.network === this.network && hex32(this.gateway) && typeof hashAt === 'function', 'Pinned gateway and chain required');
    const receipt = await this.request('/moves', { value: move, signal });
    const expected = await hashAt(readInteger(receipt.tip));
    check((move.v === 2 ? verifyReceiptV2 : verifyReceipt)(receipt, move, { network: this.network, gateway: this.gateway, hashAt: h => h === receipt.tip ? expected : null }), 'Invalid gateway receipt; submission outcome unknown');
    return receipt;
  }
  async bulkMintQuote(input) {
    const { BULK_LIMITS, validateBulkQuoteInput } = await import('../../rules/src/bulk-mint.js');
    validateBulkQuoteInput(input);
    return this.request('/mint/bulk/quote', { value: input, limit: BULK_LIMITS.quoteBytes });
  }
  async requestBulkMint(body) {
    const { BULK_LIMITS } = await import('../../rules/src/bulk-mint.js');
    check(Buffer.byteLength(stableJSON(body)) <= BULK_LIMITS.requestBytes, 'Bulk request byte limit');
    return this.request('/mint/bulk/request', { value: body });
  }
  bulkMintStatus(id) { check(hex32(id), 'Invalid bulk order ID'); return this.request('/mint/bulk/' + id); }
  async bulkMintTerms(id) {
    check(hex32(id), 'Invalid bulk order ID');
    const { BULK_LIMITS } = await import('../../rules/src/bulk-mint.js');
    return this.request('/mint/bulk/' + id + '/terms', { limit: BULK_LIMITS.requestBytes });
  }
  bulkMintMembers(id, { offset = 0, limit = 64 } = {}) { return this.bulkMintPage(id, 'members', offset, limit); }
  bulkMintPermit(id, { offset = 0, limit = 16 } = {}) { return this.bulkMintPage(id, 'permit', offset, limit); }
  async bulkMintPage(id, kind, offset, limit) {
    check(hex32(id), 'Invalid bulk order ID');
    const { BULK_LIMITS } = await import('../../rules/src/bulk-mint.js');
    check(Number.isSafeInteger(offset) && offset >= 0 && offset < BULK_LIMITS.members && Number.isSafeInteger(limit) && limit >= 1 &&
      limit <= (kind === 'permit' ? BULK_LIMITS.permitPage : BULK_LIMITS.members), 'Invalid bulk page');
    return this.request('/mint/bulk/' + id + '/' + kind, { query: { offset, limit }, limit: BULK_LIMITS.permitBytes });
  }
  reportBulkPayment(report) { return this.request('/mint/bulk/payment', { value: report }); }
  reportBulkFinish(report) { return this.request('/mint/bulk/finish', { value: report }); }
  quote(value) { return this.request('/mint/quote', { value }); }
  requestMint(value) { return this.request('/mint/quote', { value }); }
  mintStatus(id) { check(hex32(id), 'Invalid mint ID'); return this.request('/mint/' + id); }
  mintPaymentPlan(id) { check(hex32(id), 'Invalid mint ID'); return this.request('/web-api/mint/' + id); }
  reportMintPayment(value) { return this.request('/mint/payment', { value }); }
  // A broadcast the gateway checks on Bitcoin and shows as sent until it confirms (display only).
  reportInflight(value) { return this.request('/mint/inflight', { value }); }
  deployment(asset) { check(deploymentAsset(asset), 'Invalid deployment asset'); return this.request('/mint/deployment/' + asset, { limit: 1500000 }); }
  assetTickers(asset, { after, limit } = {}) { check(deploymentAsset(asset), 'Invalid deployment asset'); return this.request('/assets/' + asset + '/tickers', { query: { ...(after ? { after } : {}), ...(limit ? { limit: String(limit) } : {}) } }); }
  tickerPayment(value) { return this.request('/mint/ticker-payment', { value }); }
  deployTicker(value) { return this.request('/mint/deploy-ticker', { value }); }
  chooseCompoundTicker(value) { return this.request('/mint/deployment-ticker', { value }); }
  tickerState(asset, selector) { check(deploymentAsset(asset), 'Invalid deployment asset'); return this.request('/mint/ticker-state/' + asset, { query: { selector } }); }
  deploymentState(asset) { check(deploymentAsset(asset), 'Invalid deployment asset'); return this.request('/mint/deployment-state/' + asset, { limit: 1500000 }); }
  deploymentLink(asset, owner, origin = this.origin) {
    check(deploymentAsset(asset), 'Invalid deployment asset');
    if (owner) validateTracAddress(owner);
    return `${gatewayOrigin(origin, this.mode)}/mint/${asset}${owner ? '?owner=' + encodeURIComponent(owner) : ''}`;
  }
  submitDeployment(value) { return this.request('/mint/deployment', { value }); }
  linkQuote(value) { return this.request('/link/quote', { value }); }
  linkStatus(id) { check(hex32(id), 'Invalid link ID'); return this.request('/link-status/' + id); }
  reportLinkPayment(value) { return this.request('/link/payment', { value }); }
  requestLink(value) { return this.request('/link/request', { value }); }
  financialAction(value) { return this.request('/financial/action', { value }); }
  financialActionStatus(id) { check(hex32(id), 'Invalid financial action ID'); return this.request('/financial/action/' + id); }
  custodyStatus(id) { check(hex32(id), 'Invalid custody ID'); return this.request('/financial/custody/' + id); }
  reportCustodyPayment(value) { return this.request('/financial/custody/payment', { value }); }
  paymentLink(id, origin = this.origin, kind = 'mint') {
    check(hex32(id) && ['mint', 'link', 'mint/bulk'].includes(kind), 'Invalid payment request');
    return `${gatewayOrigin(origin, this.mode)}/${kind}/${id}`;
  }
}
