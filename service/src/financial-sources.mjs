import { installTickerPaymentSources } from './ticker-payment-sources.mjs';
import { installLinkSources } from './financial-link-sources.mjs';
import { installCreditSources } from './financial-credit-sources.mjs';
import { installCustodySources } from './financial-custody-sources.mjs';
import { installRecoverySources } from './financial-recovery-sources.mjs';
import { identifyFinancialFees, financialFeeKey } from './financial-fee-identity.mjs';
import { installCapacitySources, financialGenerationId } from './financial-capacity-sources.mjs';
import { financialMintId, verifyFinancialMintRequest, financialPaymentHash } from '../../rules/src/financial-mint.js';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { verifyPayer } from './mints.mjs';
import { mintFeeScope } from './fees.mjs';
import { tapReceipts } from './mint-payments.mjs';
import { permit } from '../../committee/signer/adapter.mjs';
import { escrowSplitForItems } from '../../committee/signer/escrow.mjs';
import { verifyDeployment } from './deployments.mjs';
import { capacityKey } from '../../contract/financial-capacity.js';
import { financialSplit } from '../../rules/src/financial-fees.js';
import { beneficiaryFeePlan } from '../../rules/src/beneficiary-credits.js';
import { payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { legacyMintBinding, legacyLinkBinding } from './pending-financial.mjs';
import { installLegacyLinkSources } from './legacy-link-sources.mjs';
import { installPublicMintSources } from './public-mint-sources.mjs';
import { pointBatch, pointResults } from '../../rules/src/point-read-batch.js';

const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const feeKey = financialFeeKey;
export const financialFees = fees => fees.map(f => ({ key: feeKey(f), amount: f.amount }));
const immutableDeployment = d => Object.fromEntries(['id', 'generation', 'privilege', 'elementId', 'dt', 'options', 'approval', 'kind', 'tick', 'privilegePublicKey', 'decimals'].map(k => [k, d[k] ?? null]).concat(d.officialDeployment ? [['officialDeployment', d.officialDeployment]] : []));

export async function acceptedFinancialReservation({ store, audits, id }) {
  const location = await store.get('financialAdmissions', id);
  check(location && Number.isSafeInteger(location.file) && location.file >= 0 && Number.isSafeInteger(location.index) && location.index >= 0, 'financial_admission_missing');
  const input = (await audits(location.n))[location.file]?.financialOperations?.[location.index];
  check((input?.transition.type === 'reserve' || input?.transition.action?.type === 'link-reserve') && input.transition.id === id && input.transition.action.terms === rules.hashObject(input.evidence), 'financial_admission_binding');
  return input.evidence;
}

// Shared code, separate reader instances and independent chain/notary clients.
// No gateway evidence field is a substitute for one of these source reads.
export function installFinancialSources(reads, options) {
  const { network, document, bitcoinNetwork = 'mainnet', escrow, suspense = {}, ethereumRPC, payout = async () => null, lookupSettings, recoveryVersion, request, reservation, record } = options;
  check(document?.network === network && typeof request === 'function' && typeof reservation === 'function' && typeof record === 'function', 'financial_source_config');
  installTickerPaymentSources(reads, options);
  reads.feeQuotes.document = document;
  reads.identifyFinancialFees = (fees, rail, custody = []) => identifyFinancialFees(fees, { network, rail, bitcoinNetwork, escrow, custody });
  for (const [rail, address] of Object.entries(suspense)) payoutAddress(rail, address, bitcoinNetwork);
  reads.financialFeePlan = ({ split, destinations, beneficiaries = {}, id, payer, rail }) => {
    const plan = beneficiaryFeePlan({ split, destinations, beneficiaries, requestId: id ?? null, payer, rail, bitcoinNetwork, suspense });
    return { fees: reads.identifyFinancialFees(plan.fees, rail, plan.credits), custody: plan.credits };
  };
  const originalSettingsHistory = reads.feeQuotes.settingsHistory;
  reads.financialSettings = async hash => {
    let selected = await (reads.settingsByHash ? reads.settingsByHash(hash) : originalSettingsHistory ? originalSettingsHistory.get(hash) : rules.hashObject(document) === hash ? document : null);
    // Live Trac state has the current document but no history entry for the activation document; accept the
    // current document from Trac when its hash is exactly the one asked for.
    if (!selected && reads.rulesContext) { const current = (await reads.rulesContext())?.settings; if (current && rules.hashObject(current) === hash) selected = current; }
    check(selected && rules.hashObject(selected) === hash && selected.network === network, 'financial_settings_history');
    return rules.validateSettingsDocument(selected);
  };
  reads.feeQuotes.settingsHistory ??= { get: reads.financialSettings };
  const signedRequest = async id => {
    const row = await request(id), r = row?.request;
    const imported = await record('fi/source/' + id);
    if (imported?.legacy?.kind === 'link') {
      check(same(imported.legacy.binding, legacyLinkBinding(row)), 'financial_legacy_link_binding'); return row;
    }
    if (r?.kind === 'link') return reads.verifyFinancialLinkRow(row);
    check(row?.id === id && financialMintId(network, r) === id && verifyFinancialMintRequest(network, r, row.signature, r.until) &&
      typeof row.receiver === 'string' && rules.hash(row.receiver) === r.receive && verifyPayer(network, { ...row, feeQuote: row.requestedFeeQuote }), 'financial_request_signature');
    if (imported?.legacy) check(same(imported.legacy.binding, legacyMintBinding(row)), 'financial_legacy_binding');
    else check(same(row.requestedFeeQuote, row.quote.feeQuote), 'financial_quote_binding');
    return row;
  };
  const recordKey = key => {
    check(/^(?:(?:ar|al|ao|fp|fc|fl|bc|fd|dc|fr|fq|fm|fi)\/[a-z0-9:._/-]+|k\/link\/[0-9a-z]+|bt\/(?:last|observation)|br\/[0-9a-f]{64}\/[a-z0-9:/]+|b\/[a-z0-9/]+|s\/beaconRecovery|recoveryApproved\/[0-9a-f]{64})$/.test(key), 'financial_record_key');
  };
  reads.financialRecord = async (key, at) => {
    recordKey(key);
    return await record(key, at) ?? null;
  };
  reads.financialRecords = async (keys, at) => {
    pointBatch(keys); keys.forEach(recordKey);
    if (options.recordMany) {
      const rows = await options.recordMany(keys, at);
      check(Array.isArray(rows) && rows.length === keys.length, 'point_read_batch');
      return rows.map(row => row ?? null);
    }
    const rows = await pointResults(keys, key => reads.financialRecord(key, at));
    return rows.map(row => { if (row.error) throw Error(row.error); return row.value; });
  };
  reads.financialReservation = async (row, at) => {
    check(recoveryVersion === 2, 'financial_permit_recovery_required');
    const r = row.request, id = row.id;
    check(financialMintId(network, r) === id && verifyFinancialMintRequest(network, r, row.signature, r.until) &&
      rules.hash(row.receiver) === r.receive && verifyPayer(network, { ...row, feeQuote: row.requestedFeeQuote }), 'financial_request_signature');
    check(same(row.requestedFeeQuote, row.quote.feeQuote), 'financial_quote_binding');
    const terms = await reads.feeQuotes.accepted(row.feeAuthorization, mintFeeScope(r.asset, r.block, row.kind), id, r.expires);
    const counted = at?.counted ?? await reads.counted(), original = await reads.financialSettings(r.settingsHash ?? rules.hashObject(document)), v = original.values;
    check(!rules.multiTickerActive(at?.executionHeight ?? counted) || row.quote.feeQuote.settingsHash, 'financial_settings_required');
    check((r.v !== 2 || r.settingsHash === rules.hashObject(original)) &&
      (!row.quote.feeQuote.settingsHash || row.quote.feeQuote.settingsHash === r.settingsHash && terms.settingsHash === r.settingsHash), 'financial_settings');
    check(rules.ordinalCodec(typeof counted === 'string').valid(r.until) && rules.compareOrdinal(counted, r.until) <= 0 && BigInt(r.expires) - BigInt(counted) >= BigInt(v.requestMinBlocks) && BigInt(r.expires) - BigInt(counted) <= BigInt(v.requestMaxBlocks), 'financial_request_expiry');
    check(!r.deployment || rules.multiTickerActive(at?.executionHeight ?? counted), 'multi_ticker_inactive');
    const context = await reads.assetContext(r.asset, r.block, at, row.quote.feeQuote, undefined, r.deployment), d = context?.deployment;
    check(d?.active && d.decimals === 0 && d.privilegePublicKey === (await reads.authority()).committee && ['dmt', 'compound'].includes(d.kind), 'financial_deployment');
    check(!d.officialDeployment || r.deployment === d.id, 'financial_deployment_choice');
    check((d.kind === 'dmt') === Object.hasOwn(r, 'block') && d.id === row.quote.feeQuote.deploymentId, 'financial_deployment_binding');
    check(BigInt(d.remaining) >= BigInt(r.amount) && (!d.limit || d.limit === '0' || BigInt(r.amount) <= BigInt(d.limit)), 'financial_capacity');
    const holder = context.link ? context.bitmapHolder ?? await reads.bitmap(r.block, at) : null;
    if (rules.bitmapMintOpenActive(original, counted) && context.link) check(typeof holder?.address === 'string' && holder.address.length > 0, 'bitmap_missing');
    if (d.kind === 'dmt') {
      check(context.find?.asset === r.asset && rules.decimalV2(context.find.block) === rules.decimalV2(r.block) && String(context.find.count) === r.amount, 'financial_find');
      check(rules.mintRight({ find: context.find, owner: r.owner, counted, link: context.link, currentHolder: holder?.agent, finderWindow: v.finderWindow, settings: original }).allowed, 'financial_mint_right');
      check(await reads.isMinted(d.id, d.tick, r.block, at) === false, 'financial_already_minted');
    }
    const kind = d.kind === 'dmt' ? 'find' : 'compound';
    const price = rules.feeFor(kind, terms.baseFee, context.tier, terms.feeSettings, at?.executionHeight ?? counted);
    const options = { kind, linked: !!holder, discovered: !!(row.quote.feeQuote.settingsHash ? context.beneficiaries?.discoverer ?? context.discoverer : context.discoverer) };
    const baseSplit = row.quote.feeQuote.settingsHash ? financialSplit(price, options, original) : rules.splitFee(price, options);
    const { split, legacyDeploy, deployer } = rules.deploymentHolderFee(price, baseSplit, { kind, deployment: d,
      document: row.quote.feeQuote.settingsHash ? original : null, height: at?.executionHeight ?? counted, bitcoinNetwork });
    const destinations = { treasury: context.treasury, finder: context.finderAddress ?? null, firstMaker: context.firstMakerAddress ?? null,
      landowner: row.kind === 'ethereum' ? context.landownerAddress ?? null : holder?.address ?? null, discoverer: context.discoverer ?? null };
    const plan = row.quote.feeQuote.settingsHash ? reads.financialFeePlan({ split, destinations, beneficiaries: context.beneficiaries, id, payer: row.payer, rail: row.kind }) :
      { fees: reads.identifyFinancialFees(rules.mintFeeItems(split, destinations, id, row.payer, row.kind, bitcoinNetwork), row.kind), custody: [] }, items = plan.fees;
    check(same(items, row.quote.fees) && price === row.quote.price && same(context.payouts, row.quote.feeQuote.payouts), 'financial_fee_destinations');
    const generation = await reads.financialRecord(d.officialDeployment ? 'fd/external/' + rules.hashObject(d.id) : 'fd/asset/' + r.asset, at), registered = generation && await reads.financialRecord('fd/' + generation, at);
    check(generation === financialGenerationId(network, r.asset, d.id) && registered?.deployment === d.id, 'financial_deployment_pending');
    // The quote pins this source snapshot. Accepted capacity counters enforce
    // competition between requests even when they share the same snapshot.
    return { version: 2, requestId: id, owner: r.owner, asset: r.asset, amount: r.amount, receiver: row.receiver, payer: row.payer, rail: row.kind,
      request: r, signature: row.signature, authorization: row.authorization, quote: row.quote.feeQuote, feeAuthorization: row.feeAuthorization,
      deployment: immutableDeployment(d), capacity: { deployment: d.id, asset: r.asset, amount: r.amount, block: r.block ?? null, remaining: d.remaining, limit: d.limit ?? '0',
        ...(rules.tickerSupplyScope(d, at?.executionHeight ?? counted) ? { supplyScope: d.id } : {}) }, generationCapacity: { deployment: generation, plot: r.block === undefined ? null : rules.decimalV2(r.block) }, fees: financialFees(items), feeItems: items,
      ...(legacyDeploy ? { legacyDeploy } : {}), ...(deployer ? { deployer } : {}), custody: plan.custody, find: context.find ?? null, link: context.link ?? null, holder, expiry: r.expires, settingsHash: rules.hashObject(original) };
  };
  const accepted = async (id, at) => {
    const publicSource = await reads.financialRecord('fi/source/' + id, at);
    if (publicSource?.publicMint) {
      const { source, funding } = await reads.publicMintPermit(id, at);
      return { source, funding, row: { ...await request(id), id, request: source.request, payer: source.payer, receiver: source.receiver, kind: 'tap', quote: { fees: source.feeItems } } };
    }
    const row = await signedRequest(id), funding = await reads.financialRecord('fp/' + id, at);
    const source = await reads.financialRecord('fi/source/' + id, at) ?? await reservation(id, at);
    check(funding && source?.requestId === id && rules.hashObject(source) === funding.terms && same(source.request, row.request) &&
      source.receiver === row.receiver && source.payer === row.payer && source.rail === row.kind &&
      same(source.quote, source.legacy ? row.quote.feeQuote : row.requestedFeeQuote) &&
      (source.legacy || source.settingsHash === row.request.settingsHash && source.quote.settingsHash === source.settingsHash), 'financial_accepted_terms');
    if (source.legacy) check(row.kind === 'tap' ? source.legacy.domain.network === bitcoinNetwork : same(source.legacy.domain, escrow), 'financial_legacy_domain');
    return { row, funding, source };
  };
  installCapacitySources(reads, { network, bitcoinNetwork, accepted });
  installCreditSources(reads, { network });
  installCustodySources(reads, { network, bitcoinNetwork, accepted, payout, ethereumRPC });
  installRecoverySources(reads);
  installLinkSources(reads, { network, bitcoinNetwork, financialFees, accepted });
  installLegacyLinkSources(reads, { network, accepted });
  reads.financialEscrow = async (id, references, at) => {
    const { row, source } = await accepted(id, at);
    check(row.kind === 'ethereum' && escrow && Array.isArray(references) && references.length > 0 && references.length <= (await reads.financialSettings(source.settingsHash)).values.paymentPage && new Set(references).size === references.length &&
      references.every(r => /^0x[0-9a-f]{64}$/.test(r)), 'financial_payment_rail');
    const s = await reads.escrowDeposit(row.payer, id, { transactionIds: references }), d = s.deposit;
    check(s.chainId === escrow.chainId && s.address === escrow.address.toLowerCase() && s.token === escrow.token.toLowerCase() &&
      s.requestId === id && s.payer === row.payer.toLowerCase() && d.payer === row.payer.toLowerCase() && s.confirmations >= 1 &&
      same(d.split, escrowSplitForItems(source.feeItems)) && d.amount === source.feeItems.reduce((n, f) => n + BigInt(f.amount), 0n).toString(), 'financial_escrow_domain');
    return s;
  };
  reads.financialReceipts = async (id, references, at) => {
    const { row, source } = await accepted(id, at);
    check(Array.isArray(references) && references.length > 0 && references.length <= (await reads.financialSettings(source.settingsHash)).values.paymentPage && new Set(references).size === references.length, 'financial_receipt_references');
    if (source.legacy?.kind === 'link') return reads.financialLegacyLinkReceipts(id, references, at);
    const candidate = { ...row, quote: { ...row.quote, fees: source.feeItems } };
    if (row.kind === 'tap') return tapReceipts(reads, candidate, references, lookupSettings, { at, confirmedOnly: true });
    check(row.kind === 'ethereum' && escrow, 'financial_payment_rail');
    const hint = { transactionIds: references }, s = await reads.financialEscrow(id, references, at), d = s.deposit;
    check(s.chainId === escrow.chainId && s.address === escrow.address.toLowerCase() && s.token === escrow.token.toLowerCase() &&
      s.requestId === id && s.payer === row.payer.toLowerCase() && d.payer === row.payer.toLowerCase(), 'financial_escrow_domain');
    check(d.status === 2 && s.confirmations >= 1 && same(d.split, escrowSplitForItems(source.feeItems)) &&
      d.amount === source.feeItems.reduce((n, f) => n + BigInt(f.amount), 0n).toString(), 'financial_escrow_unsettled');
    const event = await reads.escrowSettled(row.payer, id, hint);
    check(event?.kind === 'claim' && event.confirmations >= 1 && event.requestId === id && event.payer === row.payer.toLowerCase(), 'financial_escrow_release');
    return source.feeItems.map(f => ({ ...f, key: rules.paymentItemKey('ethereum', [escrow.chainId, escrow.address.toLowerCase(), row.payer.toLowerCase(), id, f.role].join('/')),
      amount: f.amount, accepted: true, confirmations: 1, origin: id, reference: event.transactionHash,
      ethereumAnchor: { chainId: escrow.chainId, height: BigInt(event.blockNumber).toString(), hash: event.blockHash.toLowerCase() } }));
  };
  reads.financialPermit = async (id, at, { consumed = false } = {}) => {
    if (reads.financialChainAnchor) await reads.financialChainAnchor({ at, prior: await reads.financialRecord('fp/chain', at) });
    check(recoveryVersion === 2, 'financial_permit_recovery_required');
    const { row, funding, source } = await accepted(id, at), obligation = await reads.financialRecord('ao/' + id, at);
    check(funding.state === (consumed ? 'consumed' : 'open') && obligation?.state === (consumed ? 'consumed' : 'reserved') &&
      funding.fees.every((f, i) => f.amount === funding.paid[i]), 'financial_funding_incomplete');
    const root = financialPaymentHash(funding);
    if (!consumed) {
      const registry = await reads.registry(), current = registry.assets[row.request.asset];
      const entry = typeof registry.asset === 'function' ? registry.asset(row.request.asset, source.deployment.id) : current?.id === source.deployment.id ? current : null;
      check(entry, 'financial_deployment_missing');
      const verified = await verifyDeployment(reads, entry, { view: at });
      check(verified.authorityKey === source.deployment.privilegePublicKey, 'financial_deployment_authority');
      const outstanding = BigInt(await reads.financialRecord(capacityKey(entry.id), at) ?? '0') + BigInt(await reads.financialRecord('fi/deployment/' + entry.id, at) ?? '0');
      check(outstanding >= BigInt(row.request.amount) && outstanding <= BigInt(await reads.tap('getMintTokensLeft/' + (entry.indexTick ?? entry.tick))), 'financial_capacity');
    }
    // Permanent permit identity commits to all accepted pages, not a bounded
    // reconstruction of the payer's lifetime transaction history.
    const plan = permit(network, row.request, source.deployment, row.receiver, id, root);
    if (consumed) check(funding.permitHash === plan.digest && obligation.permitHash === plan.digest, 'financial_consumption_binding');
    return { row, source, funding, permit: plan };
  };
  reads.financialEvidence = async (transition, at) => {
    const t = transition;
    if (t.type === 'public-scan') return reads.publicMintScan(t, at);
    if (t.type === 'public-payment') return reads.publicMintPayment(t, at);
    if (t.type === 'beacon-recovery') return reads.financialBeaconEvidence(t.operation, at);
    if (t.type === 'lifecycle') {
      if (t.action.type === 'ticker-refund') return reads.tickerRefundEvidence(t.action, at);
      if (t.action.type.startsWith('legacy-link-')) return reads.financialLegacyLinkEvidence(t.action, at);
      if (['credit-use', 'credit-transfer'].includes(t.action.type)) return reads.financialCreditEvidence(t.action, at);
      if (t.action.type.startsWith('custody-')) return reads.financialCustodyEvidence(t.action, at);
      if (t.action.type.startsWith('recovery-')) return reads.financialRecoveryEvidence(t.action, at);
      return t.action.type.startsWith('link-') ? reads.financialLinkEvidence(t.action, at, t.action.type === 'link-reserve' ? await signedRequest(t.id) : null) : reads.financialCapacityEvidence(t.action, at);
    }
    if (t.type === 'reserve') return reads.financialReservation(await signedRequest(t.id), at);
    const { row, funding, source } = await accepted(t.id, at), base = { requestId: t.id, owner: funding.owner, terms: funding.terms };
    if (['fund', 'surplus'].includes(t.type)) {
      check(Array.isArray(t.items) && t.items.length > 0, 'financial_payment_items');
      const receipts = await reads.financialReceipts(t.id, t.references, at), byKey = new Map(receipts.map(r => [r.key, r]));
      for (const item of t.items) {
        const receipt = byKey.get(item.key);
        check(receipt?.accepted && receipt.confirmations >= 1 && receipt.origin === t.id && receipt.amount === item.total && feeKey(receipt) === item.fee &&
          /^[1-9][0-9]*$/.test(item.amount) && BigInt(item.amount) <= BigInt(receipt.amount), 'financial_receipt_binding');
      }
      const link = row.request.kind === 'link' || source.legacy?.kind === 'link';
      const heights = link ? t.items.map(item => rules.uintV2(byKey.get(item.key).verifiedHeight)) : [];
      const paymentFacts = t.items.map(item => {
        const receipt = byKey.get(item.key);
        return { key: item.key, reference: receipt.reference ?? null, height: receipt.verifiedHeight ?? receipt.ethereumAnchor?.height ?? null,
          ...(receipt.ethereumAnchor ? { anchor: receipt.ethereumAnchor } : {}) };
      });
      return { ...base, items: t.items, paymentFacts, state: 'settled', confirmations: 1,
        ...(row.kind === 'ethereum' ? { ethereumAnchor: receipts[0].ethereumAnchor } : {}),
        ...(link ? { verifiedHeight: heights.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b) } : {}) };
    }
    if (t.type === 'consume') {
      const { permit: p } = await reads.financialPermit(t.id, at);
      return { ...base, state: 'authorized', permitHash: p.digest, fundingRoot: funding.root, recoveryVersion: 2 };
    }
    check(t.type === 'refund' && funding.state === 'open', 'financial_exit_state');
    if (t.reason === 'credit') {
      check(rules.compareOrdinal(at?.counted ?? await reads.counted(), source.expiry) > 0, 'financial_exit_live');
      return { ...base, state: 'credit', expiry: source.expiry };
    }
    check(t.reason === 'ethereum_refund' && row.kind === 'ethereum' && escrow, 'financial_refund_rail');
    const hint = { transactionIds: t.references }, s = await reads.financialEscrow(t.id, t.references, at), d = s.deposit;
    check(s.chainId === escrow.chainId && s.address === escrow.address.toLowerCase() && s.token === escrow.token.toLowerCase() &&
      s.requestId === t.id && s.payer === row.payer.toLowerCase() && d.payer === row.payer.toLowerCase() && d.status === 3 && s.confirmations >= 1 &&
      same(d.split, escrowSplitForItems(source.feeItems)) && d.amount === source.feeItems.reduce((n, f) => n + BigInt(f.amount), 0n).toString(), 'financial_refund_domain');
    const event = await reads.escrowSettled(row.payer, t.id, hint);
    check(event?.kind === 'refund' && event.confirmations >= 1 && event.requestId === t.id && event.payer === row.payer.toLowerCase(), 'financial_refund_unproven');
    return { ...base, state: 'ethereum_refund', rail: 'ethereum', confirmations: 1, status: 3, payer: row.payer,
      domain: { chainId: escrow.chainId, address: s.address, token: s.token }, transaction: event.transactionHash, block: event.blockHash,
      ethereumAnchor: { chainId: escrow.chainId, height: BigInt(event.blockNumber).toString(), hash: event.blockHash.toLowerCase() } };
  };
  // Normalize the execution anchor once and fence every independent read with
  // the same accepted notary revision and Bitcoin/TAP source snapshot.
  installPublicMintSources(reads, { network, bitcoinNetwork, lookupSettings });
  for (const name of ['financialReservation', 'financialReceipts', 'financialPermit', 'financialEscrow', 'financialEvidence', 'financialDeployment', 'financialDeploymentState', 'financialLinkReservation', 'financialLinkQuote', 'publicMintScan', 'publicMintPayment', 'publicMintPermit']) {
    const original = reads[name], index = ['financialReceipts', 'financialEscrow'].includes(name) ? 2 : 1;
    reads[name] = async (...args) => {
      const before = await reads.batchStamp(), at = args[index];
      check(!at || rules.compareOrdinal(at.counted, before.counted) === 0 && same(at.last, before.last) && (at.revision === undefined || at.revision === before.revision), 'financial_snapshot_changed');
      args[index] = at?.executionHeight === undefined ? before : { ...before, executionHeight: at.executionHeight };
      const result = ['publicMintScan', 'publicMintPayment'].includes(name) && reads.withTapSnapshot ?
        await reads.withTapSnapshot(before, () => original(...args)) : await original(...args);
      check(same(before, await reads.batchStamp()), 'financial_snapshot_changed');
      return result;
    };
  }
  // Rebuild closures over a batch-local view. Each verifier supplies only its
  // own already-verified effects; concurrent requests keep the original view.
  reads.financialScope = ({ record, reservations }) => installFinancialSources({ ...reads }, { ...options, record, recordMany: undefined,
    reservation: (id, at) => reservations.has(id) ? reservations.get(id) : reservation(id, at) });
  return reads;
}
