import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';
import { Mints, publicMint } from './mints.mjs';
import { payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { mintAssetDefinition, patternCatalogId } from './mint-assets.mjs';
import { claimedPage } from './claimed-feeds.mjs';
import { projectionReady } from './projection-state.mjs';
import { publicScanKey, publicRefundKey } from '../../contract/public-mint.js';
import { plotKey } from '../../contract/financial-capacity.js';

const refundView = row => ({ ...row, requestId: row.id, paymentId: row.reference });

export class PublicMints {
  constructor(parent) { this.parent = parent; }
  get store() { return this.parent.store; }
  get reads() { return this.parent.reads; }
  get document() { return this.parent.document; }
  active() { const height = rules.decimalV2(this.store.get('meta', 'ruleState')?.counted ?? '0');
    check(rules.publicMintActive(this.document, height), 'public_mint_inactive', 409); return height; }
  state(asset, block, shared) {
    const height = this.active(), catalogAsset = patternCatalogId(asset); check(catalogAsset, 'asset'); block = rules.decimalV2(block);
    projectionReady(this.store, 'claimed2/' + catalogAsset, 'pattern/' + catalogAsset, 'block/' + block);
    const pattern = this.store.get('patternsByAsset', catalogAsset); check(pattern, 'public_index_warming', 503);
    const ledgerAsset = pattern.legacy?.asset ?? catalogAsset, id = rules.publicPlotId(ledgerAsset, block);
    const scan = this.store.get('accountRecords', publicScanKey(id));
    const occurrence = this.store.get('claimed2/' + catalogAsset, rules.uintKeyV2(block));
    const ruleState = this.store.get('meta', 'ruleState');
    const claims = shared ?? new rules.ClaimStorage({ get: key => this.store.get('claimNodes', key), cacheSize: this.document.values.publicMintPageSize }).load(ruleState);
    const slot = rules.findIdV2(block, pattern.number), find = rules.recordGet(claims.finds, slot), reserved = rules.recordGet(claims.claimReservations, slot), draw = rules.recordGet(claims.headerAwards, block);
    const headerAward = !!(draw && BigInt(draw.senderCount) > 0n && BigInt(pattern.number) < BigInt(draw.catalog.nextNumber));
    const minted = this.store.get('minted', ledgerAsset + '/' + block) ?? this.store.get('minted', catalogAsset + '/' + block);
    const right = rules.publicBlockRight({ pattern, block, height, settings: this.document, find, reserved, headerAward, minted });
    const unsettled = claims.rounds.some(round => !round.closed && BigInt(round.window) < BigInt(right.claimDeadline));
    const capacity = this.store.get('accountRecords', plotKey(ledgerAsset, block)) ?? this.store.get('accountRecords', 'fi/plot/' + ledgerAsset + '/' + block);
    let state = minted ? 'minted' : scan?.winner ? this.store.get('mints', scan.winner.id)?.permit ? 'permit_issued' : 'paid' : capacity ? 'already_minted' : right.state;
    if (state === 'public' && (!occurrence || unsettled)) state = 'public_scan_pending';
    return { asset: catalogAsset, ledgerAsset, block, amount: occurrence?.count ?? (find ? String(find.count) : null), claimDeadline: right.claimDeadline,
      state, bitmapHolderOnly: !!this.store.get('links', heightKey(block)), winner: scan?.winner ? { id: scan.winner.id, tapAddress: scan.winner.tapAddress, paymentId: scan.winner.reference } : null,
      refunds: '/public-mints/refunds?asset=' + encodeURIComponent(catalogAsset) + '&block=' + block };
  }
  list(params) {
    this.active();
    for (const key of params.keys()) check(['asset', 'limit', 'cursor'].includes(key), 'public_mint_query');
    const asset = params.get('asset'), limit = Number(params.get('limit') ?? this.document.values.publicMintPageSize);
    check(/^p2:(0|[1-9][0-9]*)$/.test(asset ?? '') && Number.isSafeInteger(limit) && limit > 0 && limit <= this.document.values.publicMintPageSize, 'public_mint_query');
    const query = new URLSearchParams({ limit: String(limit), found: 'false', minted: 'false' });
    if (params.has('cursor')) query.set('cursor', params.get('cursor'));
    const page = claimedPage(this.store, asset, query, { patternDetailRows: this.document.values.publicMintPageSize });
    const claims = new rules.ClaimStorage({ get: key => this.store.get('claimNodes', key), cacheSize: this.document.values.publicMintPageSize }).load(this.store.get('meta', 'ruleState'));
    const rows = page.rows.map(row => this.state(asset, row.block, claims)).filter(row => row.state === 'public');
    return { v: 3, asset, rows, mintRights: rows, total: null, next: page.nextCursor, nextCursor: page.nextCursor };
  }
  async quote(input, start = false) {
    this.active(); check(rules.exactKeys(input, ['asset', 'block', 'tapAddress']), 'public_mint_input');
    const resolved = await mintAssetDefinition(this.store, input.asset), block = rules.decimalV2(input.block);
    const state = this.state(resolved.catalogAsset, block);
    if (state.state !== 'public') throw Object.assign(Error(state.state === 'minted' ? 'already_minted' : state.winner ? 'someone_paid_first' : state.state),
      { status: 409, ...(state.winner ? { publicRefund: { refunds: state.refunds, winner: state.winner } } : {}) });
    check(!this.parent.financial.admissionReady || await this.parent.financial.admissionReady(), 'financial_admission_fenced', 503);
    payoutAddress('tap', input.tapAddress, this.parent.bitcoinNetwork);
    const needed = await Mints.prototype.deploymentNeeded.call(this.parent, resolved.asset, { block, receiver: input.tapAddress, kind: 'tap' });
    if (needed) return { ...needed, publicMint: true, reservation: 'none', claimDeadline: state.claimDeadline };
    const generation = await this.reads.financialDeployment(resolved.asset, await this.reads.batchStamp());
    if (!generation.existing) {
      await this.parent.financial.submit({ type: 'lifecycle', id: generation.id, action: generation.action });
      return { id: null, requestId: null, asset: resolved.catalogAsset, block, receiver: input.tapAddress, kind: 'tap', publicMint: true,
        state: 'deployment_pending', payable: false, reservation: 'none', fees: [], missing: [], claimDeadline: state.claimDeadline };
    }
    const q = await this.reads.publicMintQuote({ asset: resolved.asset, block, tapAddress: input.tapAddress }, await this.reads.batchStamp());
    const row = { id: q.id, publicMint: true, catalogAsset: resolved.catalogAsset, intent: q.intent, receiver: input.tapAddress, payer: input.tapAddress, kind: 'tap',
      request: { asset: resolved.asset, block, amount: q.amount, expires: q.feeQuote.validUntil }, expiry: q.feeQuote.validUntil, created: q.feeQuote.validFrom,
      quote: { ...q, payableAmount: q.fees.reduce((n, f) => n + BigInt(f.amount), 0n).toString(), baseFee: q.feeQuote.baseFee,
        feeSettings: q.feeQuote.feeSettings, actualTicker: q.deployment.tick, deploymentId: q.deployment.id },
      context: { deployment: q.deployment }, state: 'awaiting_payment', paymentIds: [] };
    if (!start) return { ...publicMint(row), id: null, requestId: null, payable: false, reservation: 'none', claimDeadline: q.claimDeadline };
    check(this.store.count('publicMintRequests') < this.parent.resources.activeMints || this.store.get('mints', row.id), 'mint_capacity', 503);
    const plot = rules.publicPlotId(resolved.asset, block);
    if (!this.store.get('mints', row.id)) await this.store.transact([{ space: 'mints', id: row.id, value: row }, { space: 'publicMintRequests', id: row.id, value: true },
      { space: 'publicMintPlots', id: plot, value: { asset: resolved.asset, block } }]);
    return this.public(row.id);
  }
  public(id) {
    const row = this.store.get('mints', id); check(row?.publicMint, 'request_not_found', 404);
    const scan = this.store.get('accountRecords', publicScanKey(rules.publicPlotId(row.request.asset, row.request.block)));
    const refunds = this.store.list('publicMintRefundsByRequest/' + id, { limit: this.document.values.publicMintPageSize }).map(r => refundView(r.value));
    const lost = !!scan?.winner && scan.winner.id !== id, state = row.permit ? row.state : refunds.length && scan?.winner?.id !== id ? 'refundable' : lost ? 'someone_paid_first' : row.state;
    const expired = BigInt(this.store.get('meta', 'ruleState')?.counted ?? row.created) > BigInt(row.expiry);
    return { ...publicMint(row), payer: row.payer, state, reservation: 'none', unitsConsumed: false, publicMint: true, catalogAsset: row.catalogAsset,
      payable: !expired && !row.permit && !scan?.winner && !refunds.length && !row.paymentIds.length,
      claimDeadline: row.quote.claimDeadline, refunds, winner: scan?.winner ? { id: scan.winner.id, tapAddress: scan.winner.tapAddress } : null,
      reason: lost ? 'someone_paid_first' : row.reason ?? null, paymentPage: '/mint/' + id };
  }
  async payment({ id, requestId, paymentId, paymentIds = [], inscription }) {
    id ??= requestId; const row = this.store.get('mints', id); check(row?.publicMint, 'request_not_found', 404);
    if (inscription) {
      check(row.permit && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(inscription), 'mint_inscription');
      await this.store.put('mints', id, { ...row, mintInscription: inscription });
    } else {
      const ids = [...new Set([...(row.paymentIds ?? []), ...(paymentId ? [paymentId] : []), ...paymentIds])];
      check(ids.length > 0 && ids.length <= this.document.values.paymentPage && ids.every(id => /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(id)), 'payment_id');
      await this.store.put('mints', id, { ...row, paymentIds: ids, state: 'scanning' });
    }
    return this.public(id);
  }
  refunds(params) {
    this.active(); for (const key of params.keys()) check(['asset', 'block', 'tapAddress', 'limit', 'cursor'].includes(key), 'public_refund_query');
    const limit = Number(params.get('limit') ?? this.document.values.publicMintPageSize);
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= this.document.values.publicMintPageSize, 'page_limit');
    const scope = params.get('tapAddress') ? 'publicMintRefundsByAddress/' + rules.hash(params.get('tapAddress')) : 'publicMintRefunds';
    const after = params.get('cursor') ?? ''; check(!after || rules.hex(after, 32), 'page_cursor');
    const raw = this.store.list(scope, { after, limit: limit + 1 }), rows = raw.slice(0, limit).map(r => ({ ...refundView(r.value), refundId: r.id })).filter(r =>
      (!params.has('asset') || patternCatalogId(r.asset) === params.get('asset')) && (!params.has('block') || r.block === params.get('block')));
    const next = raw.length > limit ? raw[limit - 1].id : null;
    return { v: 3, rows, total: null, next, nextCursor: next };
  }
  async releaseFinishedRequests(height) {
    const limit = this.parent.resources.workPage, after = this.store.get('meta', 'publicMintRequestCursor') ?? '';
    let rows = this.store.list('publicMintRequests', { after, limit });
    if (!rows.length && after) rows = this.store.list('publicMintRequests', { limit });
    const writes = [];
    for (const { id } of rows) {
      const row = this.store.get('mints', id);
      const scan = row && this.store.get('accountRecords', publicScanKey(rules.publicPlotId(row.request.asset, row.request.block)));
      if (!row || row.permit || scan?.winner || BigInt(height) > BigInt(row.expiry)) writes.push({ space: 'publicMintRequests', id });
    }
    // Only release local checkout admission capacity. Retain every request and
    // payment scan so a delayed report or a late payment can still be resolved.
    writes.push({ space: 'meta', id: 'publicMintRequestCursor', value: rows.at(-1)?.id ?? '' });
    await this.store.transact(writes);
  }
  async tick() {
    if (this.document.values.publicMintActivationHeight === undefined) return;
    if (!rules.publicMintActive(this.document, this.store.get('meta', 'ruleState')?.counted ?? '0')) return;
    await this.releaseFinishedRequests(this.store.get('meta', 'ruleState').counted);
    const limit = this.document.values.publicMintScanBlocks;
    const after = this.store.get('meta', 'publicMintCursor') ?? '';
    let plots = this.store.list('publicMintPlots', { after, limit }); if (!plots.length && after) plots = this.store.list('publicMintPlots', { limit });
    for (const { id, value } of plots) {
      try {
        const at = await this.reads.batchStamp(), state = await this.reads.financialRecord(publicScanKey(id), at);
        if (state?.winner) await this.issue(state.winner, at);
        const t = { type: 'public-scan', id, ...value, previous: rules.hashObject(state ?? null) };
        await this.reads.publicMintScan(t, at); await this.parent.financial.submit(t);
      } catch (error) { if (error.message !== 'public_scan_pending') await this.store.put('publicMintFailures', id, { reason: /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'public_source_unavailable' }); }
    }
    await this.store.put('meta', 'publicMintCursor', plots.at(-1)?.id ?? '');
  }
  async issue(winner, at) {
    let row = this.store.get('mints', winner.id);
    if (!row) {
      const s = winner.source, q = s.intent;
      row = { id: winner.id, publicMint: true, request: { ...s.request, expires: q.feeQuote.validUntil }, kind: 'tap', payer: s.payer, receiver: s.receiver,
        created: q.feeQuote.validFrom, expiry: q.feeQuote.validUntil, context: { deployment: s.deployment }, state: 'paid', paymentIds: [winner.reference],
        catalogAsset: patternCatalogId(s.asset), quote: { ...q, fees: s.feeItems, baseFee: q.feeQuote.baseFee, feeQuote: q.feeQuote } };
    }
    if (row.permit) {
      if (row.mintInscription && this.parent.verifyMint(row, await this.reads.mint(row.id, at))) {
        const capacity = await this.reads.financialRecord('dc/' + row.id, at);
        if (capacity?.state === 'issued') {
          await this.parent.financial.submit({ type: 'lifecycle', id: row.id, action: { type: 'capacity-finish', id: row.id, permitHash: winner.permitHash } }); return;
        }
        await this.store.transact([{ space: 'mints', id: row.id, value: { ...row, state: 'minted' } },
          { space: 'minted', id: row.request.asset + '/' + row.request.block, value: { id: row.id, inscription: row.mintInscription } }]);
      }
      return;
    }
    const signed = await this.parent.committee.signature('mint/' + row.id, { network: this.parent.network, kind: 'mint', version: 'public-v1', id: row.id, receiver: row.receiver });
    if (!signed) return;
    check(signed.payload?.prv?.hash === winner.permitHash && signed.payload.prv.address === row.receiver, 'public_permit_binding');
    await this.store.transact([{ space: 'mints', id: row.id, value: { ...row, permit: signed.payload, state: 'permit_issued', missing: [] } },
      { space: 'publicMintRequests', id: row.id }]);
  }
}

export function publicMintAcceptedWrites(store, input) {
  if (input.transition.type !== 'public-scan') return [];
  const e = input.evidence, prior = store.get('accountRecords', publicScanKey(input.transition.id));
  const { winner, refunds } = rules.settlePublicPayments(prior?.winner, e.payments), writes = [];
  for (const row of refunds) {
    const id = publicRefundKey(row).split('/').at(-1), { source, ...refund } = row;
    for (const space of ['publicMintRefunds', 'publicMintRefundsByRequest/' + row.id, 'publicMintRefundsByAddress/' + rules.hash(row.tapAddress)]) writes.push({ space, id, value: refund });
  }
  if (winner && !prior?.winner) writes.push({ space: 'financialCustodyPending', id: winner.id, value: true });
  return writes;
}
