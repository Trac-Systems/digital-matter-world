import { FeeQuotes, createFeePolicy } from '../../service/src/fees.mjs';
import { createPublicKey, verify } from 'node:crypto';
import { checkMove, moveId, signReceipt, sealReceipts, processBlock, encodeBinary,
  paymentDigest, feeFor, splitFee, verifyLinkInput } from '../../rules/src/index.js';
import { check, sha256 } from '../lib/check.mjs';
import { testWallet, witnesses } from './helpers.mjs';

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
