import { verify, createPublicKey } from 'node:crypto';
import { rules } from './rules.mjs';
import { check, hash, serial } from './util.mjs';
import { releaseCalldata } from './ethereum.mjs';
import { permit } from '../../committee/signer/adapter.mjs';
import { SETTING_BOUNDS } from '../../contract/settings.js';
import { mintFeeScope } from './fees.mjs';
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);

export function publicMint(r) {
  const state = r.state === 'reserving' ? 'awaiting_payment' : r.state;
  return { id: r.id, requestId: r.id, receiver: r.receiver, asset: r.request.asset, amount: r.request.amount,
    ...(r.request.block === undefined ? {} : { block: r.request.block }), kind: r.kind, state,
    fees: r.quote.fees, fullFees: r.quote.fullFees ?? r.quote.fees, payableAmount: r.quote.payableAmount ?? r.quote.price, missing: r.missing ?? r.quote.fees, payBy: { rail: r.kind, untilBlock: r.expiry ?? r.request.expires },
    payable: r.state !== 'reserving' && !['expired', 'permit_issued', 'minted'].includes(r.state),
    reservation: r.state === 'reserving' ? 'pending' : r.unitsConsumed ? 'consumed' : r.paymentSeen ? 'held' : r.state === 'expired' ? 'expired' : 'reserved',
    price: r.quote.price, split: r.quote.split, baseFee: r.quote.baseFee, feeSettings: r.quote.feeSettings ?? rules.FEE_DEFAULTS, unit: rules.TAP_UNIT, feeQuote: r.quote.feeQuote,
    displayLabel: r.quote.displayLabel, actualTicker: r.quote.actualTicker, deploymentId: r.quote.deploymentId,
    generation: r.quote.generation, jobState: r.quote.jobState, created: r.created ?? null, expiry: r.expiry ?? r.request.expires,
    networkFeeSats: '0', networkFeeAddress: null, payment: r.paymentIds ?? [],
    blocked: [],
    ...(r.permit ? { permit: r.permit, mintContent: r.permit, inscriptionText: rules.stableJSON(r.permit) } : {}),
    ...(r.payment?.depositFees ? { ethereumDepositAmount: r.payment.depositAmount, ethereumDepositFees: r.payment.depositFees } : {}),
    ...(r.release ? { ethereumRelease: r.release } : {}),
    credit: r.credit ?? [], inscription: r.observation?.inscription ?? null, reason: r.reason ?? null };
}
export function payerDigest(network, { request, receiver, payer, kind, feeQuote }) {
  return rules.digest('dmw-payment-intent-v1', network, { requestId: rules.pendingId(network, request), receiver, payer, kind, feeQuote: feeQuote ?? null });
}
export function verifyPayer(network, body) {
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(body.request.owner, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, payerDigest(network, body), key, Buffer.from(body.authorization, 'hex'));
  } catch { return false; }
}
export function paymentTerms(row) { const { confirmations, ...terms } = row; return terms; }
export class Mints {
  constructor({ store, network, reads, bitcoinNetwork = reads.bindings?.bitcoinNetwork ?? 'mainnet', committee, operations, payments, pendingBlocks = 432, capacity = 256 }) {
    Object.assign(this, { store, network, reads, bitcoinNetwork, committee, operations, payments, pendingBlocks, capacity }); this.gate = serial(); this.quoteEvidence = new WeakMap();
  }
  snapshot(read) { return this.reads.withSnapshot ? this.reads.withSnapshot(undefined, read) : read(); }
  quote(input) { return input.request ? this.request(input) : this.snapshot(() => this.quoteDetails(input)); }
  async quoteDetails(input) {
    const { asset, block, amount, kind = 'tap', receiver = null, payer = null } = input;
    let { feeQuote } = input;
    check(['tap', 'ethereum'].includes(kind) && rules.assetId(asset), 'quote_input');
    const needed = await this.deploymentNeeded(asset, { block, amount, kind, receiver });
    if (needed) return needed;
    check(this.reads.feeQuotes, 'fee_quotes_unavailable', 503);
    const scope = mintFeeScope(asset, block, kind);
    if (feeQuote) await this.reads.feeQuotes.validate(feeQuote, scope);
    const context = await this.reads.assetContext(asset, block, kind, feeQuote, undefined, input.sourceLocators), d = context?.deployment;
    check(d?.active && ['dmt', 'compound'].includes(d.kind) && (d.kind === 'dmt') === Number.isSafeInteger(block), 'deployment');
    check(d.kind !== 'dmt' || context.find?.finder, 'mint_no_find');
    const holder = context.link ? context.bitmapHolder ?? await this.reads.bitmap(block) : null;
    check(!context.link || holder?.agent && holder.address, 'bitmap_unavailable', 503);
    const feeKind = d.kind === 'dmt' ? 'find' : 'compound', counted = await this.reads.counted();
    feeQuote ??= await this.reads.feeQuotes.issue(scope, counted, context.payouts, d.id, hash(rules.stableJSON({ bitmap: holder, link: context.link ?? null })), input.sourceLocators ?? context.sourceLocators);
    await this.reads.feeQuotes.validate(feeQuote, scope);
    if (context.payouts) check(same(context.payouts, feeQuote.payouts), 'binding_snapshot_missing');
    if (feeQuote.mintOwnershipHash) check(feeQuote.mintOwnershipHash === hash(rules.stableJSON({ bitmap: holder, link: context.link ?? null })), 'quote_recipient_changed');
    const baseFee = feeQuote.baseFee, price = rules.feeFor(feeKind, baseFee, context.tier, feeQuote.feeSettings ?? context.feeSettings);
    const split = rules.splitFee(price, { kind: feeKind, linked: !!holder, discovered: !!context.discoverer });
    const unitsUsed = d.kind === 'dmt' ? String(context.find.count) : amount ?? '1';
    check(typeof unitsUsed === 'string' && /^[1-9][0-9]{0,19}$/.test(unitsUsed) && BigInt(unitsUsed) <= 18446744073709551615n && (amount === undefined || amount === unitsUsed), 'quote_amount');
    const destinations = { treasury: context.treasury, finder: context.finderAddress ?? null, firstMaker: context.firstMakerAddress ?? null,
      landowner: kind === 'ethereum' ? context.landownerAddress ?? null : holder?.address ?? null, discoverer: context.discoverer ?? null };
    const fees = rules.mintFeeItems(split, destinations, null, payer, kind, this.bitcoinNetwork);
    const quote = { requestId: null, receiver, asset, amount: unitsUsed, fees, payBy: { rail: kind, untilBlock: counted + this.pendingBlocks }, payable: false,
      displayLabel: context.displayLabel ?? asset, actualTicker: d.tick, deploymentId: d.id, generation: d.generation ?? 1, jobState: 'registered',
      ...(block === undefined ? {} : { block }), kind, baseFee, feeSettings: feeQuote.feeSettings ?? context.feeSettings ?? rules.FEE_DEFAULTS, unit: rules.TAP_UNIT, feeQuote, price, split, networkFeeSats: '0',
      networkFeePayment: 'player_wallet', destinations, counted, unitsUsed, matterUnit: { asset, denomination: 'units', decimals: 0 },
      feeDestinations: Object.fromEntries(fees.map(f => [f.role, { amount: f.amount, to: f.to, settlement: f.role === 'burn' ? 'burn' : 'direct' }])) };
    this.quoteEvidence.set(quote, { context, holder }); return quote;
  }
  async deploymentNeeded(asset, details = {}) {
    if (!this.provisioner) return null;
    const registered = (await this.reads.registry?.())?.assets?.[asset];
    if (registered && !registered.suspended) return null;
    const definition = (this.store.get('meta', 'patterns') ?? []).find(p => rules.patternAsset(p) === asset) ?? this.store.get('types', asset);
    check(definition, 'asset_unknown');
    const deployment = await this.provisioner.request(asset, definition);
    if (deployment.state === 'registered') return null;
    return { ...details, requestId: null, asset, state: 'deployment_needed', deploymentNeeded: true,
      message: 'Deployment needed. Inscribe the supplied content from your own Bitcoin wallet before requesting the mint.',
      payable: false, reservation: 'none', fees: [], missing: [], blocked: ['deployment_needed'],
      deployment, deploymentPath: '/mint/deployment/' + asset };
  }
  request(body) { return this.gate(async () => {
    const savedId = rules.pendingId(this.network, body.request), saved = this.store.get('mints', savedId);
    if (saved) {
      check(verifyPayer(this.network, body), 'payer_authorization');
      check(saved.payer === body.payer && saved.kind === body.kind && saved.receiver === body.receiver && same(saved.request, body.request) && saved.signature === body.signature, 'request_conflict', 409);
      return publicMint(saved);
    }
    const prepared = await this.snapshot(async () => {
    const { request, signature, receiver, payer, kind } = body, counted = await this.reads.counted();
    check(typeof receiver === 'string' && receiver.length > 0 && receiver.length <= 128 && hash(receiver) === request?.receive, 'receiver_binding');
    check(typeof payer === 'string' && payer.length > 0 && payer.length <= 128 && verifyPayer(this.network, body), 'payer_authorization');
    const id = rules.pendingId(this.network, request), prior = this.store.get('mints', id);
    if (prior) { check(prior.payer === payer && prior.kind === kind && prior.receiver === receiver && same(prior.request, request) && prior.signature === signature, 'request_conflict', 409); return publicMint(prior); }
    check(rules.verifyRequest('rq', this.network, request, signature, counted), 'owner_signature');
    check(request.expires - counted >= SETTING_BOUNDS.pending_blocks[0] && request.expires - counted <= SETTING_BOUNDS.pending_blocks[1], 'request_expiry');
    check(this.operations.supportsMintBatches === true, 'mint_batch_replay_unavailable', 503);
    check(this.store.count('activeMints') < this.capacity, 'mint_capacity', 503);
    const quote = await this.quote({ asset: request.asset, block: request.block, amount: request.amount, kind, feeQuote: body.feeQuote, sourceLocators: body.sourceLocators });
    if (quote.deploymentNeeded) return quote;
    quote.fullFees = rules.mintFeeItems(quote.split, quote.destinations, id, null, kind, this.bitcoinNetwork);
    quote.fees = rules.mintFeeItems(quote.split, quote.destinations, id, payer, kind, this.bitcoinNetwork);
    quote.payableAmount = quote.fees.reduce((n, f) => n + BigInt(f.amount), 0n).toString();
    const feeAuthorization = await this.reads.feeQuotes.accept(quote.feeQuote, mintFeeScope(request.asset, request.block, kind), id, request.expires, counted);
    const { context, holder } = this.quoteEvidence.get(quote), compound = context.deployment.kind === 'compound';
    check(compound || context.find?.finder, 'mint_no_find');
    const key = compound ? null : `${request.asset}/${request.block}`;
    const hold = key ? this.store.get('holds', key) : null;
    check(!hold || counted > hold.expiry && hold.safeToReplace === true, 'block_pending', 409);
    const reserved = this.store.list('activeMints', { limit: this.capacity }).map(r => this.store.get('mints', r.id)).filter(r => r.state === 'reserving' && r.request.owner === request.owner && r.request.asset === request.asset).reduce((n, r) => n + BigInt(r.request.amount), 0n);
    const accepted = rules.acceptMintRequest({ request, sig: signature, network: this.network, counted, compound, find: context.find, link: context.link,
      currentHolder: holder?.agent, minted: compound ? false : await this.reads.isMinted(context.deployment.id, context.deployment.tick, request.block),
      balance: (BigInt(await this.reads.balance(request.owner, request.asset)) - reserved).toString(), settings: { pendingBlocks: this.pendingBlocks } });
    const creditIds = this.store.list('mintCredits', { limit: 4096 }).filter(({ id: sourceId, value }) => value.owner === request.owner && value.payer === payer && value.rail === kind &&
      !this.store.get('creditClaims', sourceId) && value.items.some(item => quote.fees.some(fee => rules.sameFee(fee, item)))).slice(0, 32).map(r => r.id);
    const row = { id, request, signature, receiver, payer, kind, authorization: body.authorization, requestedFeeQuote: body.feeQuote ?? null,
      quote, context, feeAuthorization, key, state: 'reserving', acceptedAt: counted, deadline: request.until, op: accepted.op, paymentIds: [], creditIds };
    return { row, creditIds, key, request, id };
    });
    if (!prepared.row) return prepared;
    const { row, creditIds, key, request, id } = prepared;
    await this.store.transact([{ space: 'mints', id, value: row }, { space: 'activeMints', id, value: true },
      ...creditIds.map(sourceId => ({ space: 'creditClaims', id: sourceId, value: id })),
      ...(key ? [{ space: 'holds', id: key, value: { id, expiry: request.expires, safeToReplace: false } }] : [])]);
    return publicMint(row);
  }); }
  payment({ id, requestId, paymentId, paymentIds = [], inscription, mintLocator, paymentEvidence = {} }) { return this.gate(async () => {
    id ??= requestId;
    const row = this.store.get('mints', id); check(row, 'request_not_found', 404);
    if (inscription) {
      check(row.permit && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(inscription), 'mint_inscription');
      await this.save({ ...row, mintInscription: inscription, ...(mintLocator ? { mintLocator } : {}) }); return this.public(id);
    }
    check(row.state !== 'reserving' && !row.permit, 'payment_state', 409);
    const maxItems = this.reads.sourcePolicy?.maxItems ?? 64;
    check(Array.isArray(paymentIds) && paymentIds.length <= maxItems, 'payment_ids');
    const ids = [...new Set([...(row.paymentIds ?? []), ...(paymentId ? [paymentId] : []), ...paymentIds])];
    check(ids.length <= maxItems && ids.every(p => typeof p === 'string' && p.length > 0 && p.length <= 160), 'payment_id');
    check(paymentEvidence && typeof paymentEvidence === 'object' && !Array.isArray(paymentEvidence) && Object.keys(paymentEvidence).every(key => ids.includes(key)), 'payment_evidence');
    const candidate = { ...row, paymentIds: ids, paymentEvidence: { ...row.paymentEvidence, ...paymentEvidence } }, payment = await this.payments.mint(candidate);
    // Keep named submissions even before they confirm; retries and late credit
    // recovery must not depend on wallet-history discovery.
    check(payment.receipts.some(p => p.accepted) || this.reads.namedSources && ids.length > 0, 'payment_unseen');
    await this.save(candidate); await this.refresh(candidate, await this.reads.counted(), payment);
    return this.public(id);
  }); }
  public(id) { const r = this.store.get('mints', id); check(r, 'request_not_found', 404); return publicMint(r); }
  async save(row) { await this.store.put('mints', row.id, row); return row; }
  async supervise() { /* No service transaction can need cancellation. */ }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      const counted = await this.reads.counted();
      const ids = new Set();
      this.cursors ??= {};
      for (const space of ['activeMints', 'expiredMints', 'issuedMints']) {
        const page = this.store.list(space, { after: this.cursors[space] ?? '', limit: this.capacity });
        this.cursors[space] = page.length === this.capacity ? page.at(-1).id : '';
        for (const row of page) ids.add(row.id);
      }
      for (const id of ids) {
        try { await this.gate(() => this.advance(this.store.get('mints', id), counted)); }
        catch (e) { const r = this.store.get('mints', id); await this.save({ ...r, lastError: /^[a-z][a-z0-9_]{0,80}$/.test(e.message) ? e.message : 'dependency_unavailable', checkedAt: counted }); }
      }
    } finally { this.running = false; }
  }
  async expire(row, counted, receipts = []) {
    const credit = receipts.filter(r => r.origin === row.id && r.accepted && r.confirmations >= 1 && BigInt(r.amount) > BigInt(r.used ?? '0'));
    await this.store.transact([{ space: 'mints', id: row.id, value: { ...row, state: 'expired', credit, reason: credit.length ? 'payment_credit' : 'unpaid_expired' } },
      { space: 'activeMints', id: row.id }, { space: 'expiredMints', id: row.id, value: true },
      ...row.creditIds.filter(id => this.store.get('creditClaims', id) === row.id).map(id => ({ space: 'creditClaims', id })),
      ...(credit.length ? [{ space: 'mintCredits', id: row.id, value: { owner: row.request.owner, payer: row.payer, rail: row.kind, items: credit } }] : []),
      ...(row.key ? [{ space: 'holds', id: row.key, value: { id: row.id, expiry: counted - 1, safeToReplace: true } }] : [])]);
  }
  async refresh(row, counted, payment = null) {
    payment ??= await this.payments.mint(row);
    check(payment.requestId === row.id && payment.payer === row.payer && payment.kind === row.kind && same(payment.fees, row.quote.fees), 'payment_binding');
    const progress = rules.paymentProgress(row.quote.fees, payment.receipts, { confirmations: payment.requiredConfirmations ?? 1 });
    const raw = await this.reads.pending(row.id);
    if (row.credit?.length) { await this.expire({ ...row, payment, missing: progress.missing }, counted, payment.receipts); return null; }
    if (!raw?.h && counted > row.expiry) {
      const held = row.key ? this.store.get('holds', row.key) : null;
      if (!progress.seen || held && held.id !== row.id || BigInt(await this.reads.balance(row.request.owner, row.request.asset)) < BigInt(row.request.amount)) {
        await this.expire({ ...row, payment, missing: progress.missing }, counted, payment.receipts); return null;
      }
    }
    if (progress.seen && !raw?.h) {
      await this.save({ ...row, paymentSeen: true, missing: progress.missing, state: progress.state });
      const held = await this.operations.ensure('mp/' + row.id, rules.holdPaidOp(row.id));
      if (!held) return null;
      row = { ...row, paymentSeen: true };
      await this.store.transact([{ space: 'activeMints', id: row.id, value: true }, { space: 'expiredMints', id: row.id },
        ...(row.key ? [{ space: 'holds', id: row.key, value: { id: row.id, expiry: Number.MAX_SAFE_INTEGER, safeToReplace: false } }] : [])]);
    }
    row = await this.save({ ...row, paymentSeen: !!raw?.h || row.paymentSeen === true, missing: progress.missing,
      state: payment.depositFinal ? 'paid' : progress.state, payment, progress });
    return row;
  }
  async advance(row, counted) {
    if (row.state === 'minted') return;
    if (row.state === 'reserving') {
      const accepted = await this.operations.ensure('rq/' + row.id, row.op);
      if (!accepted) { if (counted > row.deadline) await this.expire(row, counted); return; }
      check(accepted.id === row.id && Number.isSafeInteger(accepted.created) && accepted.created <= counted && accepted.expiry === row.request.expires &&
        accepted.expiry - accepted.created >= 6 && accepted.expiry - accepted.created <= 2016, 'pending_acceptance');
      row = await this.save({ ...row, created: accepted.created, expiry: accepted.expiry, state: 'awaiting_payment' });
      await this.refresh(row, counted); return;
    }
    if (row.permit) {
      const o = await this.reads.mint(row.id);
      if (this.verifyMint(row, o)) await this.store.transact([...(row.key ? [{space:'minted',id:row.key,value:{id:row.id,inscription:o.inscription}}] : []), { space: 'mints', id: row.id, value: { ...row, state: 'minted', observation: o } }, { space: 'issuedMints', id: row.id }]);
      return;
    }
    // Once consumed, retry signing the saved deterministic plan without
    // changing the request, payment references or committee ceremony identity.
    const raw = await this.reads.pending(row.id);
    if (raw?.s === 1) {
      check(row.permitPlan && raw.permitHash === row.permitPlan.digest, 'consumption_binding');
      const signed = await this.committee.signature('mint/' + row.id, { network: this.network, kind: 'mint', request: row.request, signature: row.signature, receiver: row.receiver });
      if (!signed) return;
      check(signed.payload?.prv?.hash === raw.permitHash && signed.payload.prv.address === row.receiver, 'permit_binding');
      await this.store.transact([{ space: 'mints', id: row.id, value: { ...row, permit: signed.payload, unitsConsumed: true, state: 'permit_issued', missing: [] } },
        { space: 'activeMints', id: row.id }, { space: 'expiredMints', id: row.id }, { space: 'issuedMints', id: row.id, value: true },
        ...row.creditIds.filter(id => this.store.get('creditClaims', id) === row.id).map(id => ({ space: 'creditClaims', id }))]);
      return;
    }
    const refreshed = await this.refresh(row, counted);
    row = refreshed ?? this.store.get('mints', row.id);
    if (!refreshed && !(row.kind === 'ethereum' && row.payment?.depositFinal)) return;
    if (row.kind === 'ethereum' && row.payment.depositFinal && !row.progress?.final) {
      if (!row.release) {
        const signed = await this.committee.signature('payment-release/' + row.id, { network: this.network, kind: 'ethereum-payment-release', id: row.id });
        if (signed) {
          const domain = signed.typedData.domain;
          await this.save({ ...row, release: { chainId: domain.chainId, to: domain.verifyingContract,
            data: releaseCalldata(row.payer, row.id, signed.ethereumSignature), signature: signed.ethereumSignature, typedData: signed.typedData } });
        }
      }
      return;
    }
    if (!refreshed || !row.progress.final) return;
    // Independently verified deployment is required here and again by every
    // signer. An unindexed compound deployment cannot receive a mint permit.
    const context = await this.reads.assetContext(row.request.asset, row.request.block, row.kind, row.quote.feeQuote, row.id);
    check(context.deployment.active && context.deployment.id === row.context.deployment.id, 'deployment');
    const plan = permit(this.network, row.request, context.deployment, row.receiver, row.id, rules.paymentCommitment(row.progress.allocations));
    row = await this.save({ ...row, state: 'paid', permitPlan: plan });
    if (await this.operations.ensure('mc/' + row.id, rules.consumePaidOp(row.id, plan.digest, row.progress.allocations))) await this.save({ ...row, unitsConsumed: true });
  }
  verifyMint(r, o) {
    return o?.accepted === true && o.fail === false && o.confirmations >= 1 && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(o.inscription) &&
      o.deployment === r.context.deployment.id && o.tick === r.context.deployment.tick && o.receiver === r.receiver && o.amount === r.request.amount &&
      o.dta === r.permit.dta && o.permitHash === r.permit.prv.hash && o.committee === r.context.deployment.privilegePublicKey &&
      (r.context.deployment.kind !== 'dmt' || o.block === r.request.block);
  }
}
