import { FeeQuotes, createFeePolicy, mintFeeScope } from '../../service/src/fees.mjs';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { rules, requestID, permit } from '../signer/adapter.mjs';
import { sha256, hex } from '../signer/crypto.mjs';
import { Policy } from '../signer/policy.mjs';
export const network = 'dmw-regtest';
export function fixture(kind = 'dmt', publicKey = hex(secp256k1.getPublicKey(new Uint8Array(32).fill(2))), baseFee = '100', bitcoinNetwork = 'mainnet') {
  const secret = new Uint8Array(32).fill(1), owner = hex(ed25519.getPublicKey(secret)), receiver = 'regtest-receiver';
  const request = { owner, asset: kind === 'dmt' ? 'p0' : 'c1', ...(kind === 'dmt' ? { block: 10 } : {}), amount: '3', receive: sha256(receiver), nonce: sha256(`nonce-${kind}`), until: 1000, expires: 532 };
  const id = requestID(network, request);
  const context = { deployment: { id: sha256(`deployment-${kind}`) + 'i0', tick: kind === 'dmt' ? 'dmwtest' : 'dmwc1', kind, active: true, privilegePublicKey: publicKey, decimals: 0, remaining: '10000000000000000000', limit: '0' },
    find: { block: 10, asset: 'p0', count: 3, finder: owner, findHeight: 100 }, tier: 1, treasury: 'regtest-treasury', finderAddress: 'regtest-finder', firstMakerAddress: 'regtest-finder' };
  const payment = { id: 'local-payment', requestId: id, kind: 'tap', payer: 'regtest-payer', fees: [], receipts: [] };
  const data = { authority: { network, committee: publicKey, epoch: 0 }, counted: 100,
    pending: { s: 1, h: true, o: 1, asset: request.asset, amount: request.amount, receive: request.receive, e: 532, ...(kind === 'dmt' ? { block: 10 } : {}) },
    acceptance: { id, created: 100, expiry: 532 }, context, minted: false, bitmap: null, hold: { id, expiry: Number.MAX_SAFE_INTEGER }, payment, payer: payment.payer, mint: null };
  const feeQuotes = new FeeQuotes({ network, secret, registry: async () => ({ feePolicy: createFeePolicy(baseFee) }) });
  const feeAuthorizations = new Map();
  const reads = {
    feeQuotes, bindings: { bitcoinNetwork },
    async mintFeeTerms(requestId) {
      const scope = mintFeeScope(request.asset, request.block, data.payment.kind);
      const signedId = requestID(network, request);
      if (!feeAuthorizations.has(signedId)) feeAuthorizations.set(signedId, await feeQuotes.accept(await feeQuotes.issue(scope, 100), scope, signedId, request.expires, 100));
      return feeQuotes.accepted(feeAuthorizations.get(signedId), scope, requestId, request.expires);
    },
    async receiptCertificate(tip, hash) { const c = await this.batchContext(); const input = c.inputs.find(i => i.tip === tip && i.tipHash === hash && i.rootAttestations?.length); return input ? { seal: input.receiptRoot, attestations: input.rootAttestations } : null; },
    async preflight(batch, at) { return { ok: true, ...at, digest: hex(rules.batchDigest(network, batch)) }; },
    authority: async () => data.authority, counted: async () => data.counted, pending: async () => data.pending, agentAddress: async () => owner, pendingAcceptance: async () => data.acceptance,
    assetContext: async () => data.context, isMinted: async () => data.minted, bitmap: async () => data.bitmap, blockHold: async () => data.hold,
    payment: async () => data.payment, mintPayment: async () => data.payment, mintRequest: async () => proposal, payer: async () => data.payer, mint: async () => data.mint,
  };
  const proposal = { kind: 'mint', network, request, signature: rules.signRequest('rq', network, request, secret), receiver, paymentId: payment.id };
  const policy = new Policy({ network, publicKey, reads });
  const confirmed = details => { data.mint = { accepted: true, fail: false, confirmations: 1, inscription: sha256('mint') + 'i0', deployment: details.deployment.id, tick: details.deployment.tick, receiver, amount: request.amount, dta: details.permit.payload.dta, permitHash: details.permit.digest, committee: publicKey, ...(kind === 'dmt' ? { block: request.block } : {}) }; return data.mint; };
  const reprice = ({ consumed = true } = {}) => {
    const nextId = requestID(network, request), c = data.context;
    data.acceptance.id = data.hold.id = data.payment.requestId = nextId;
    const price = rules.feeFor(kind === 'dmt' ? 'find' : 'compound', baseFee, c.tier, c.feeSettings);
    const split = rules.splitFee(price, { kind: kind === 'dmt' ? 'find' : 'compound', linked: !!c.link, found: !!c.find?.finder, discovered: !!c.discoverer });
    data.payment.total = price;
    data.payment.fees = rules.mintFeeItems(split, { treasury: c.treasury, finder: c.finderAddress, firstMaker: c.firstMakerAddress,
      landowner: data.payment.kind === 'ethereum' ? c.landownerAddress : data.bitmap?.address, discoverer: c.discoverer }, nextId, data.payment.payer, data.payment.kind, bitcoinNetwork);
    data.payment.receipts = data.payment.fees.map((f,i) => ({ ...f, key: rules.paymentItemKey(data.payment.kind, `${nextId}/${i}`), confirmations: 1, accepted: true, used: '0', origin: nextId }));
    const allocations = rules.paymentProgress(data.payment.fees, data.payment.receipts).allocations;
    const planned = permit(network, request, c.deployment, receiver, nextId, rules.paymentCommitment(allocations));
    Object.assign(data.pending, { s: consumed ? 1 : 0, h: true, amount: request.amount, e: request.expires, permitHash: planned.digest, paymentHash: rules.paymentCommitment(allocations), payments: allocations });
    return planned;
  };
  reprice();
  return { policy, proposal, data, reads, id, secret, confirmed, publicKey, reprice };
}
export function batchFixture() {
  const gatewaySecret = new Uint8Array(32).fill(9), gateway = hex(ed25519.getPublicKey(gatewaySecret));
  const hashAt = h => sha256(String(h));
  const history = { length: 2001, get: height => ({ height, nonce: height, bits: 1, hash: hashAt(height) }), field: height => String(height) };
  const context = { network, gateway, history, hashAt, patterns: [], state: { lastTip: 99 }, settings: { puzzleBits: 0 }, counted: 95, last: { n: 0, to: 94 }, inputs: [{ height: 95, blockHash: hashAt(95), tip: 100, tipHash: hashAt(100), entries: [], receiptRoot: rules.sealReceipts([], { network, tip: 100, hash: hashAt(100) }, gatewaySecret) }] };
  const output = rules.processBlock({ ...context, ...context.inputs[0] });
  const built = rules.buildBatch({ network, executionHeight: context.counted, epoch: 0, sequence: 1, lastTo: 94, files: [output.file] });
  return { context, proposal: { network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(hex) }, built };
}
