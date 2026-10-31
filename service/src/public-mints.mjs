import { rules } from './rules.mjs';
import { check, heightKey, serial } from './util.mjs';
import { Mints, publicMint } from './mints.mjs';
import { payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { mintAssetDefinition, patternCatalogId } from './mint-assets.mjs';
import { claimedPage } from './claimed-feeds.mjs';
import { projectionReady } from './projection-state.mjs';
import { publicScanKey, publicRefundKey } from '../../contract/public-mint.js';
import { plotKey } from '../../contract/financial-capacity.js';
import { PublicMintAdmission, openPublicMint } from './public-mint-admission.mjs';
import { discoverPublicMintPayments, publicPaymentReceipts } from './public-mint-discovery.mjs';
import { newRequesterSecret, requesterSecretHash, publicMintTargetVisible, privatePublicMintView, privatePublicRefundView } from './public-mint-privacy.mjs';

const registrationTransition = row => ({ type: 'public-payment', id: row.paymentRegistration.commitment,
  action: 'register', registration: row.paymentRegistration });
const refundView = row => ({ ...row, requestId: row.id, paymentId: row.reference });

export class PublicMints {
  constructor(parent) { this.parent = parent; this.admission = new PublicMintAdmission(parent); this.queueGate = serial(); }
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
    // Historical policies retain their settlement fence; the activated read has no deadline.
    const unsettled = right.claimDeadline !== undefined && claims.rounds.some(round => !round.closed && BigInt(round.window) < BigInt(right.claimDeadline));
    const capacity = this.store.get('accountRecords', plotKey(ledgerAsset, block)) ?? this.store.get('accountRecords', 'fi/plot/' + ledgerAsset + '/' + block);
    let state = minted ? 'already_minted' : scan?.winner ? this.store.get('mints', scan.winner.id)?.permit ? 'permit_issued' : 'paid' : right.state === 'claimed' ? 'claimed' : capacity ? 'already_minted' : right.state;
    if (state === 'public' && right.claimDeadline !== undefined && (!occurrence || unsettled)) state = 'public_scan_pending';
    return { asset: catalogAsset, ledgerAsset, block, amount: occurrence?.count ?? (find ? String(find.count) : null),
      state, ...(state === 'not_yet_public' ? { publicFrom: rules.decimalV2(right.publicFrom) } : {}),
      bitmapHolderOnly: !rules.bitmapMintOpenActive(this.document, height) && !!this.store.get('links', heightKey(block)), winner: scan?.winner ? { id: scan.winner.id, tapAddress: scan.winner.tapAddress, paymentId: scan.winner.reference } : null,
      refunds: '/public-mints/refunds?asset=' + encodeURIComponent(catalogAsset) + '&block=' + block };
  }
  list(params) {
    for (const key of params.keys()) check(['asset', 'limit', 'cursor'].includes(key), 'public_mint_query');
    const asset = params.get('asset'), pageSize = this.document.values.publicMintPageSize ?? rules.PUBLIC_MINT_SETTINGS.publicMintPageSize,
      limit = Number(params.get('limit') ?? pageSize);
    check(/^p2:(0|[1-9][0-9]*)$/.test(asset ?? '') && Number.isSafeInteger(limit) && limit > 0 && limit <= pageSize, 'public_mint_query');
    const height = rules.decimalV2(this.store.get('meta', 'ruleState')?.counted ?? '0');
    if (!rules.publicMintActive(this.document, height)) return { v: 3, asset, state: 'inactive',
      activationHeight: this.document.values.publicMintActivationHeight ?? null, rows: [], mintRights: [], total: 0, next: null, nextCursor: null };
    const query = new URLSearchParams({ limit: String(limit), found: 'false', minted: 'false' });
    if (params.has('cursor')) query.set('cursor', params.get('cursor'));
    const page = claimedPage(this.store, asset, query, { patternDetailRows: this.document.values.publicMintPageSize });
    const claims = new rules.ClaimStorage({ get: key => this.store.get('claimNodes', key), cacheSize: this.document.values.publicMintPageSize }).load(this.store.get('meta', 'ruleState'));
    const rows = page.rows.map(row => this.state(asset, row.block, claims)).filter(row => row.state === 'public');
    return { v: 3, asset, rows, mintRights: rows, total: null, next: page.nextCursor, nextCursor: page.nextCursor };
  }
  async quote(input, start = false, { clientIP, requesterSecret } = {}) {
    this.active(); check(rules.exactKeys(input, ['asset', 'block', 'tapAddress', ...(input.deployment === undefined ? [] : ['deployment'])]), 'public_mint_input');
    const ipHash = start ? await this.admission.start(clientIP) : null;
    const resolved = await mintAssetDefinition(this.store, input.asset), block = rules.decimalV2(input.block);
    const state = this.state(resolved.catalogAsset, block);
    if (state.state !== 'public') throw Object.assign(Error(state.state === 'minted' ? 'already_minted' : state.winner ? 'someone_paid_first' : state.state),
      { status: 409, ...(state.winner ? { publicRefund: { refunds: state.refunds, winner: state.winner } } : {}) });
    check(!this.parent.financial.admissionReady || await this.parent.financial.admissionReady(), 'financial_admission_fenced', 503);
    payoutAddress('tap', input.tapAddress, this.parent.bitcoinNetwork);
    const needed = await Mints.prototype.deploymentNeeded.call(this.parent, resolved.asset, { block, receiver: input.tapAddress, kind: 'tap' });
    if (needed) return { ...needed, publicMint: true, reservation: 'none' };
    const generation = await this.reads.financialDeployment(resolved.asset, await this.reads.batchStamp(), input.deployment);
    if (!generation.existing) {
      await this.parent.financial.submit({ type: 'lifecycle', id: generation.id, action: generation.action });
      return { id: null, requestId: null, asset: resolved.catalogAsset, block, receiver: input.tapAddress, kind: 'tap', publicMint: true,
        state: 'deployment_pending', payable: false, reservation: 'none', fees: [], missing: [] };
    }
    const q = await this.reads.publicMintQuote({ asset: resolved.asset, block, tapAddress: input.tapAddress, ...(input.deployment ? { deployment: input.deployment } : {}) }, await this.reads.batchStamp());
    const row = { id: q.id, publicMint: true, catalogAsset: resolved.catalogAsset, intent: q.intent, receiver: input.tapAddress, payer: input.tapAddress, kind: 'tap',
      ...(q.registration ? { paymentRegistration: q.registration } : {}),
      request: { asset: resolved.asset, block, amount: q.amount, expires: q.feeQuote.validUntil }, expiry: q.feeQuote.validUntil, created: q.feeQuote.validFrom,
      quote: { ...q, payableAmount: q.fees.reduce((n, f) => n + BigInt(f.amount), 0n).toString(), baseFee: q.feeQuote.baseFee,
        feeSettings: q.feeQuote.feeSettings, actualTicker: q.deployment.tick, deploymentId: q.deployment.id },
      context: { deployment: q.deployment }, state: 'awaiting_payment', paymentIds: [] };
    if (!start) return { ...publicMint(row), id: null, requestId: null, payable: false, reservation: 'none' };
    const plot = rules.publicPlotId(resolved.asset, block);
    const secret = newRequesterSecret();
    const admitted = await this.admission.admit({ ...(this.parent.mintSender?.bind(row) ?? row), requesterSecretHash: requesterSecretHash(secret) }, ipHash, admitted => this.store.transact([{ space: 'mints', id: row.id, value: admitted }, { space: 'publicMintRequests', id: row.id, value: true },
      ...(q.registration ? [{ space: 'publicMintCommitments', id: q.registration.commitment, value: row.id }] : []),
      { space: 'publicMintPlots', id: plot, value: { asset: resolved.asset, block } }]));
    if (admitted.row.paymentRegistration) {
      try { await this.registerPayment(admitted.row); } catch { /* Return the requester secret; durable registration retries on tick. */ }
    }
    return { ...this.public(row.id, admitted.created ? secret : requesterSecret), ...(admitted.created ? { requesterSecret: secret } : {}) };
  }
  public(id, requesterSecret) {
    const row = this.store.get('mints', id); check(row?.publicMint, 'request_not_found', 404);
    const scan = this.store.get('accountRecords', publicScanKey(rules.publicPlotId(row.request.asset, row.request.block)));
    const refunds = this.store.list('publicMintRefundsByRequest/' + id, { limit: this.document.values.publicMintPageSize }).map(r => refundView(r.value));
    const lost = !!scan?.winner && scan.winner.id !== id;
    const expired = BigInt(this.store.get('meta', 'ruleState')?.counted ?? row.created) > BigInt(row.expiry);
    // A checkout reserves nothing. Recheck before offering an unpaid request to the wallet.
    const current = !expired && !row.permit && !scan?.winner && !refunds.length && !row.paymentIds.length ? this.state(row.request.asset, row.request.block) : null;
    const unavailable = current && current.state !== 'public' ? current.state : null;
    const registered = !row.paymentRegistration || !!this.store.get('accountRecords', rules.publicPaymentKey(row.paymentRegistration.commitment));
    const state = row.permit ? row.state : refunds.length && scan?.winner?.id !== id ? 'refundable' : lost ? 'someone_paid_first' : unavailable ?? row.state;
    const status = { ...publicMint(row), payer: row.payer, state, reservation: 'none', unitsConsumed: false, publicMint: true, catalogAsset: row.catalogAsset,
      ...(state === 'not_yet_public' && current?.publicFrom !== undefined ? { publicFrom: current.publicFrom } : {}),
      payable: registered && !unavailable && !expired && !row.permit && !scan?.winner && !refunds.length && !row.paymentIds.length,
      refunds, winner: scan?.winner ? { id: scan.winner.id, tapAddress: scan.winner.tapAddress } : null,
      reason: refunds.find(refund => refund.reason === 'claimed_first')?.reason ?? (lost ? 'someone_paid_first' : refunds[0]?.reason ?? unavailable ?? row.reason ?? null), paymentPage: '/mint/' + id,
      ...(row.mintInscription ? { sentInscription: row.mintInscription } : {}) };
    const decorated = this.parent.mintSender?.decorate(row, status) ?? status;
    return publicMintTargetVisible(this.store, row, requesterSecret) ? decorated : privatePublicMintView(decorated);
  }
  async payment({ id, requestId, paymentId, paymentIds = [], inscription }, requesterSecret) {
    id ??= requestId; const row = this.store.get('mints', id); check(row?.publicMint, 'request_not_found', 404);
    if (inscription) {
      check(row.permit && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(inscription), 'mint_inscription');
      await this.store.put('mints', id, { ...row, mintInscription: inscription });
    } else {
      check(Array.isArray(paymentIds), 'payment_id');
      const ids = [...new Set([...(row.paymentIds ?? []), ...(paymentId ? [paymentId] : []), ...paymentIds])];
      check(ids.length > 0 && ids.length <= this.document.values.paymentPage && ids.every(id => /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(id)), 'payment_id');
      const at = await this.reads.batchStamp(), receipts = await publicPaymentReceipts(this.reads, row, ids, at);
      check(receipts.length, 'payment_unseen', 409);
      const verified = [...new Set(receipts.map(r => r.reference))];
      await this.queuePlot(row.request.asset, row.request.block, receipts.reduce((h, r) => BigInt(r.verifiedHeight) > BigInt(h) ? r.verifiedHeight : h, '0'),
        [{ space: 'mints', id, value: { ...row, paymentIds: verified, state: row.permit ? row.state : 'scanning' } }]);
    }
    return this.public(id, requesterSecret);
  }
  queuePlot(asset, block, through, extra = []) {
    return this.queueGate(async () => {
      const id = rules.publicPlotId(asset, block), prior = this.store.get('publicMintPaidPlots', id);
      if (prior && BigInt(prior.through) > BigInt(through)) through = prior.through;
      await this.store.transact([...extra, { space: 'publicMintPaidPlots', id, value: { asset, block, through } }]);
    });
  }
  async migrateSettledPlots(height) {
    if (this.store.get('meta', 'publicMintPaidPlotsMigrated')) return;
    const limit = this.parent.resources.workPage, after = this.store.get('meta', 'publicMintPaidPlotsMigration') ?? '';
    const page = this.store.list('publicMintPlots', { after, limit });
    for (const { id, value } of page) {
      if (this.store.get('accountRecords', publicScanKey(id))?.winner) await this.queuePlot(value.asset, value.block, height);
    }
    await this.store.put('meta', page.length < limit ? 'publicMintPaidPlotsMigrated' : 'publicMintPaidPlotsMigration', page.length < limit ? true : page.at(-1).id);
  }
  refunds(params, requesterSecret) {
    this.active(); for (const key of params.keys()) check(['asset', 'block', 'tapAddress', 'limit', 'cursor'].includes(key), 'public_refund_query');
    const limit = Number(params.get('limit') ?? this.document.values.publicMintPageSize);
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= this.document.values.publicMintPageSize, 'page_limit');
    const scope = params.get('tapAddress') ? 'publicMintRefundsByAddress/' + rules.hash(params.get('tapAddress')) : 'publicMintRefunds';
    const after = params.get('cursor') ?? ''; check(!after || rules.hex(after, 32), 'page_cursor');
    const raw = this.store.list(scope, { after, limit: limit + 1 }), rows = raw.slice(0, limit).map(r => {
      const refund = { ...refundView(r.value), refundId: r.id }, row = this.store.get('mints', r.value.id) ?? { publicMint: true, request: r.value };
      return publicMintTargetVisible(this.store, row, requesterSecret) ? refund : privatePublicRefundView(refund);
    }).filter(r =>
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
      if (row?.paymentRegistration && BigInt(height) > BigInt(row.expiry)) {
        const work = rules.hashObject(['dmw-financial-transition-v2', registrationTransition(row)]);
        if (this.store.get('financialQueue', work) && !await this.parent.financial.expire(work, { counted: height })) continue;
      }
      if (!openPublicMint(this.store, row, height)) writes.push({ space: 'publicMintRequests', id });
    }
    // Only release local checkout admission capacity. Retain every request and
    // payment scan so a delayed report or a late payment can still be resolved.
    writes.push({ space: 'meta', id: 'publicMintRequestCursor', value: rows.at(-1)?.id ?? '' });
    await this.store.transact(writes);
  }
  async tick() {
    if (this.document.values.publicMintActivationHeight === undefined) return;
    if (!rules.publicMintActive(this.document, this.store.get('meta', 'ruleState')?.counted ?? '0')) return;
    if (this.running) return; this.running = true;
    try {
    await this.releaseFinishedRequests(this.store.get('meta', 'ruleState').counted);
    const registrationAfter = this.store.get('meta', 'publicMintRegistrationCursor') ?? '';
    let pending = this.store.list('publicMintRequests', { after: registrationAfter, limit: this.parent.resources.workPage });
    if (!pending.length && registrationAfter) pending = this.store.list('publicMintRequests', { limit: this.parent.resources.workPage });
    for (const { id } of pending) {
      const row = this.store.get('mints', id);
      if (row?.paymentRegistration && BigInt(row.expiry) >= BigInt(this.store.get('meta', 'ruleState').counted) &&
          !this.store.get('accountRecords', rules.publicPaymentKey(row.paymentRegistration.commitment))) {
        try { await this.registerPayment(row); } catch { /* The durable request is retried next tick. */ }
      }
    }
    await this.store.put('meta', 'publicMintRegistrationCursor', pending.at(-1)?.id ?? '');
    await this.migrateSettledPlots(this.store.get('meta', 'ruleState').counted);
    try { await discoverPublicMintPayments(this, await this.reads.batchStamp()); }
    catch (error) { error = await this.revealPayment(error); await this.store.put('meta', 'publicMintDiscoveryFailure', { reason: /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'public_source_unavailable' }); }
    const limit = this.document.values.publicMintScanBlocks;
    const after = this.store.get('meta', 'publicMintCursor') ?? '';
    let plots = this.store.list('publicMintPaidPlots', { after, limit }); if (!plots.length && after) plots = this.store.list('publicMintPaidPlots', { limit });
    for (const { id, value } of plots) {
      try {
        const at = await this.reads.batchStamp(), state = await this.reads.financialRecord(publicScanKey(id), at);
        if (state?.winner) {
          if (this.parent.mintWork) await this.parent.mintWork.run(state.winner.id, () => this.issue(state.winner, at));
          else await this.issue(state.winner, at);
        }
        if (state?.next && BigInt(state.next.height) > BigInt(value.through)) {
          if (!state.winner || this.store.get('mints', state.winner.id)?.state === 'minted') await this.queueGate(async () => {
            if (this.store.get('publicMintPaidPlots', id)?.through === value.through) await this.store.transact([{ space: 'publicMintPaidPlots', id }]);
          });
          continue;
        }
        const t = { type: 'public-scan', id, asset: value.asset, block: value.block, previous: rules.hashObject(state ?? null) };
        await this.reads.publicMintScan(t, at); await this.parent.financial.submit(t);
      } catch (error) { error = await this.revealPayment(error); if (error.message !== 'public_scan_pending') await this.store.put('publicMintFailures', id, { reason: /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'public_source_unavailable' }); }
    }
    await this.store.put('meta', 'publicMintCursor', plots.at(-1)?.id ?? '');
    } finally { this.running = false; }
  }
  async registerPayment(row) {
    return this.parent.financial.submit(registrationTransition(row));
  }
  async revealPayment(error) {
    if (error.message !== 'public_payment_unrevealed') return error;
    const requestId = this.store.get('publicMintCommitments', error.commitment), row = requestId && this.store.get('mints', requestId);
    if (row?.intent) {
      const transition = { type: 'public-payment', id: error.commitment, action: 'reveal', intent: row.intent, reference: error.reference };
      try {
        await this.reads.publicMintPayment(transition, await this.reads.batchStamp());
        await this.parent.financial.submit(transition);
      } catch (revealError) { return revealError; }
    }
    return error;
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

export function publicMintAcceptedWrites(store, input, accepted = store) {
  if (input.transition.action?.type === 'ticker-refund') {
    const id = input.transition.id, refund = accepted.get('accountRecords', 'fp/public-refund/' + id);
    return refund ? ['publicMintRefunds', 'publicMintRefundsByRequest/' + refund.id, 'publicMintRefundsByAddress/' + rules.hash(refund.tapAddress)]
      .map(space => ({ space, id, value: refund })) : [];
  }
  if (input.transition.type !== 'public-scan') return [];
  const key = publicScanKey(input.transition.id), prior = store.get('accountRecords', key);
  const winner = accepted.get('accountRecords', key)?.winner, writes = [];
  for (const payment of input.evidence.payments) {
    const key = publicRefundKey(payment), row = accepted.get('accountRecords', key);
    if (!row) continue;
    const id = key.split('/').at(-1), { source, ...refund } = row;
    for (const space of ['publicMintRefunds', 'publicMintRefundsByRequest/' + row.id, 'publicMintRefundsByAddress/' + rules.hash(row.tapAddress)]) writes.push({ space, id, value: refund });
  }
  if (winner && !prior?.winner) writes.push({ space: 'financialCustodyPending', id: winner.id, value: true });
  const scan = accepted.get('accountRecords', key);
  if (scan?.asset && scan.block !== undefined && (winner || input.evidence.payments.length)) {
    const queued = store.get('publicMintPaidPlots', input.transition.id), through = scan.scannedHeight;
    writes.push({ space: 'publicMintPaidPlots', id: input.transition.id, value: { asset: scan.asset, block: scan.block,
      through: queued && BigInt(queued.through) > BigInt(through) ? queued.through : through } });
  }
  return writes;
}
