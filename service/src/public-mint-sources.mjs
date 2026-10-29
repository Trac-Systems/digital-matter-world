import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { mintFeeScope } from './fees.mjs';
import { financialFees } from './financial-sources.mjs';
import { financialSplit } from '../../rules/src/financial-fees.js';
import { payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { tapReceipts, inscriptionContents } from './mint-payments.mjs';
import { permit } from '../../committee/signer/adapter.mjs';
import { publicScanKey } from '../../contract/public-mint.js';
const DOMAIN = 'dmw-public-mint-quote-v1', PREFIX = 'dmw-public-pay-v1|';
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
export const publicPaymentData = (intent, role) => PREFIX + Buffer.from(rules.stableJSON(intent)).toString('base64url') + '|' + role;
export function publicPaymentIntent(data, maxBytes) {
  if (typeof data !== 'string' || !data.startsWith(PREFIX) || Buffer.byteLength(data) > maxBytes) return null;
  const parts = data.split('|'); if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
}
export function installPublicMintSources(reads, { network, bitcoinNetwork = 'mainnet', lookupSettings }) {
  const active = async at => {
    const context = await reads.rulesContext(), height = rules.decimalV2(at?.counted ?? await reads.counted());
    check(rules.publicMintActive(context.settings, height), 'public_mint_inactive'); return { document: context.settings, height };
  };
  reads.publicMintContext = async (asset, block, at, feeQuote, { settled = false } = {}) => {
    const { document, height } = await active(at), context = await reads.assetContext(asset, block, at ?? 'tap', feeQuote);
    check(context.pattern && context.publicClaims && context.deployment?.active && context.deployment.kind === 'dmt', 'public_index_warming', 503);
    const minted = await reads.isMinted(context.deployment.id, context.deployment.tick, block, at);
    const right = rules.publicBlockRight({ pattern: context.pattern, block, height, settings: document, find: context.find,
      reserved: context.publicClaims.reservation, headerAward: context.publicClaims.headerAward, minted: !settled && minted });
    check(right.state === 'public', right.state, 409);
    check(!context.publicClaims.unsettled, 'public_scan_pending', 503);
    const amount = String(rules.patternCount(context.pattern, await reads.publicMintHeader(block, at)));
    check(BigInt(amount) > 0n, 'mint_no_match');
    return { context, document, height, amount, ...right };
  };
  const terms = async (input, at, { settled = false } = {}) => {
    const { asset, block, tapAddress, feeQuote } = input;
    payoutAddress('tap', tapAddress, bitcoinNetwork);
    const resolved = await reads.publicMintContext(asset, block, at, feeQuote, { settled }), { context: c, document } = resolved;
    const holder = c.link ? c.bitmapHolder ?? await reads.bitmap(block, at) : null;
    check(!c.link || holder?.address === tapAddress, 'bitmap_holder_only', 409);
    const q = feeQuote ?? await reads.feeQuotes.issue(mintFeeScope(asset, block, 'tap'), resolved.height, c.payouts, c.deployment.id);
    await reads.feeQuotes.validate(q, mintFeeScope(asset, block, 'tap'));
    const original = await reads.financialSettings(q.settingsHash);
    check(rules.publicMintActive(original, q.validFrom) && q.deploymentId === c.deployment.id && same(q.payouts, c.payouts), 'public_quote_binding');
    const price = rules.feeFor('find', q.baseFee, c.tier, q.feeSettings), split = financialSplit(price,
      { kind: 'find', publicMint: true, linked: !!holder, discovered: !!(c.beneficiaries?.discoverer ?? c.discoverer) }, original);
    const destinations = { treasury: c.treasury, finder: null, firstMaker: null, landowner: holder?.address ?? null, discoverer: c.discoverer ?? null };
    const plan = reads.financialFeePlan({ split, destinations, beneficiaries: c.beneficiaries, id: null, payer: tapAddress, rail: 'tap' });
    return { ...resolved, feeQuote: q, price, split, destinations, beneficiaries: c.beneficiaries, plan };
  };
  reads.publicMintQuote = async (input, at) => {
    const result = await terms(input, at), { context: c, amount, feeQuote, price, split, plan, claimDeadline, document } = result;
    const body = { network, asset: input.asset, block: rules.decimalV2(input.block), tapAddress: input.tapAddress, amount, feeQuote,
      price, split, fees: plan.fees, custody: plan.custody, claimDeadline, settingsHash: rules.hashObject(document) };
    const intent = reads.feeQuotes.sign(DOMAIN, body), id = rules.publicRequestId(network, intent);
    const fees = plan.fees.map(f => ({ ...f, dta: publicPaymentData(intent, f.role) }));
    check(fees.length > 0 && fees.every(f => Buffer.byteLength(f.dta) <= document.values.moveBytes), 'public_quote_size');
    return { id, intent, fees, amount, price, split, feeQuote, claimDeadline, deployment: c.deployment };
  };
  const payment = async (intent, reference, position, at) => {
    const signed = reads.feeQuotes.verify(DOMAIN, intent), id = rules.publicRequestId(network, intent);
    check(signed.network === network && signed.block === rules.decimalV2(signed.block), 'public_quote_binding');
    const original = await reads.financialSettings(signed.settingsHash);
    check(rules.publicMintActive(original, position.height) && signed.feeQuote.settingsHash === signed.settingsHash, 'public_quote_binding');
    let result, refusal;
    try {
      result = await terms(signed, at, { settled: true });
      check(result.amount === signed.amount && result.price === signed.price && same(result.split, signed.split) &&
        same(result.plan.fees, signed.fees) && same(result.plan.custody, signed.custody), 'public_quote_changed');
      check(BigInt(position.height) >= BigInt(signed.feeQuote.validFrom) && BigInt(position.height) <= BigInt(signed.feeQuote.validUntil), 'quote_expired');
    } catch (error) {
      if (!['bitmap_holder_only', 'claimed', 'quote_expired', 'public_quote_changed'].includes(error.message)) throw error;
      refusal = error.message;
    }
    const feeItems = signed.fees.map(f => ({ ...f, dta: publicPaymentData(intent, f.role) }));
    const row = { id, payer: signed.tapAddress, quote: { fees: feeItems } };
    const receipts = await tapReceipts(reads, row, [reference], lookupSettings, { at, confirmedOnly: true });
    if (!receipts.length) return null;
    const progress = rules.paymentProgress(feeItems, receipts), complete = !refusal && progress.final;
    const received = receipts.map(({ role, to, ticker, amount, tt, key }) => ({ role, to, ticker, amount, tt, key }));
    const value = { id, asset: signed.asset, block: signed.block, tapAddress: signed.tapAddress, reference, ...position, complete,
      fees: received, ...(refusal ? { refusal } : {}) };
    if (!complete) return value;
    const d = result.context.deployment, request = { asset: signed.asset, block: signed.block, amount: signed.amount };
    const generation = await reads.financialRecord('fd/asset/' + signed.asset, at), registered = generation && await reads.financialRecord('fd/' + generation, at);
    check(registered?.deployment === d.id, 'financial_deployment_pending');
    const source = { publicMint: true, requestId: id, owner: null, request, asset: signed.asset, amount: signed.amount, receiver: signed.tapAddress,
      payer: signed.tapAddress, rail: 'tap', deployment: d, quote: signed.feeQuote, intent, feeItems, fees: financialFees(feeItems),
      custody: signed.custody.map(c => ({ ...c, requestId: id })), settingsHash: signed.settingsHash, generation,
      capacity: { deployment: d.id, asset: signed.asset, block: signed.block, amount: signed.amount, remaining: d.remaining, limit: d.limit ?? '0' } };
    const paymentHash = rules.paymentCommitment(progress.allocations), plan = permit(network, request, d, signed.tapAddress, id, paymentHash);
    return { ...value, source, paymentHash, permitHash: plan.digest };
  };
  reads.publicMintScan = async (transition, at) => {
    const { document, height } = await active(at), { asset, block } = transition, id = rules.publicPlotId(asset, block);
    check(transition.id === id, 'public_scan_identity');
    const old = await reads.financialRecord(publicScanKey(id), at);
    const ctx = old?.winner ? null : await reads.publicMintContext(asset, block, at);
    const start = old?.next?.height ?? (BigInt(ctx.claimDeadline) > BigInt(document.values.publicMintActivationHeight) ? ctx.claimDeadline : document.values.publicMintActivationHeight);
    const from = old?.next ?? { height: start, transactionIndex: '0', inscriptionIndex: '0' };
    check(BigInt(from.height) <= BigInt(height), 'public_scan_pending');
    if (old) check(await reads.publicBitcoinHash(old.scannedHeight, at) === old.blockHash, 'public_payment_reorg');
    const b = await reads.publicBitcoinBlock(from.height, at);
    check(rules.decimalV2(b.height) === from.height && Array.isArray(b.transactions) && b.transactions.length === b.tx.length, 'public_block_evidence');
    const payments = []; let ti = Number(from.transactionIndex), ii = Number(from.inscriptionIndex), work = 0;
    for (; ti < b.transactions.length && work < document.values.publicMintPageSize; ti++) {
      const parsed = inscriptionContents(b.transactions[ti], lookupSettings, { scan: true });
      check(parsed.txid === b.tx[ti], 'public_block_transaction');
      if (!parsed.contents.length) { work++; ii = 0; continue; }
      for (; ii < parsed.contents.length && work < document.values.publicMintPageSize; ii++, work++) {
        const payload = parsed.contents[ii];
        if (payload?.p !== 'tap' || payload.op !== 'token-auth' || !Array.isArray(payload.redeem?.items)) continue;
        const intents = new Map();
        for (const item of payload.redeem.items) {
          const intent = publicPaymentIntent(item.dta, document.values.moveBytes);
          if (intent?.asset === asset && intent.block === block) intents.set(rules.publicRequestId(network, intent), intent);
        }
        // One public checkout per inscription gives an unambiguous position.
        if (intents.size !== 1) continue;
        const intent = [...intents.values()][0];
        try {
          const p = await payment(intent, parsed.txid + 'i' + ii, { height: from.height, transactionIndex: String(ti), inscriptionIndex: String(ii) }, at);
          if (p) payments.push(p);
        } catch (error) {
          // Invalid user payloads cannot halt scanning. Missing independent
          // chain/index/settings evidence must halt it instead of skipping.
          if (!['fee_quote_signature', 'public_quote_binding', 'payment_redeem', 'payment_item_binding'].includes(error.message)) throw error;
        }
      }
      if (ii < parsed.contents.length) break;
      ii = 0;
    }
    const next = ti === b.transactions.length ? { height: String(BigInt(from.height) + 1n), transactionIndex: '0', inscriptionIndex: '0' } :
      { height: from.height, transactionIndex: String(ti), inscriptionIndex: String(ii) };
    return { requestId: id, asset, block, start, previous: rules.hashObject(old ?? null), from, next, blockHash: b.hash, payments };
  };
  reads.publicMintPermit = async (id, at) => {
    if (reads.financialChainAnchor) await reads.financialChainAnchor({ at, prior: await reads.financialRecord('fp/chain', at) });
    const source = await reads.financialRecord('fi/source/' + id, at), funding = await reads.financialRecord('fp/' + id, at);
    check(source?.publicMint && funding?.state === 'consumed', 'public_payment_unsettled');
    const state = await reads.financialRecord(publicScanKey(rules.publicPlotId(source.asset, source.request.block)), at);
    check(state?.winner?.id === id && state.winner.permitHash === funding.permitHash, 'someone_paid_first');
    const plan = permit(network, source.request, source.deployment, source.receiver, id, state.winner.paymentHash);
    check(plan.digest === funding.permitHash, 'public_permit_binding');
    return { source, funding, permit: plan };
  };
  return reads;
}
