import { gatewayRowsRoot, iterableRoot, migrationGatewayRows, pendingRows } from './migration-pages.mjs';
import { rules as r } from './rules.mjs';
import { check } from './util.mjs';
import { verifyPayer } from './mints.mjs';
import { financialFeeKey, identifyFinancialFees } from './financial-fee-identity.mjs';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { EMPTY_ALLOCATION_ROOT } from '../../contract/payment-pages.js';
import { FeeQuotes, mintFeeScope, mintOwnershipMatches, QUOTE_BLOCKS, QUOTE_MILLISECONDS } from './fees.mjs';

const ordered = rows => [...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
export const terminalRecordsRoot = records => iterableRoot('dmw-legacy-notary-v1', records.orderedEntries?.() ?? ordered(records));
export const financialMigrationRoot = plan => r.hashObject(['dmw-pending-financial-v1', plan]);
export const legacyMintBinding = row => ({ id: row.id, request: row.request, signature: row.signature, receiver: row.receiver,
  payer: row.payer, kind: row.kind, authorization: row.authorization, requestedFeeQuote: row.requestedFeeQuote,
  quote: row.quote, feeAuthorization: row.feeAuthorization });
export const legacyLinkBinding = row => ({ id: row.id, request: row.request, signature: row.signature, payer: row.payer,
  receiver: row.receiver, kind: row.kind, requestedFeeQuote: row.requestedFeeQuote, quote: row.quote, feeAuthorization: row.feeAuthorization, legacyLink: row.legacyLink });

// Offline conversion only. All original rows remain in the imported archive.
// The terminal manifest authenticates these derived records, including the
// exact legacy signatures/terms; runtime readers fetch them from the notary.
export function prepareFinancialMigration({ rows, records, snapshot, network, document, height, gateway }) {
  rows = pendingRows(rows);
  check(snapshot?.version === 2 && snapshot.height === height && document.network === network, 'pending_financial_snapshot');
  check(r.hex(gateway, 32), 'pending_financial_gateway');
  const quotes = new FeeQuotes({ network, gateway });
  const mints = new Map(rows.filter(([s]) => s === 'mints').map(([, id, row]) => [id, row]));
  const writes = [], derived = new Map(), covered = new Set(), capacities = new Map();
  const put = (key, value) => { check(!derived.has(key), 'pending_financial_collision'); derived.set(key, value); };
  const write = (space, id, value) => writes.push({ space, id, value });
  for (const [id, identity] of ordered(snapshot.requests)) {
    const row = mints.get(id), raw = records.get('m/' + id), request = row?.request;
    check(row && row.id === id && raw && r.stableJSON(identity.request) === r.stableJSON(request) &&
      identity.signature === row.signature && identity.receiver === row.receiver &&
      identity.payment.rail === row.kind && identity.payment.payer === row.payer &&
      r.stableJSON(identity.deployment) === r.stableJSON({ ...row.context.deployment, asset: request.asset }), 'pending_financial_identity');
    check(verifyPayer(network, { ...row, feeQuote: row.requestedFeeQuote }) &&
      (!row.requestedFeeQuote || r.stableJSON(row.requestedFeeQuote) === r.stableJSON(row.quote.feeQuote)) &&
      r.stableJSON(row.feeAuthorization?.quote) === r.stableJSON(row.quote.feeQuote), 'pending_financial_authorization');
    const q = quotes.verify('dmw-fee-quote-v1', row.quote.feeQuote), a = quotes.verify('dmw-fee-acceptance-v1', row.feeAuthorization);
    check(!q.settingsHash && q.network === network && q.scope === mintFeeScope(request.asset, request.block, row.kind) &&
      a.network === network && a.id === id && a.until === request.expires && a.counted >= q.validFrom && a.until > a.counted && a.until <= q.validUntil &&
      q.validUntil === q.validFrom + QUOTE_BLOCKS && q.expiresAt === q.issuedAt + QUOTE_MILLISECONDS && a.at >= q.issuedAt && a.at <= q.expiresAt,
    'pending_financial_quote');
    check(row.quote.baseFee === q.baseFee && r.stableJSON(row.quote.feeSettings) === r.stableJSON(q.feeSettings ?? r.FEE_DEFAULTS) &&
      row.quote.price === r.feeFor(identity.deployment.kind === 'dmt' ? 'find' : 'compound', q.baseFee, row.context.tier, q.feeSettings), 'pending_financial_price');
    const context = row.context, holder = context.bitmapHolder ?? identity.bitmap ?? null;
    check(!context.link || holder, 'pending_financial_bitmap');
    check(!q.mintOwnershipHash || mintOwnershipMatches(q, { bitmap: holder, link: context.link ?? null, assetRevision: context.assetRevision }), 'pending_financial_ownership');
    const split = r.splitFee(row.quote.price, { kind: identity.deployment.kind === 'dmt' ? 'find' : 'compound', linked: !!holder, discovered: !!context.discoverer });
    const destinations = { treasury: context.treasury, finder: context.finderAddress ?? null, firstMaker: context.firstMakerAddress ?? null,
      landowner: row.kind === 'ethereum' ? context.landownerAddress ?? null : holder?.address ?? null, discoverer: context.discoverer ?? null };
    check(r.stableJSON(row.quote.split) === r.stableJSON(split) && r.stableJSON(row.quote.destinations) === r.stableJSON(destinations) &&
      r.stableJSON(row.quote.fees) === r.stableJSON(r.mintFeeItems(split, destinations, id, row.payer, row.kind, network === 'dmw-mainnet' ? 'mainnet' : 'regtest')) &&
      r.stableJSON(q.payouts) === r.stableJSON(context.payouts), 'pending_financial_fee_plan');
    check(Array.isArray(row.quote.fees) && row.quote.fees.length > 0 && row.quote.fees.every(f => /^[1-9][0-9]*$/.test(f.amount)), 'pending_financial_fees');
    check(['dmw-mainnet', 'dmw-regtest'].includes(network), 'pending_financial_network');
    const feeItems = identifyFinancialFees(row.quote.fees, { network, rail: row.kind, bitcoinNetwork: network === 'dmw-mainnet' ? 'mainnet' : 'regtest', escrow: snapshot.escrow });
    const fees = feeItems.map(f => ({ key: financialFeeKey(f), amount: f.amount })), consumed = raw.s === 1, live = raw.s === 0 && (raw.h || height <= raw.e);
    check(!row.permit || consumed && r.stableJSON(row.permit) === r.stableJSON(identity.permit), 'pending_financial_permit');
    const source = { version: 2, legacy: { version: 1, binding: legacyMintBinding(row), paymentHash: consumed ? raw.paymentHash : null,
      domain: row.kind === 'ethereum' ? snapshot.escrow : { network: network === 'dmw-mainnet' ? 'mainnet' : 'regtest' } },
      requestId: id, owner: request.owner, asset: request.asset, amount: request.amount, receiver: row.receiver, payer: row.payer,
      rail: row.kind, request, signature: row.signature, authorization: row.authorization, quote: row.quote.feeQuote,
      feeAuthorization: row.feeAuthorization, deployment: identity.deployment, fees, feeItems,
      custody: [], expiry: request.expires, settingsHash: r.hashObject(document) };
    const terms = r.hashObject(source), outstanding = live || consumed && !identity.terminal;
    const capacity = { deployment: identity.deployment.id, asset: request.asset, amount: request.amount,
      block: request.block ?? null, remaining: identity.deployment.remaining, limit: identity.deployment.limit ?? '0' };
    check(!outstanding || /^(0|[1-9][0-9]*)$/.test(capacity.remaining), 'pending_financial_capacity');
    put('fi/source/' + id, source);
    put('fp/' + id, { owner: request.owner, terms, fees, paid: fees.map(f => consumed ? f.amount : '0'), sequence: '0',
      root: EMPTY_ALLOCATION_ROOT, state: consumed ? 'consumed' : live ? 'open' : 'credited',
      ...(outstanding ? { capacity } : {}),
      ...(identity.terminal ? { minted: identity.terminal.evidence } : {}),
      ...(consumed ? { permitHash: raw.permitHash, consumedRoot: EMPTY_ALLOCATION_ROOT, legacyPaymentHash: raw.paymentHash } : {}) });
    put('ao/' + id, { state: consumed ? 'consumed' : live ? 'reserved' : 'refunded', owner: request.owner, asset: request.asset,
      amount: request.amount, terms, legacy: raw, ...(consumed ? { permitHash: raw.permitHash } : {}) });
    if (outstanding) {
      const key = capacityKey(capacity.deployment);
      capacities.set(key, (capacities.get(key) ?? 0n) + BigInt(request.amount));
      if (capacity.block !== null) put(plotKey(capacity.asset, capacity.block, capacity.supplyScope), { id, state: 'reserved' });
    }
    if (identity.terminal && capacity.block !== null) put(plotKey(capacity.asset, capacity.block, capacity.supplyScope), { id, state: 'minted' });
    // References are hints only. Every post-activation funding page checks
    // canonical source receipts and the imported global usage root again.
    const references = [...new Set(identity.payment.ids)];
    check(!live || references.length <= document.values.paymentPage, 'pending_financial_reference_paging_required');
    if (!live && references.length) write('financialLegacyCredits', id, { references, offset: 0 });
    write('mints', id, { ...row, expiry: request.expires, state: identity.terminal ? 'minted' : row.permit ? 'permit_issued' : consumed ? 'paid' : live ? 'awaiting_payment' : 'expired',
      ...(references.length ? { [row.kind === 'ethereum' ? 'ethereumReferences' : 'paymentReferences']: references } : {}) });
    if (outstanding) {
      write(row.permit ? 'financialIssuedMints' : 'financialActiveMints', id, true);
      if (!row.permit) write('financialMintOwner/' + request.owner, id, true);
    }
    covered.add(id);
  }
  for (const [key, value] of capacities) put(key, value.toString());
  // Absence of a notary reservation is not permission to invent an accepted
  // debit. These packets need the separate admission adapter.
  check([...mints].every(([id, row]) => covered.has(id) || row.state === 'minted'), 'pending_financial_unaccepted_reservation');
  for (const [space, id, value] of rows) {
    if (/^(?:activeMints|expiredMints|issuedMints)$/.test(space))
      check(covered.has(id), 'pending_financial_queue_coverage');
    if (/^(?:mintInputs|mintDeferred)$/.test(space)) check(covered.has(value.id), 'pending_financial_queue_coverage');
    if (space === 'linkObligations') check(value.state === 'completed', 'pending_link_obligation_adapter');
  }
  for (const [space, id, credit] of rows) if (space === 'mintCredits') {
    const row = mints.get(id), raw = records.get('m/' + id);
    check(row && covered.has(id) && credit.owner === row.request.owner && credit.payer === row.payer && credit.rail === row.kind &&
      (raw.s !== 0 || !raw.h && height > raw.e), 'pending_credit_binding');
    const references = [...new Set([...(snapshot.requests.get(id).payment.ids), ...(credit.items ?? []).map(item => item.reference).filter(Boolean)])];
    check(references.length > 0, 'pending_credit_references');
    write('financialLegacyCredits', id, { references, offset: 0 });
  }
  for (const [space, id, target] of rows) if (space === 'creditClaims') {
    check(mints.has(id) && mints.has(target), 'pending_credit_claim');
    write('legacyCreditClaims', id, target); writes.push({ space, id });
  }
  const linkRows = new Map(rows.filter(([space]) => space === 'linkIntents').map(([, id, value]) => [id, value]));
  for (const [space, id, value] of rows) if (space === 'linkRequests') linkRows.set(id, value);
  const statuses = new Map(rows.filter(([space]) => space === 'linkStatus').map(([, id, value]) => [id, value]));
  for (const [id, original] of ordered(snapshot.links)) {
    const row = linkRows.get(id);
    check(row && r.stableJSON(row) === r.stableJSON(original) && statuses.get(id)?.state !== 'accepted', 'pending_link_identity');
    const { request, terms } = row, feeQuote = terms.feeAuthorization?.quote;
    check(!terms.chainId, 'pending_link_ethereum_adapter');
    const q = quotes.verify('dmw-fee-quote-v1', feeQuote), a = quotes.verify('dmw-fee-acceptance-v1', terms.feeAuthorization);
    check(r.linkId(network, request) === id && q.network === network && q.scope === 'link/' + id && q.baseFee === terms.baseFee &&
      a.network === network && a.id === id && a.until === request.until && a.counted >= q.validFrom && a.until > a.counted && a.until <= q.validUntil &&
      a.at >= q.issuedAt && a.at <= q.expiresAt, 'pending_link_quote');
    if (r.multiTickerActive(height)) check(terms.settingsHash === r.hashObject(document), 'pending_link_settings');
    const rail = terms.chainId ? 'ethereum' : 'tap', price = r.feeFor('link', terms.baseFee, 1, terms.feeSettings, height), split = r.linkPaymentSplit(price, document, height);
    const feeItems = identifyFinancialFees(r.mintFeeItems(split, { treasury: terms.treasury }, id, terms.payer, rail, network === 'dmw-mainnet' ? 'mainnet' : 'regtest'),
      { network, rail, bitcoinNetwork: network === 'dmw-mainnet' ? 'mainnet' : 'regtest', escrow: snapshot.escrow });
    const normalized = { id, request, signature: row.sig, payer: terms.payer, receiver: terms.payer, kind: rail,
      requestedFeeQuote: feeQuote, feeAuthorization: terms.feeAuthorization, quote: { feeQuote, price, split, fees: feeItems }, legacyLink: original, state: 'awaiting_payment',
      ...(row.paymentId ? { paymentReferences: [row.paymentId] } : {}) };
    const source = { version: 2, requestId: id, request, signature: row.sig, owner: request.owner, receiver: terms.payer, payer: terms.payer, rail,
      block: String(request.height), until: request.until, expiry: request.until, quote: feeQuote, feeItems, fees: feeItems.map(f => ({ key: financialFeeKey(f), amount: f.amount })),
      settingsHash: r.hashObject(document), legacy: { version: 1, kind: 'link', original, binding: legacyLinkBinding(normalized),
        ...(r.multiTickerActive(height) ? { executionHeight: r.decimalV2(height) } : {}),
        domain: rail === 'tap' ? { network: network === 'dmw-mainnet' ? 'mainnet' : 'regtest' } : snapshot.escrow } };
    put('fi/source/' + id, source);
    put('fp/' + id, { owner: request.owner, terms: r.hashObject(source), fees: source.fees, paid: source.fees.map(() => '0'), root: EMPTY_ALLOCATION_ROOT, sequence: '0', state: 'open' });
    write('financialLinks', id, normalized); write('financialPendingLinks', id, true); write('financialLinkOwner/' + request.owner, id, true);
  }
  check([...linkRows].every(([id]) => snapshot.links.has(id) || ['accepted', 'expired'].includes(statuses.get(id)?.state)), 'pending_link_coverage');
  for (const [space, id] of rows) if (/^(?:activeLinks|linkRecovery)$/.test(space))
    check(snapshot.links.has(id) || ['accepted', 'expired'].includes(statuses.get(id)?.state), 'pending_link_queue_coverage');
  for (const [space, id, value] of rows) if (space === 'replay/linkPayments' && value) put('fi/link-payment/' + id, true);
  const state = rows.find(([space, id]) => space === 'meta' && id === 'ruleState')?.[2];
  for (const [id, value] of Object.entries(r.recordObject(state?.linkPayments))) if (value && !derived.has('fi/link-payment/' + id)) put('fi/link-payment/' + id, true);
  check(snapshot.custody.size === 0, 'pending_financial_remaining_adapter');
  const plan = { version: 1, network, height, gateway, sourceRoot: gatewayRowsRoot(rows),
    notaryRoot: terminalRecordsRoot(records), settingsHash: r.hashObject(document), covered: [...covered], records: ordered(derived), writes };
  return { ...plan, root: financialMigrationRoot(plan) };
}

export function verifyFinancialMigration(migration, { rows, records, snapshot, network, document, height, gateway = migration?.gateway }) {
  const expected = prepareFinancialMigration({ rows, records, snapshot, network, document, height, gateway });
  check(migration?.root === expected.root && r.stableJSON(migration) === r.stableJSON(expected), 'pending_financial_reconciliation');
  return expected;
}
