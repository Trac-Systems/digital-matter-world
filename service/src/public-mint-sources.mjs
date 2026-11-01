import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { mintFeeScope } from './fees.mjs';
import { financialFees } from './financial-sources.mjs';
import { financialSplit } from '../../rules/src/financial-fees.js';
import { payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { tapReceipts, inscriptionContents } from './mint-payments.mjs';
import { permit } from '../../committee/signer/adapter.mjs';
import { publicScanKey } from '../../contract/public-mint.js';
import { plotKey } from '../../contract/financial-capacity.js';
import { randomBytes } from 'node:crypto';
const DOMAIN = 'dmw-public-mint-quote-v1', PREFIX = 'dmw-public-pay-v1|';
const PREFIX_V2 = 'dmw-public-pay-v2|';
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
export const publicPaymentData = (intent, role) => intent.paymentVersion === 2
  ? PREFIX_V2 + rules.publicPaymentCommitment(intent) + '|' + role
  : PREFIX + Buffer.from(rules.stableJSON(intent)).toString('base64url') + '|' + role;
export function publicPaymentReference(data, maxBytes) {
  if (typeof data !== 'string' || Buffer.byteLength(data) > maxBytes) return null;
  return /^dmw-public-pay-v2\|([0-9a-f]{64})\|[a-zA-Z]+$/.exec(data)?.[1] ?? null;
}
export function publicPaymentIntent(data, maxBytes) {
  if (typeof data !== 'string' || !data.startsWith(PREFIX) || Buffer.byteLength(data) > maxBytes) return null;
  const parts = data.split('|'); if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
}
// Only accepted registrations/reveals resolve payment bytes. A local preimage
// can propose a reveal, but cannot stand in for consensus evidence here.
export async function resolvePublicPaymentIntent(reads, item, { document, height, reference, at }) {
  const commitment = publicPaymentReference(item?.dta, document.values.moveBytes);
  if (!commitment) return publicPaymentIntent(item?.dta, document.values.moveBytes);
  if (!rules.publicPaymentV2Active(document, height) || typeof item.address !== 'string' || typeof item.tick !== 'string') return null;
  const row = await reads.financialRecord(rules.publicPaymentKey(commitment), at);
  if (!row || BigInt(height) <= BigInt(row.registeredHeight) || !row.registration.feeBindings.includes(
    rules.publicPaymentFeeBinding(commitment, item.dta.split('|')[2], item.address, item.tick))) return null;
  if (row.intent) return rules.bindPublicPaymentIntent(row.intent, row.registration);
  const confirmed = async () => {
    const inclusion = await reads.included(reference, at);
    if (!inclusion || inclusion.confirmations < 1 || rules.decimalV2(inclusion.height) !== height) return false;
    let amount; try { amount = rules.parseTapAmount(item.amt); } catch { return false; }
    if (BigInt(amount) <= 0n) return false;
    const transfers = await reads.paymentTransfers(reference);
    return transfers.some(({ value: t }) => t.ins === reference && t.fail === false && t.int === true &&
      t.addr === row.registration.payer && t.dta === item.dta && t.taddr === item.address && t.tick === item.tick && t.amt === amount);
  };
  if (await (reads.withTapSnapshot ? reads.withTapSnapshot(at, confirmed) : confirmed())) {
    throw Object.assign(Error('public_payment_unrevealed'), { commitment, reference });
  }
  return null;
}
export function installPublicMintSources(reads, { network, bitcoinNetwork = 'mainnet', lookupSettings }) {
  const active = async at => {
    const context = await reads.rulesContext(), height = rules.decimalV2(at?.counted ?? await reads.counted());
    check(rules.publicMintActive(context.settings, height), 'public_mint_inactive'); return { document: context.settings, height };
  };
  reads.publicMintContext = async (asset, block, at, feeQuote, { settled = false, scanning = false, deployment } = {}) => {
    const { document, height } = await active(at), context = await reads.assetContext(asset, block, at ?? 'tap', feeQuote, undefined, deployment);
    check(context.pattern && context.publicClaims && context.deployment?.active && context.deployment.kind === 'dmt', 'public_index_warming', 503);
    const scope = rules.tickerSupplyScope(context.deployment, at?.executionHeight ?? height);
    const shared = rules.multiTickerActive(at?.executionHeight ?? height) && !settled && (await reads.financialRecord(rules.capacityPlotKey(asset, rules.decimalV2(block), scope), at) || await reads.financialRecord(plotKey(asset, block, scope), at));
    const minted = !!shared || await reads.isMinted(context.deployment.id, context.deployment.tick, block, at);
    const rightInput = { pattern: context.pattern, block, height, executionHeight: at?.executionHeight ?? height, settings: document, find: context.find,
      reserved: context.publicClaims.reservation, headerAward: context.publicClaims.headerAward, minted: !settled && minted };
    let right = rules.publicBlockRight(rightInput);
    const legacy = right.claimDeadline !== undefined;
    if (!legacy) {
      const winner = settled && (await reads.financialRecord(publicScanKey(rules.publicPlotId(asset, block, scope)), at))?.winner;
      const capacity = !settled && !scanning && await reads.financialRecord(plotKey(asset, block, scope), at);
      if (settled && rules.perTickerSupplyActive(at?.executionHeight ?? height) && !winner &&
          await reads.financialRecord(rules.capacityPlotKey(asset, rules.decimalV2(block), scope), at)) right = rules.publicBlockRight({ ...rightInput, minted: true });
      if (winner) right = rules.publicBlockRight({ ...rightInput, find: null, reserved: null, headerAward: false });
      else if (capacity && right.state !== 'claimed') right = rules.publicBlockRight({ ...rightInput, minted: true });
    }
    // Scanning must continue after an agent takes the block so confirmed payments can be refunded.
    check(scanning && !legacy || right.state === 'public' || right.state === 'finder', settled && !legacy && right.state === 'claimed' ? 'claimed_first' : right.state, 409);
    check(!legacy || !context.publicClaims.unsettled, 'public_scan_pending', 503);
    check(!rules.fieldValueMode(context.pattern) || rules.fieldValueAmountActive(height), 'pattern_amount_inactive');
    const amount = rules.patternAmount(context.pattern, await reads.publicMintHeader(block, at));
    check(BigInt(amount) > 0n, 'mint_no_match');
    return { context, document, height, amount, ...right };
  };
  const terms = async (input, at, { settled = false } = {}) => {
    const { asset, block, tapAddress, feeQuote, deployment } = input;
    payoutAddress('tap', tapAddress, bitcoinNetwork);
    const resolved = await reads.publicMintContext(asset, block, at, feeQuote, { settled, deployment }), { context: c, document } = resolved;
    check(resolved.state !== 'finder' || c.finderAddress === tapAddress, 'finder_only', 409);
    const holder = c.link ? c.bitmapHolder ?? await reads.bitmap(block, at) : null;
    if (rules.bitmapMintOpenActive(document, resolved.height) && c.link) check(typeof holder?.address === 'string' && holder.address.length > 0, 'bitmap_missing');
    check(resolved.state === 'finder' || rules.bitmapMintOpenActive(document, resolved.height) || !c.link || holder?.address === tapAddress, 'bitmap_holder_only', 409);
    const q = feeQuote ?? await reads.feeQuotes.issue(mintFeeScope(asset, block, 'tap'), resolved.height, c.payouts, c.deployment.id);
    await reads.feeQuotes.validate(q, mintFeeScope(asset, block, 'tap'));
    const original = await reads.financialSettings(q.settingsHash);
    check(rules.publicMintActive(original, q.validFrom) && q.deploymentId === c.deployment.id && same(q.payouts, c.payouts), 'public_quote_binding');
    const price = rules.feeFor('find', q.baseFee, c.tier, q.feeSettings, at?.executionHeight ?? resolved.height), baseSplit = financialSplit(price,
      { kind: 'find', publicMint: !(rules.perTickerSupplyActive(at?.executionHeight ?? resolved.height) && c.find), linked: !!holder, discovered: !!(c.beneficiaries?.discoverer ?? c.discoverer) }, original);
    const { split, legacyDeploy, deployer } = rules.deploymentHolderFee(price, baseSplit, { kind: 'find', deployment: c.deployment,
      document: original, height: at?.executionHeight ?? resolved.height, bitcoinNetwork });
    const destinations = { treasury: c.treasury, finder: rules.perTickerSupplyActive(at?.executionHeight ?? resolved.height) ? c.finderAddress ?? null : null, firstMaker: null, landowner: holder?.address ?? null, discoverer: c.discoverer ?? null };
    const plan = reads.financialFeePlan({ split, destinations, beneficiaries: c.beneficiaries, id: null, payer: tapAddress, rail: 'tap' });
    return { ...resolved, feeQuote: q, price, split, ...(legacyDeploy ? { legacyDeploy } : {}), ...(deployer ? { deployer } : {}), destinations, beneficiaries: c.beneficiaries, plan };
  };
  reads.publicMintQuote = async (input, at) => {
    const result = await terms(input, at), { context: c, amount, feeQuote, price, split, plan, claimDeadline, document, height } = result;
    const scope = rules.tickerSupplyScope(c.deployment, at?.executionHeight ?? height);
    const body = { network, ...(scope ? { supplyScope: scope } : {}), ...(input.deployment ? { deployment: c.deployment.id } : {}), asset: input.asset, block: rules.decimalV2(input.block), tapAddress: input.tapAddress, amount, feeQuote,
      price, split, fees: plan.fees, custody: plan.custody, ...(claimDeadline === undefined ? {} : { claimDeadline }), settingsHash: rules.hashObject(document),
      ...(rules.publicPaymentV2Active(document, height) ? { paymentVersion: 2, paymentSalt: randomBytes(32).toString('hex') } : {}) };
    const intent = reads.feeQuotes.sign(DOMAIN, body), id = rules.publicRequestId(network, intent);
    const fees = plan.fees.map(f => ({ ...f, dta: publicPaymentData(intent, f.role) }));
    check(fees.length > 0 && fees.every(f => Buffer.byteLength(f.dta) <= document.values.moveBytes), 'public_quote_size');
    const commitment = intent.paymentVersion === 2 ? rules.publicPaymentCommitment(intent) : null;
    const registration = commitment ? reads.feeQuotes.sign(rules.PUBLIC_PAYMENT_REGISTRATION_DOMAIN, {
      network, commitment, payer: input.tapAddress, feeBindings: intent.fees.map(f => rules.publicPaymentFeeBinding(commitment, f.role, f.to, f.ticker)),
      validFrom: feeQuote.validFrom, validUntil: feeQuote.validUntil, settingsHash: intent.settingsHash }) : null;
    if (registration) check(Buffer.byteLength(rules.stableJSON({ type: 'public-payment', id: commitment, action: 'reveal', intent,
      reference: '0'.repeat(64) + 'i9999999999' })) <= document.values.moveBytes, 'public_quote_size');
    return { id, intent, fees, amount, price, split, feeQuote, deployment: c.deployment, ...(registration ? { registration } : {}) };
  };
  const payment = async (intent, reference, position, at) => {
    const signed = reads.feeQuotes.verify(DOMAIN, intent), id = rules.publicRequestId(network, intent);
    check(signed.network === network && signed.block === rules.decimalV2(signed.block), 'public_quote_binding');
    const { document, height } = await active(at), v2 = signed.paymentVersion === 2;
    check(v2 === rules.publicPaymentV2Active(document, signed.feeQuote.validFrom) &&
      (!v2 || rules.publicPaymentV2Active(document, position.height)), 'public_payment_activation');
    const original = await reads.financialSettings(signed.settingsHash);
    check(rules.publicMintActive(original, position.height) && signed.feeQuote.settingsHash === signed.settingsHash, 'public_quote_binding');
    let result, refusal;
    try {
      result = await terms(signed, at, { settled: true });
      check((rules.perTickerSupplyActive(at?.executionHeight ?? height) ? signed.supplyScope ?? null : null) ===
        rules.tickerSupplyScope(result.context.deployment, at?.executionHeight ?? height), 'public_quote_changed');
      check(result.amount === signed.amount && result.price === signed.price && same(result.split, signed.split) &&
        same(result.plan.fees, signed.fees) && same(result.plan.custody, signed.custody), 'public_quote_changed');
      check(BigInt(position.height) >= BigInt(signed.feeQuote.validFrom) && BigInt(position.height) <= BigInt(signed.feeQuote.validUntil), 'quote_expired');
    } catch (error) {
      if (!['already_minted', 'finder_only', 'bitmap_holder_only', 'claimed', 'claimed_first', 'quote_expired', 'public_quote_changed'].includes(error.message)) throw error;
      refusal = error.message;
    }
    const feeItems = signed.fees.map(f => ({ ...f, dta: publicPaymentData(intent, f.role) }));
    const row = { id, payer: signed.tapAddress, quote: { fees: feeItems } };
    const receipts = await tapReceipts(reads, row, [reference], lookupSettings, { at, confirmedOnly: true });
    if (!receipts.length) return null;
    if (v2) check(receipts.every(r => r.verifiedHeight === position.height), 'public_payment_height');
    const progress = rules.paymentProgress(feeItems, receipts), complete = !refusal && progress.final;
    const received = receipts.map(({ role, to, ticker, amount, tt, key }) => ({ role, to, ticker, amount, tt, key }));
    const scope = rules.perTickerSupplyActive(at?.executionHeight ?? height) ? signed.supplyScope ?? null : null;
    const value = { id, ...(scope ? { deployment: scope } : {}), asset: signed.asset, block: signed.block, tapAddress: signed.tapAddress, reference, ...position, complete,
      fees: received, ...(refusal ? { refusal } : {}), ...(rules.publicPaymentV2Active(document, height) ? {
        paymentVersion: v2 ? 2 : 1, paymentCreated: signed.feeQuote.validFrom, ...(v2 ? { commitment: rules.publicPaymentCommitment(intent) } : {}) } : {}) };
    if (!complete) return value;
    const d = result.context.deployment;
    check(scope === rules.tickerSupplyScope(d, at?.executionHeight ?? height), 'public_quote_binding');
    const request = { asset: signed.asset, block: signed.block, amount: signed.amount };
    const generation = await reads.financialRecord(d.officialDeployment ? 'fd/external/' + rules.hashObject(d.id) : 'fd/asset/' + signed.asset, at), registered = generation && await reads.financialRecord('fd/' + generation, at);
    check(registered?.deployment === d.id, 'financial_deployment_pending');
    const source = { publicMint: true, requestId: id, owner: null, request, asset: signed.asset, amount: signed.amount, receiver: signed.tapAddress,
      payer: signed.tapAddress, rail: 'tap', deployment: d, quote: signed.feeQuote, intent, feeItems, fees: financialFees(feeItems),
      ...(result.legacyDeploy ? { legacyDeploy: result.legacyDeploy } : {}), ...(result.deployer ? { deployer: result.deployer } : {}),
      custody: signed.custody.map(c => ({ ...c, requestId: id })), settingsHash: signed.settingsHash, generation,
      capacity: { deployment: d.id, asset: signed.asset, block: signed.block, amount: signed.amount, remaining: d.remaining, limit: d.limit ?? '0', ...(scope ? { supplyScope: scope } : {}) } };
    const paymentHash = rules.paymentCommitment(progress.allocations), plan = permit(network, request, d, signed.tapAddress, id, paymentHash);
    return { ...value, source, paymentHash, permitHash: plan.digest };
  };
  reads.publicMintPayment = async (transition, at) => {
    const { document, height } = await active(at), { id, action } = transition;
    check(rules.publicPaymentV2Active(document, height), 'public_payment_activation');
    const old = await reads.financialRecord(rules.publicPaymentKey(id), at), previous = rules.hashObject(old ?? null);
    if (action === 'register') {
      const r = rules.validatePublicPaymentRegistration(transition.registration, document, height);
      reads.feeQuotes.verify(rules.PUBLIC_PAYMENT_REGISTRATION_DOMAIN, r);
      const original = await reads.financialSettings(r.settingsHash);
      check(!old && r.network === network && r.commitment === id && rules.publicPaymentV2Active(original, r.validFrom) &&
        BigInt(height) <= BigInt(r.validUntil) && r.validUntil === rules.addUint(r.validFrom, String(original.values.quoteLifetimeTips)), 'public_payment_registration');
      payoutAddress('tap', r.payer, bitcoinNetwork);
      return { requestId: id, action, previous, registration: r };
    }
    check(action === 'reveal' && old && !old.intent, 'public_payment_reveal');
    const { intent, reference } = transition;
    rules.bindPublicPaymentIntent(intent, old.registration);
    reads.feeQuotes.verify(DOMAIN, intent);
    check(intent.network === network && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(reference ?? ''), 'public_payment_reveal');
    const fees = intent.fees.map(f => ({ ...f, dta: publicPaymentData(intent, f.role) }));
    const receipts = await tapReceipts(reads, { id: rules.publicRequestId(network, intent), payer: intent.tapAddress, quote: { fees } },
      [reference], lookupSettings, { at, confirmedOnly: true });
    const paymentHeight = receipts[0]?.verifiedHeight;
    check(receipts.some(r => BigInt(r.amount) > 0n) && receipts.every(r => r.confirmations >= 1 && r.verifiedHeight === paymentHeight) &&
      rules.publicPaymentV2Active(document, paymentHeight) && BigInt(paymentHeight) > BigInt(old.registeredHeight) &&
      BigInt(paymentHeight) <= BigInt(height), 'public_payment_unconfirmed');
    return { requestId: id, action, previous, intent, reference, paymentHeight };
  };
  reads.publicMintScan = async (transition, at) => {
    const { document, height } = await active(at), { asset, block } = transition, scope = transition.deployment ?? null, id = rules.publicPlotId(asset, block, scope);
    check(!scope || rules.perTickerSupplyActive(at?.executionHeight ?? height), 'per_ticker_supply_inactive');
    check(transition.id === id, 'public_scan_identity');
    const old = await reads.financialRecord(publicScanKey(id), at);
    const ctx = old?.winner ? null : await reads.publicMintContext(asset, block, at, undefined, { scanning: true, deployment: scope ?? undefined });
    const start = old?.next?.height ?? (ctx?.claimDeadline !== undefined && BigInt(ctx.claimDeadline) > BigInt(document.values.publicMintActivationHeight) ? ctx.claimDeadline : document.values.publicMintActivationHeight);
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
          const intent = await resolvePublicPaymentIntent(reads, item, { document, height: from.height, reference: parsed.txid + 'i' + ii, at });
          if (intent?.asset === asset && intent.block === block &&
              (rules.perTickerSupplyActive(at?.executionHeight ?? height) ? intent.supplyScope ?? null : null) === scope) intents.set(rules.publicRequestId(network, intent), intent);
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
          if (!['fee_quote_signature', 'public_quote_binding', 'payment_redeem', 'payment_item_binding', 'public_payment_activation'].includes(error.message)) throw error;
        }
      }
      if (ii < parsed.contents.length) break;
      ii = 0;
    }
    const next = ti === b.transactions.length ? { height: String(BigInt(from.height) + 1n), transactionIndex: '0', inscriptionIndex: '0' } :
      { height: from.height, transactionIndex: String(ti), inscriptionIndex: String(ii) };
    return { requestId: id, asset, block, ...(scope ? { deployment: scope } : {}), start, previous: rules.hashObject(old ?? null), from, next, blockHash: b.hash, payments };
  };
  reads.publicMintPermit = async (id, at) => {
    if (reads.financialChainAnchor) await reads.financialChainAnchor({ at, prior: await reads.financialRecord('fp/chain', at) });
    const source = await reads.financialRecord('fi/source/' + id, at), funding = await reads.financialRecord('fp/' + id, at);
    check(source?.publicMint && funding?.state === 'consumed', 'public_payment_unsettled');
    const state = await reads.financialRecord(publicScanKey(rules.publicPlotId(source.asset, source.request.block, source.capacity?.supplyScope)), at);
    check(state?.winner?.id === id && state.winner.permitHash === funding.permitHash, 'someone_paid_first');
    const plan = permit(network, source.request, source.deployment, source.receiver, id, state.winner.paymentHash);
    check(plan.digest === funding.permitHash, 'public_permit_binding');
    return { source, funding, permit: plan };
  };
  return reads;
}
