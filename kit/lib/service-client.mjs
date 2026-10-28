import { validateTracAddress, publicIdentities } from '../../rules/src/trac-address.js';
import { stableJSON, decodeBinary, verifyReceiptRoot, verifyReceipt, verifyRootAttestations, verifyMerkle, moveId, claimWindow } from '../../rules/src/index.js';
import { check, gatewayOrigin, hex32, integer, sha256 } from './check.mjs';
import { presentRead, readQuery, publicRoute } from './reads.mjs';
import { serviceError, safeCode, isMoveRefusal } from './errors.mjs';

// All gateway HTTP routes live here. No private key or wallet enters this client.
export class ServiceClient {
  constructor({ origin = 'http://127.0.0.1:5570', mode = 'regtest', network, gateway, receiptSigners, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    check(['regtest', 'mainnet'].includes(mode), 'Client network mode');
    this.origin = gatewayOrigin(origin, mode); Object.assign(this, { network, mode, gateway, fetchImpl, timeoutMs });
    if (receiptSigners !== undefined) {
      check(Array.isArray(receiptSigners) && receiptSigners.length === 5 && receiptSigners.every(m => typeof m.id === 'string' && m.id.length > 0 && hex32(m.identity)) &&
        new Set(receiptSigners.map(m => m.id)).size === 5 && new Set(receiptSigners.map(m => m.identity)).size === 5, 'Pin five distinct receipt signers');
    }
    Object.defineProperty(this, 'receiptSigners', { value: receiptSigners && Object.freeze(receiptSigners.map(m => Object.freeze({ id: m.id, identity: m.identity }))) });
  }
  async request(path, { value, limit = 60000, binary = false, query } = {}) {
    check(typeof path === 'string' && /^\/[a-zA-Z0-9/_.-]+$/.test(path) && !path.includes('..') && !path.includes('//'), 'Invalid service path');
    const search = query ? new URLSearchParams(query).toString() : '';
    const method = value === undefined ? 'GET' : 'POST';
    const mutation = method === 'POST' && (path === '/mint/quote' && !!value?.request || ['/moves', '/link/request', '/payout-bindings/request', '/payout-bindings/complete', '/mint/payment', '/mint/deployment'].includes(path));
    const failure = (code, reason, status, submission = false) => serviceError({ service: 'Gateway service', origin: this.origin, route: path, method, status, code, reason, submission });
    let response;
    for (let attempt = 0; ; attempt++) try {
      response = await this.fetchImpl(this.origin + path + (search ? '?' + search : ''), { method: value === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: value === undefined ? { accept: binary ? 'application/octet-stream' : 'application/json' } : { 'content-type': 'application/json' },
        ...(value === undefined ? {} : { body: stableJSON(value) }), signal: AbortSignal.timeout(this.timeoutMs) });
      break;
    } catch (error) {
      const code = error.cause?.code ?? error.code ?? error.name;
      // An idle keep-alive socket can close just as the next read begins.
      // Only retry a GET that failed before receiving an HTTP response.
      if (method === 'GET' && attempt === 0 && ['ECONNRESET', 'UND_ERR_SOCKET'].includes(code)) continue;
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
      const refusedBeforeAcceptance = method === 'POST' && path === '/moves' && isMoveRefusal(response.status, code);
      throw Object.assign(failure(safeCode(code, 'http_error'), 'request refused', response.status, mutation && !refusedBeforeAcceptance), { refusedBeforeAcceptance });
    }
    if (binary) return bytes;
    try { return JSON.parse(bytes); }
    catch { throw failure('invalid_json', 'response is not valid JSON', response.status, mutation); }
  }
  health() { return this.request('/health'); }
  payoutBinding(owner, rail, { history = false, ...query } = {}) {
    validateTracAddress(owner); check(['tap', 'ethereum'].includes(rail), 'Invalid payout binding');
    return this.request(`/payout-bindings/${owner}/${rail}${history ? '/history' : ''}`, { query, limit: 1000000 }).then(publicIdentities);
  }
  requestPayoutBinding(value) { return this.request('/payout-bindings/request', { value }); }
  latest() { return this.request('/latest.json'); }
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
    check(integer(height), 'Invalid block height');
    check(collection === undefined || ['matches', 'slotList', 'claims', 'draws', 'finds', 'mintRights'].includes(collection), 'Invalid block collection');
    return this.readPage(`/blocks/${height}${collection ? '/' + collection : ''}`, options);
  }
  mintRights(owner, options = {}) { validateTracAddress(owner); return this.readPage('/mint-rights', { ...options, owner }); }
  events(options = {}) { return this.readPage('/events', { order: 'asc', ...options }); }
  event(sequence) { check(integer(sequence), 'Invalid event sequence'); return this.readPage(`/events/${sequence}`); }
  results({ collection, ...options } = {}) {
    check(collection === undefined || ['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links'].includes(collection), 'Invalid result collection');
    return this.readPage('/results' + (collection ? '/' + collection : ''), options);
  }
  agents(options) { return this.readPage('/agents', options); }
  profile(owner, { collection, ...options } = {}) {
    validateTracAddress(owner);
    check(collection === undefined || ['balances', 'bitmaps', 'finds', 'mintRights', 'discoveries', 'history'].includes(collection), 'Invalid profile collection');
    return this.readPage(`/agents/${owner}${collection ? '/' + collection : ''}`, options);
  }
  async mintQuote(value) {
    check(value && typeof value.asset === 'string' && /^[0-9a-z]{1,24}$/.test(value.asset) && (value.block === undefined || integer(value.block)) &&
      (value.amount === undefined || typeof value.amount === 'string' && /^[1-9][0-9]{0,77}$/.test(value.amount)) &&
      (value.kind === undefined || ['tap', 'ethereum'].includes(value.kind)) &&
      Object.keys(value).every(k => ['asset', 'block', 'amount', 'kind'].includes(k)), 'Invalid quote');
    return presentRead(await this.quote(value), { route: '/mint/quote', asset: value.asset });
  }
  async publication(descriptor, { binary = false, limit = 1000000 } = {}) {
    check(descriptor && hex32(descriptor.hash) && integer(descriptor.bytes) && descriptor.bytes <= limit, 'Invalid publication descriptor');
    const bytes = await this.request(descriptor.path, { binary: true, limit });
    check(bytes.length === descriptor.bytes && sha256(bytes) === descriptor.hash, 'Publication hash mismatch');
    return binary ? bytes : JSON.parse(bytes);
  }
  async audit(publication, { hashAt, commitment } = {}) {
    const bytes = await this.publication(publication.audit, { binary: true, limit: 1500000 }), file = decodeBinary(bytes);
    check(file.height === publication.height && file.receiptRoot.network === this.network &&
      (publication.observation === undefined || file.observation === publication.observation), 'Foreign audit file');
    if (commitment) check(verifyMerkle(bytes, commitment.proof, commitment.root), 'Audit does not match contract batch root');
    check(hex32(this.gateway) && typeof hashAt === 'function', 'Pinned gateway and verified header hashes required');
    const tipHash = await hashAt(file.tip);
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
      check(receipt.tip === file.tip && receipt.hash === file.tipHash && verifyReceipt(receipt, move, { network: this.network, gateway: this.gateway, hashAt: h => h === file.tip ? tipHash : null }), 'Invalid audit receipt');
      check(move.t !== 'claim' || claimWindow(move.p.window, receipt.tip), 'Claim receipt outside window');
    }
    return { file, witnessed, contractCommitted: !!commitment };
  }
  async inclusion(move, { publication, receipt, hashAt, commitment } = {}) {
    if (!publication) publication = await this.receiptPublication(move, receipt);
    const audit = await this.audit(publication, { hashAt, commitment });
    const included = audit.file.receipts.find(r => r.move === moveId(move));
    check(audit.witnessed && included && (!receipt || stableJSON(receipt) === stableJSON(included)), 'Receipt missing from witnessed observation. Wait for publication, or pass the saved claim’s provenance from block collection claims as publication {height,observation,audit}. Height is the audit counted height, not the receipt tip; for a discovery use receipts at the commitment receipt tip.');
    return { verified: true, inclusion: 'witnessed', publication: { height: audit.file.height, observation: audit.file.observation, audit: publication.audit },
      note: 'Verified receipt inclusion with pinned witnesses; reportedOutcome is the audit’s game result. contractCommitted requires a supplied batch Merkle proof. Inclusion alone does not prove a settled win.',
      receipt: included, seal: audit.file.receiptRoot, attestations: audit.file.rootAttestations, contractCommitted: audit.contractCommitted,
      reportedOutcome: audit.file.moves.find(entry => moveId(entry.move) === included.move).reason };
  }
  async receiptPublication(move, receipt) {
    const heights = receipt ? [receipt.tip] : [move.b, move.b + 1, move.b + 2], id = moveId(move);
    for (const height of heights) {
      let cursor; const seen = new Set();
      do {
        const page = await this.receipts({ height, limit: 200, sort: 'id', order: 'asc', cursor });
        check(Array.isArray(page.receipts) && (page.next === null || typeof page.next === 'string' && page.next.length && !seen.has(page.next)), 'Invalid receipt page');
        for (const row of page.receipts) {
          if (!row.archive || receipt && row.seal?.hash !== receipt.hash) continue;
          const file = decodeBinary(await this.publication(row.archive, { binary: true, limit: 1500000 }));
          if (file.receipts.some(r => r.move === id)) return { height: file.height, observation: file.observation, audit: row.archive };
        }
        cursor = page.next; seen.add(cursor);
      } while (cursor !== null);
    }
    return this.latest();
  }
  async submit(move, { hashAt } = {}) {
    check(move.network === this.network && hex32(this.gateway) && typeof hashAt === 'function', 'Pinned gateway and chain required');
    const receipt = await this.request('/moves', { value: move });
    const expected = await hashAt(receipt.tip);
    check(verifyReceipt(receipt, move, { network: this.network, gateway: this.gateway, hashAt: h => h === receipt.tip ? expected : null }), 'Invalid gateway receipt; submission outcome unknown');
    return receipt;
  }
  quote(value) { return this.request('/mint/quote', { value }); }
  requestMint(value) { return this.request('/mint/quote', { value }); }
  mintStatus(id) { check(hex32(id), 'Invalid mint ID'); return this.request('/mint/' + id); }
  mintPaymentPlan(id) { check(hex32(id), 'Invalid mint ID'); return this.request('/web-api/mint/' + id); }
  reportMintPayment(value) { return this.request('/mint/payment', { value }); }
  deployment(asset) { check(/^[pc][0-9a-z]{1,23}$/.test(asset), 'Invalid deployment asset'); return this.request('/mint/deployment/' + asset, { limit: 1500000 }); }
  submitDeployment(value) { return this.request('/mint/deployment', { value }); }
  requestLink(value) { return this.request('/link/request', { value }); }
  paymentLink(id, origin = this.origin, kind = 'mint') {
    check(hex32(id) && ['mint', 'link'].includes(kind), 'Invalid payment request');
    return `${gatewayOrigin(origin, this.mode)}/${kind}/${id}`;
  }
}
