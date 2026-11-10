import { FeeQuotes, createFeePolicy } from '../../service/src/fees.mjs';
import { createPublicKey, verify } from 'node:crypto';
import { checkMove, moveId, signReceipt, sealReceipts, processBlock, encodeBinary,
  paymentDigest, feeFor, splitFee, verifyLinkInput } from '../../rules/src/index.js';
import { check, sha256 } from '../lib/check.mjs';
import { testWallet, witnesses } from './helpers.mjs';
import { merkleRoot, stableJSON, findIdV2 } from '../../rules/src/index.js';

// Public v3 evidence fixture: closure can precede booking by any number of
// blocks. Rows have the shapes projected by the window and block routes.
export class FakeHuntingService {
  constructor() { this.calls = []; this.closures = new Map(); this.pending = new Map(); this.windows = new Map(); this.draws = []; this.finds = []; }
  close(window, winners = [], { senderCount = '0' } = {}) {
    const rows = winners.map(w => ({ source: 'claim', reason: 'won', ...w, id: findIdV2(String(w.block), String(w.pattern)) }));
    const closure = { window: String(window), determinedAt: String(Number(window) + 2), senderCount,
      explicitRoot: merkleRoot(rows.map(w => stableJSON(w.id))), root: merkleRoot(rows.map(stableJSON)), policy: { finderWindow: 1008 } };
    this.closures.set(String(window), closure); this.pending.set(String(window), rows); return closure;
  }
  book(window, at, { indices, draws = true, finds = true, winners = true } = {}) {
    const key = String(window), closure = this.closures.get(key);
    for (const [i, w] of this.pending.get(key).entries()) {
      if (indices && !indices.includes(i)) continue;
      if (winners) {
        const rows = this.windows.get(key) ?? [];
        if (!rows.some(r => r.row.id === w.id)) rows.push({ id: `${closure.root}/0000000000000000/${String(i).padStart(16, '0')}`, row: w, root: closure.root, batch: String(at), audit: null });
        this.windows.set(key, rows.sort((a, b) => a.id.localeCompare(b.id)));
      }
      if (draws && !this.draws.some(r => r.id === w.id)) this.draws.push({ ...w, window: key, provenance: { batch: String(at), root: closure.root } });
      if (finds && !this.finds.some(r => r.id === w.id)) this.finds.push({ id: w.id, block: w.block, pattern: w.pattern, asset: w.asset,
        count: w.count, finder: w.winner, window: key, source: w.source, findHeight: String(at), finderUntil: String(Number(at) + 1008), minted: false });
    }
  }
  fetch = async (url, options = {}) => {
    check((options.method ?? 'GET') === 'GET', 'Fixture permits only GET');
    const u = new URL(url), path = u.pathname, query = Object.fromEntries(u.searchParams); this.calls.push({ path, query });
    if (this.override) { const response = await this.override(path, query); if (response) return response; }
    const closure = /^\/window-eligibility\/(\d+)$/.exec(path);
    if (closure) return Response.json({ v: 3, draw: this.closures.get(closure[1]) ?? null });
    const window = /^\/windows\/(\d+)\/winners$/.exec(path), block = /^\/blocks\/(\d+)\/(draws|finds)$/.exec(path);
    if (!window && !block) return Response.json({ error: 'page_cursor_stale' }, { status: 409 });
    const field = window ? 'rows' : block[2];
    let rows = window ? this.windows.get(window[1]) ?? [] : this[field].filter(r => String(r.block) === block[1]);
    if (query.owner) rows = rows.filter(r => r.finder === query.owner);
    if (query.asset) rows = rows.filter(r => r.asset === query.asset);
    if (query.window) rows = rows.filter(r => String(r.window) === query.window);
    if (query.sort === 'asset') rows = [...rows].sort((a, b) => a.asset.localeCompare(b.asset));
    const offset = Number(query.cursor ?? 0), limit = Math.min(Number(query.limit ?? 50), this.pageSize ?? 50), next = offset + limit < rows.length ? String(offset + limit) : null;
    return Response.json({ v: 3, [field]: rows.slice(offset, offset + limit), nextCursor: next, total: null, revision: '1', limit });
  };
}

