import { verify, createPublicKey } from 'node:crypto';
import { rules } from './rules.mjs';
import { check, hash, serial } from './util.mjs';
import { releaseCalldata } from './ethereum.mjs';
import { permit } from '../../committee/signer/adapter.mjs';
import { SETTING_BOUNDS } from '../../contract/settings.js';
import { mintFeeScope, mintOwnershipMatches } from './fees.mjs';
import { assetResources } from './asset-resources.mjs';
import { creditOperations, migrateCreditPage, releaseCreditClaims, selectCredits, surplusReceipts } from './mint-credits.mjs';
import { activeOwnerSpace, reservingSpace, releaseAdmission, migrateMintAdmission, reservedFor } from './mint-admission.mjs';
import { financialMintId, financialAsset } from '../../rules/src/financial-mint.js';
import { financialSplit } from '../../rules/src/financial-fees.js';
import { mintAssetDefinition } from './mint-assets.mjs';
import { KeyedWork, parallelPage } from './keyed-work.mjs';
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
  return rules.digest(request?.v === 2 ? 'dmw-payment-intent-v2' : 'dmw-payment-intent-v1', network, { requestId: financialMintId(network, request), receiver, payer, kind, feeQuote: feeQuote ?? null });
}
export function verifyPayer(network, body) {
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(body.request.owner, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, payerDigest(network, body), key, Buffer.from(body.authorization, 'hex'));
  } catch { return false; }
}
export function paymentTerms(row) { const { confirmations, ...terms } = row; return terms; }
export class Mints {
  constructor({ store, network, reads, bitcoinNetwork = reads.bindings?.bitcoinNetwork ?? 'mainnet', committee, operations, payments, pendingBlocks = 432, resources = {}, capacity = assetResources(resources).activeMints }) {
    Object.assign(this, { store, network, reads, bitcoinNetwork, committee, operations, payments, pendingBlocks, capacity }); this.gate = serial();
    this.mintWork = new KeyedWork();
    this.resources = assetResources(resources);
  }
  async quote(input) {
    if (input.request) return this.request(input);
    const { asset, block, amount, deployment, kind = 'tap', receiver = null, payer = null } = input;
    let { feeQuote } = input;
    check(['tap', 'ethereum'].includes(kind) && (this.financial ? financialAsset(asset) : rules.assetId(asset)), 'quote_input');
    const needed = await this.deploymentNeeded(asset, { block, amount, kind, receiver });
    if (needed) return needed;
    check(this.reads.feeQuotes, 'fee_quotes_unavailable', 503);
    const scope = mintFeeScope(asset, block, kind);
    if (feeQuote) await this.reads.feeQuotes.validate(feeQuote, scope);
    const context = await this.reads.assetContext(asset, block, kind, feeQuote, undefined, deployment), d = context?.deployment;
    check(d?.active && ['dmt', 'compound'].includes(d.kind) && (d.kind === 'dmt') === (this.financial ? rules.ordinalCodec(typeof block === 'string').valid(block) : Number.isSafeInteger(block)), 'deployment');
    check(d.kind !== 'dmt' || context.find?.finder, 'mint_no_find');
    const holder = context.link ? await this.reads.bitmap(block) : null;
    check(!context.link || holder?.agent && holder.address, 'bitmap_unavailable', 503);
    const feeKind = d.kind === 'dmt' ? 'find' : 'compound', counted = await this.reads.counted();
    feeQuote ??= await this.reads.feeQuotes.issue(scope, counted, context.payouts, d.id, hash(rules.stableJSON({ bitmap: holder, link: context.link ?? null, ...(context.assetRevision ? { assetRevision: context.assetRevision } : {}) })));
    await this.reads.feeQuotes.validate(feeQuote, scope);
    if (context.payouts) check(same(context.payouts, feeQuote.payouts), 'binding_snapshot_missing');
    if (feeQuote.mintOwnershipHash) check(mintOwnershipMatches(feeQuote, { bitmap: holder, link: context.link ?? null, assetRevision: context.assetRevision }), 'quote_recipient_changed');
    const baseFee = feeQuote.baseFee, price = rules.feeFor(feeKind, baseFee, context.tier, feeQuote.feeSettings ?? context.feeSettings, counted);
    const splitOptions = { kind: feeKind, linked: !!holder, discovered: !!(this.financial && feeQuote.settingsHash ? context.beneficiaries?.discoverer ?? context.discoverer : context.discoverer) };
    const policy = this.financial && feeQuote.settingsHash ? await this.reads.financialSettings(feeQuote.settingsHash) : null;
    check(!this.financial || !rules.multiTickerActive(counted) || policy, 'financial_settings_required');
    if (policy) check(rules.hashObject(policy) === feeQuote.settingsHash, 'financial_settings_history');
    const baseSplit = policy ? financialSplit(price, splitOptions, policy) : rules.splitFee(price, splitOptions);
    const { split, legacyDeploy, deployer } = rules.deploymentHolderFee(price, baseSplit, { kind: feeKind, deployment: d, document: policy, height: counted, bitcoinNetwork: this.bitcoinNetwork });
    const unitsUsed = d.kind === 'dmt' ? String(context.find.count) : amount ?? '1';
    check(typeof unitsUsed === 'string' && /^[1-9][0-9]{0,19}$/.test(unitsUsed) && BigInt(unitsUsed) <= 18446744073709551615n && (amount === undefined || amount === unitsUsed), 'quote_amount');
    const destinations = { treasury: context.treasury, finder: context.finderAddress ?? null, firstMaker: context.firstMakerAddress ?? null,
      landowner: kind === 'ethereum' ? context.landownerAddress ?? null : holder?.address ?? null, discoverer: context.discoverer ?? null };
    const plan = this.financial && feeQuote.settingsHash && this.reads.financialFeePlan ? this.reads.financialFeePlan({ split, destinations, beneficiaries: context.beneficiaries, id: null, payer, rail: kind }) : null;
    const fees = plan?.fees ?? rules.mintFeeItems(split, destinations, null, payer, kind, this.bitcoinNetwork);
    const untilBlock = this.financial ? rules.ordinalCodec(typeof counted === 'string').add(counted, policy?.values.pendingBlocks ?? this.pendingBlocks) : counted + this.pendingBlocks;
    return { requestId: null, receiver, asset, amount: unitsUsed, fees, payBy: { rail: kind, untilBlock }, payable: false,
      displayLabel: context.displayLabel ?? asset, actualTicker: d.tick, deploymentId: d.id, generation: d.generation ?? 1, jobState: 'registered',
      ...(block === undefined ? {} : { block }), kind, baseFee, feeSettings: feeQuote.feeSettings ?? context.feeSettings ?? rules.FEE_DEFAULTS, unit: rules.TAP_UNIT, feeQuote, price, split, ...(legacyDeploy ? { legacyDeploy } : {}), ...(deployer ? { deployer } : {}), networkFeeSats: '0',
      networkFeePayment: 'player_wallet', destinations, ...(plan ? { custody: plan.custody, beneficiaries: context.beneficiaries ?? {} } : {}), counted, unitsUsed, matterUnit: { asset, denomination: 'units', decimals: 0 },
      feeDestinations: Object.fromEntries(fees.map(f => [f.role, { amount: f.amount, to: f.to, settlement: f.role === 'burn' ? 'burn' : 'direct' }])) };
  }
  async deploymentNeeded(asset, details = {}) {
    if (!this.provisioner) return null;
    const resolved = await mintAssetDefinition(this.store, asset);
    const deployment = await this.provisioner.request(resolved.asset, resolved.definition, { registeredAsIs: true });
    if (deployment.state === 'registered') return null;
    return { ...details, requestId: null, asset: resolved.asset, catalogAsset: resolved.catalogAsset, state: 'deployment_needed', deploymentNeeded: true,
      message: 'Deployment needed. Inscribe the supplied content from your own Bitcoin wallet before requesting the mint.',
      payable: false, reservation: 'none', fees: [], missing: [], blocked: ['deployment_needed'],
      deployment: { ...deployment, catalogAsset: resolved.catalogAsset }, deploymentPath: '/mint/deployment/' + resolved.asset,
      deploymentPage: '/mint/' + resolved.catalogAsset };
  }
  request(body) { return this.mintWork.run(body.request?.owner, async () => {
    const { request, signature, receiver, payer, kind } = body, counted = await this.reads.counted();
    check(typeof receiver === 'string' && receiver.length > 0 && receiver.length <= 128 && hash(receiver) === request?.receive, 'receiver_binding');
    check(typeof payer === 'string' && payer.length > 0 && payer.length <= 128 && verifyPayer(this.network, body), 'payer_authorization');
    const id = rules.pendingId(this.network, request), prior = this.store.get('mints', id);
    if (prior) { check(prior.payer === payer && prior.kind === kind && prior.receiver === receiver && same(prior.request, request) && prior.signature === signature, 'request_conflict', 409); return publicMint(prior); }
    check(rules.verifyRequest('rq', this.network, request, signature, counted), 'owner_signature');
    check(request.expires - counted >= SETTING_BOUNDS.pending_blocks[0] && request.expires - counted <= SETTING_BOUNDS.pending_blocks[1], 'request_expiry');
    check(this.operations.supportsMintBatches === true, 'mint_batch_replay_unavailable', 503);
    check(await migrateMintAdmission(this.store, this.resources.workPage), 'mint_index_warming', 503);
    check(this.store.countUint('activeMints') < this.capacity, 'mint_capacity', 503);
    check(this.store.countUint(activeOwnerSpace(request.owner)) < this.resources.mintsPerAgent, 'mint_sender_capacity', 429);
    const quote = await this.quote({ asset: request.asset, block: request.block, amount: request.amount, kind, feeQuote: body.feeQuote });
    if (quote.deploymentNeeded) return quote;
    quote.fullFees = rules.mintFeeItems(quote.split, quote.destinations, id, null, kind, this.bitcoinNetwork);
    quote.fees = rules.mintFeeItems(quote.split, quote.destinations, id, payer, kind, this.bitcoinNetwork);
    quote.payableAmount = quote.fees.reduce((n, f) => n + BigInt(f.amount), 0n).toString();
    const feeAuthorization = await this.reads.feeQuotes.accept(quote.feeQuote, mintFeeScope(request.asset, request.block, kind), id, request.expires, counted);
    const context = await this.reads.assetContext(request.asset, request.block, kind, quote.feeQuote), compound = context.deployment.kind === 'compound';
    check(compound || context.find?.finder, 'mint_no_find');
    const holder = context.link ? await this.reads.bitmap(request.block) : null, key = compound ? null : `${request.asset}/${request.block}`;
    const minted = compound ? false : await this.reads.isMinted(context.deployment.id, context.deployment.tick, request.block);
    const balance = BigInt(await this.reads.balance(request.owner, request.asset));
    return this.gate(async () => {
    check(this.store.countUint('activeMints') < this.capacity, 'mint_capacity', 503);
    check(this.store.countUint(activeOwnerSpace(request.owner)) < this.resources.mintsPerAgent, 'mint_sender_capacity', 429);
    const hold = key ? this.store.get('holds', key) : null;
    check(!hold || counted > hold.expiry && hold.safeToReplace === true, 'block_pending', 409);
    const reserved = reservedFor(this.store, { request }, this.resources.workPage);
    const accepted = rules.acceptMintRequest({ request, sig: signature, network: this.network, counted, compound, find: context.find, link: context.link,
      currentHolder: holder?.agent, minted, balance: (balance - reserved).toString(), settings: { pendingBlocks: this.pendingBlocks } });
    const creditIds = await selectCredits(this.store, { owner: request.owner, payer, rail: kind, fees: quote.fees }, this.resources);
    const row = { id, request, signature, receiver, payer, kind, authorization: body.authorization, requestedFeeQuote: body.feeQuote ?? null,
      quote, context, feeAuthorization, key, state: 'reserving', acceptedAt: counted, deadline: request.until, op: accepted.op, paymentIds: [], creditIds };
    await this.store.transact([{ space: 'mints', id, value: row }, { space: 'activeMints', id, value: true },
      { space: activeOwnerSpace(request.owner), id, value: true }, { space: reservingSpace(row), id, value: request.amount },
      ...creditIds.map(sourceId => ({ space: 'creditClaims', id: sourceId, value: id })),
      ...(key ? [{ space: 'holds', id: key, value: { id, expiry: request.expires, safeToReplace: false } }] : [])]);
    return publicMint(row);
    });
  }); }
  payment({ id, requestId, paymentId, paymentIds = [], inscription }) { return this.mintWork.run(this.store.get('mints', id ?? requestId)?.request.owner ?? id ?? requestId, async () => {
    id ??= requestId;
    const row = this.store.get('mints', id); check(row, 'request_not_found', 404);
    if (inscription) {
      check(row.permit && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(inscription), 'mint_inscription');
      await this.save({ ...row, mintInscription: inscription }); return this.public(id);
    }
    check(row.state !== 'reserving' && !row.permit, 'payment_state', 409);
    check(Array.isArray(paymentIds) && paymentIds.length <= 64, 'payment_ids');
    const ids = [...new Set([...(row.paymentIds ?? []), ...(paymentId ? [paymentId] : []), ...paymentIds])];
    check(ids.length <= 64 && ids.every(p => typeof p === 'string' && p.length > 0 && p.length <= 160), 'payment_id');
    const candidate = { ...row, paymentIds: ids }, payment = await this.payments.mint(candidate);
    check(payment.receipts.some(p => p.accepted), 'payment_unseen');
    await this.save(candidate); await this.refresh(candidate, await this.reads.counted(), payment);
    return this.public(id);
  }); }
  public(id) { const r = this.store.get('mints', id); check(r, 'request_not_found', 404); const status = publicMint(r); return this.mintSender?.decorate(r, status) ?? status; }
  async save(row) { await this.store.transact([{ space: 'mints', id: row.id, value: row },
    ...(row.state !== 'reserving' ? [{ space: reservingSpace(row), id: row.id }] : [])]); return row; }
  async supervise() { /* No service transaction can need cancellation. */ }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      const counted = await this.reads.counted();
      await migrateCreditPage(this.store, this.resources.creditPage);
      await migrateMintAdmission(this.store, this.resources.workPage);
      const ids = new Set();
      this.cursors ??= {};
      for (const space of ['activeMints', 'expiredMints', 'issuedMints']) {
        const page = this.store.list(space, { after: this.cursors[space] ?? '', limit: this.resources.workPage });
        this.cursors[space] = page.length === this.resources.workPage ? page.at(-1).id : '';
        for (const row of page) ids.add(row.id);
      }
      const owners = new Map();
      for (const id of ids) {
        const owner = this.store.get('mints', id)?.request.owner ?? id;
        if (!owners.has(owner)) owners.set(owner, []);
        owners.get(owner).push(id);
      }
      await parallelPage([...owners], async ([owner, requests]) => {
        if (this.mintWork.pending.has(owner)) return;
        await this.mintWork.run(owner, async () => {
          for (const id of requests) {
            try { await this.advance(this.store.get('mints', id), counted); }
            catch (e) { const r = this.store.get('mints', id); await this.save({ ...r, lastError: /^[a-z][a-z0-9_]{0,80}$/.test(e.message) ? e.message : 'dependency_unavailable', checkedAt: counted }); }
          }
        });
      });
    } finally { this.running = false; }
  }
  async expire(row, counted, receipts = []) {
    const credit = receipts.filter(r => r.origin === row.id && r.accepted && r.confirmations >= 1 && BigInt(r.amount) > BigInt(r.used ?? '0'));
    await this.store.transact([{ space: 'mints', id: row.id, value: { ...row, state: 'expired', credit, reason: credit.length ? 'payment_credit' : 'unpaid_expired' } },
      { space: 'activeMints', id: row.id }, { space: 'expiredMints', id: row.id, value: true },
      ...releaseAdmission(row),
      ...releaseCreditClaims(this.store, row), ...creditOperations(this.store, row, credit),
      ...(row.key && this.store.get('holds', row.key)?.id === row.id ? [{ space: 'holds', id: row.key, value: { id: row.id, expiry: counted - 1, safeToReplace: true } }] : [])]);
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
        { space: activeOwnerSpace(row.request.owner), id: row.id, value: true },
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
      if (this.verifyMint(row, o)) await this.store.transact([...(row.key ? [
        { space: 'minted', id: row.key, value: { id: row.id, inscription: o.inscription } },
        { space: 'feedBlockChanges', id: 'mint/' + row.key, value: { block: row.request.block, asset: row.request.asset } }
      ] : []), { space: 'mints', id: row.id, value: { ...row, state: 'minted', observation: o } }, { space: 'issuedMints', id: row.id }, ...releaseCreditClaims(this.store, row)]);
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
        ...releaseAdmission(row),
        ...releaseCreditClaims(this.store, row), ...creditOperations(this.store, row, surplusReceipts(row))]);
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