// In-memory local HTTP transport. All signed payloads and audit/payment evidence
// use the shared rules; only service storage and wallet settlement are simulated.
export class FakeService {
  constructor({ network, history, tip = 61 }) {
    Object.assign(this, { network, history, tip });
    this.wallet = testWallet(9); this.gateway = this.wallet.publicKey.toString('hex'); this.witness = witnesses();
    this.registry = { feePolicy: createFeePolicy('10') };
    this.feeQuotes = new FeeQuotes({ network, secret: this.wallet.secretKey, registry: async () => this.registry });
    this.entries = new Map(); this.requests = new Map(); this.publications = new Map(); this.calls = [];
    this.state = { lastTip: tip - 1, counted: tip - 1 }; this.patterns = []; this.sequence = 0;
  }
  fetch = async (url, options = {}) => {
    const path = new URL(url).pathname, body = options.body && JSON.parse(options.body);
    this.calls.push({ path, body });
    try {
      let value;
      if (path === '/moves' && body) {
        const id = moveId(body); let entry = this.entries.get(id);
        if (!entry) {
          check(!checkMove(body, { network: this.network, tip: this.tip, hashAt: h => this.history.get(h)?.hash, puzzleBits: 0 }), 'invalid_move');
          entry = { move: body, receipt: signReceipt(body, { tip: this.tip, hash: this.history.get(this.tip).hash, sequence: ++this.sequence }, this.wallet.secretKey) };
          this.entries.set(id, entry);
        }
        value = entry.receipt;
      } else if (/^\/(link)\/request$/.test(path) && body) {
        const kind = path.split('/')[1], { request, sig, payer } = body;
        check(Object.keys(body).sort().join() === 'payer,request,sig', 'plot_envelope');
        const digest = paymentDigest(this.network, request), id = Buffer.from(digest).toString('hex');
        const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(request.owner, 'hex')]), format: 'der', type: 'spki' });
        check(verify(null, digest, key, Buffer.from(sig, 'hex')), 'plot_signature');
        let row = this.requests.get(id);
        if (!row) {
          check(request.until > this.tip, 'plot_expired');
          const scope = `${kind}/${id}`, counted = this.tip, quote = await this.feeQuotes.issue(scope, counted);
          const terms = { baseFee: quote.baseFee, feeAuthorization: await this.feeQuotes.accept(quote, scope, id, request.until, counted), treasury: 'local-treasury', payer, hash: 'ab'.repeat(32) };
          row = { kind, request, sig, terms, id, price: feeFor(kind, terms.baseFee), refundAfter: request.until + 144 };
          this.requests.set(id, row);
        }
        check(row.terms.payer === payer, 'plot_payer_conflict');
        value = { id, price: row.price, terms: row.terms, refundAfter: row.refundAfter };
      } else if (/^\/(link)\/[0-9a-f]{64}$/.test(path)) {
        check(this.requests.has(path.split('/')[2]), 'missing_request');
        return new Response('<!doctype html><title>Local payment fixture</title><p>Review the request in your wallet.</p>', { headers: { 'content-type': 'text/html' } });
      } else if (path === '/latest.json') value = this.latest;
      else if (this.publications.has(path)) return new Response(this.publications.get(path));
      else return Response.json({ error: 'not_found' }, { status: 404 });
      if (this.lose === path) { this.lose = null; throw new Error('lost_response'); }
      return Response.json(value);
    } catch (error) {
      if (error.message === 'lost_response') throw error;
      return Response.json({ error: error.message }, { status: 400 });
    }
  };
  publish(file) {
    const bytes = encodeBinary(file), hash = sha256(bytes), path = `/blocks/${hash}.bin`;
    this.publications.set(path, bytes);
    return this.latest = { height: file.height, observation: file.observation, audit: { path, hash, bytes: bytes.length } };
  }
  observe({ entries = [...this.entries.values()].filter(e => e.receipt.tip === this.tip), ...extra } = {}) {
    const hashAt = h => this.history.get(h)?.hash, height = this.tip;
    const seal = sealReceipts(entries.map(e => e.receipt), { network: this.network, tip: this.tip, hash: hashAt(this.tip) }, this.wallet.secretKey);
    const output = processBlock({ network: this.network, gateway: this.gateway, height, blockHash: hashAt(height), tip: this.tip, tipHash: hashAt(this.tip),
      history: this.history, patterns: this.patterns, state: this.state, entries, receiptRoot: seal, rootAttestations: entries.length ? this.witness.attest(seal) : [],
      hashAt, settings: { puzzleBits: 0, receiptSigners: this.witness.members }, ...extra });
    this.state = output.state; this.patterns = output.patterns;
    return { output, publication: this.publish(output.file) };
  }
  evidence(id, changes = {}) {
    const row = this.requests.get(id), { kind, request, sig, terms } = row, split = splitFee(row.price, { kind });
    const payment = { id: 'payment-' + id, requestId: id, kind: 'tap', payer: terms.payer, total: row.price, consumed: kind === 'link', confirmations: 1,
      verifiedHeight: this.tip, eventIndex: 0, tick: 'tap', lockKind: 'htlc', conditionType: 'hashlock', hash: terms.hash,
      refund: terms.payer, claim: terms.treasury, base: split.treasury, allocations: [{ tt: 'b', to: '1BitcoinEaterAddressDontSendf59kuE', amt: split.burn, rl: 'bn' }], refundAfter: row.refundAfter };
    if (kind === 'link') payment.settlement = { accepted: true, refund: false, paymentId: payment.id, txid: 'cd'.repeat(32), confirmations: 1 };
    const input = { request, sig, terms, payment: { ...payment, ...changes } };
    verifyLinkInput(input, this.network, this.tip);
    return kind === 'link' ? { ...input, bitmap: { agent: request.owner, address: 'local-bitmap-holder' }, previous: null } : input;
  }
}
