import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { assetResources } from './asset-resources.mjs';
import { publicMint } from './mints.mjs';
import { KeyedWork } from './keyed-work.mjs';
import { newRequesterSecret, requesterSecretHash, matchesRequesterSecret } from './public-mint-privacy.mjs';
import { publicPaymentReceipts } from './public-mint-discovery.mjs';
import { lookupSettings } from '../prod/lookup-settings.mjs';
import { capacityKey } from '../../contract/financial-capacity.js';

const sum = values => values.reduce((n, value) => n + BigInt(value), 0n).toString();
const inscription = id => typeof id === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(id);
const snapshot = at => rules.hashObject(Object.fromEntries(['counted', 'tip', 'tipHash', 'last', 'tap', 'batchRoot', 'authority', 'admissionPolicy'].map(k => [k, at?.[k] ?? null])));
const safeReason = error => /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'public_bulk_source_unavailable';
function orderState({ counts: c, members, rows, reported, checked, expired, registered }) {
  if (c.minted === c.total) return 'minted';
  if (c.refundable === c.total) return members.every(m => m.refunds.every(r => r.refundDelivery?.state === 'refund_confirmed')) ? 'refunded' : 'refundable';
  if (c.minted + c.refundable === c.total) return 'completed_with_refunds';
  if (c.minting) return 'minting';
  if (checked && c.unpaid) return c.minted + c.refundable > 0 && c.minted + c.refundable + c.unpaid === c.total ? 'completed_partial' : 'partly_paid';
  if (reported) return rows.some(r => r.paymentIds.length) ? 'scanning' : 'confirming';
  if (expired) return 'expired';
  if (members.some(m => !['awaiting_payment', 'scanning'].includes(m.state))) return 'unavailable';
  return registered ? 'awaiting_payment' : 'registering';
}

// A local checkout groups ordinary public requests. Consensus still verifies
// each plot and each transfer item independently, including losing refunds.
export class PublicBulkMints {
  constructor(single) {
    this.single = single;
    const resources = assetResources(single.parent.resources);
    this.work = new KeyedWork({ concurrency: Math.min(resources.workPage, resources.mintInputCapacity), capacity: resources.mintInputCapacity });
  }
  get parent() { return this.single.parent; }
  get store() { return this.single.store; }
  get reads() { return this.single.reads; }
  get resources() { return assetResources(this.parent.resources); }
  get document() { return this.single.document; }
  input(input, start) {
    check(input && rules.exactKeys(input, ['asset', 'blocks', 'tapAddress', ...(start ? ['nonce'] : []),
      ...(input.deployment === undefined ? [] : ['deployment'])]), 'public_bulk_input');
    check(typeof input.asset === 'string' && /^p(?:2:(?:0|[1-9][0-9]*)|[0-9a-z]+)$/.test(input.asset) &&
      typeof input.tapAddress === 'string' && (!start || rules.hex(input.nonce, 32)), 'public_bulk_input');
    check(Array.isArray(input.blocks) && input.blocks.length > 0 && input.blocks.length <= this.resources.publicBulkMintBlocks &&
      input.blocks.every(b => typeof b === 'string' && /^(0|[1-9][0-9]*)$/.test(b)) &&
      new Set(input.blocks).size === input.blocks.length, 'public_bulk_blocks');
    check(input.deployment === undefined || typeof input.deployment === 'string' && input.deployment.length > 0, 'public_bulk_input');
    check(Buffer.byteLength(rules.stableJSON(input)) <= this.resources.publicBulkInputBytes, 'public_bulk_input_bytes', 413);
    return structuredClone(input);
  }
  async ingress() {
    const height = this.single.active();
    check(rules.publicPaymentV2Active(this.document, height), 'public_bulk_payment_version', 409);
    check(this.parent.mintSender?.settings?.enabled && this.parent.mintSender.ready(), 'public_bulk_sender_unavailable', 503);
  }
  async prepare(input, orderId) {
    await this.ingress();
    const at = await this.reads.batchStamp(), document = this.document, rows = [];
    for (const block of input.blocks) {
      const row = await this.single.quote({ asset: input.asset, block, tapAddress: input.tapAddress,
        ...(input.deployment ? { deployment: input.deployment } : {}) }, false, { prepareOnly: true, at, publicBulkOrderId: orderId });
      check(row.id && row.intent?.publicBulkOrderId === orderId && row.paymentRegistration, 'public_bulk_deployment_pending', 409);
      rows.push(this.parent.mintSender.bind(row));
    }
    check(rows.every(row => row.mintFunding && row.intent.settingsHash === rules.hashObject(document) &&
      row.quote.deploymentId === rows[0].quote.deploymentId && row.created === rows[0].created && row.expiry === rows[0].expiry), 'public_bulk_quote_changed', 409);
    const deployment = rows[0].context.deployment, amount = BigInt(sum(rows.map(row => row.request.amount)));
    const [generation, reserved, imported] = await Promise.all([
      this.reads.financialRecord(deployment.officialDeployment ? 'fd/external/' + rules.hashObject(deployment.id) : 'fd/asset/' + rows[0].request.asset, at),
      this.reads.financialRecord(capacityKey(deployment.id), at), this.reads.financialRecord('fi/deployment/' + deployment.id, at)
    ]);
    const registered = generation && await this.reads.financialRecord('fd/' + generation, at);
    check(registered?.deployment === deployment.id, 'public_bulk_deployment_pending', 409);
    const held = BigInt(this.store.get('financialAdmissionCapacity', capacityKey(deployment.id)) ?? '0');
    check(rows.every(row => BigInt(row.context.deployment.remaining) >= amount + BigInt(reserved ?? '0') + BigInt(imported ?? '0') + held &&
      (BigInt(row.context.deployment.limit ?? '0') === 0n || BigInt(row.request.amount) <= BigInt(row.context.deployment.limit))) &&
      amount + held <= BigInt(registered.maximum) - BigInt(registered.minted) - BigInt(registered.reserved), 'public_bulk_capacity', 409);
    check(snapshot(at) === snapshot(await this.reads.batchStamp()) && document === this.document, 'financial_snapshot_changed', 503);
    check(rows.every(row => Date.now() <= row.quote.feeQuote.expiresAt), 'fee_quote_expired', 409);
    const items = rules.walletFeeItems(rows.flatMap(row => row.quote.fees), this.parent.bitcoinNetwork);
    // Reserve the complete token-auth envelope, including maximal signature
    // scalars and inscription index, against the reader's existing byte budget.
    const packet = { p: 'tap', op: 'token-auth', redeem: { auth: 'f'.repeat(64) + 'i4294967295', items },
      hash: 'f'.repeat(64), salt: 'f'.repeat(64), sig: { r: '9'.repeat(78), s: '9'.repeat(78), v: 1 } };
    check(Buffer.byteLength(JSON.stringify(packet)) <= lookupSettings(this.reads.lookups?.settings).inscriptionBytes, 'public_bulk_payment_bytes', 413);
    return rows;
  }
  bounded(value) {
    check(Buffer.byteLength(JSON.stringify(value)) <= this.resources.publicBulkResponseBytes, 'public_bulk_response_bytes', 413);
    return value;
  }
  async quote(input) {
    input = this.input(input, false);
    return this.work.run('quote/' + rules.hashObject(input), async () => {
      const rows = await this.prepare(input, rules.hashObject(['dmw-public-bulk-preview-v1', this.parent.network, input]));
      return this.bounded({ v: 1, publicBulk: true, orderId: null, state: 'quote', payable: false, reservation: 'none', unitsConsumed: false,
        asset: input.asset, payer: input.tapAddress, receiver: input.tapAddress, limits: { blocks: this.resources.publicBulkMintBlocks },
        price: sum(rows.map(r => r.quote.price)), payableAmount: sum(rows.map(r => r.quote.payableAmount)), unit: rules.TAP_UNIT,
        payBy: { rail: 'tap', untilBlock: rows[0].expiry, expiresAt: Math.min(...rows.map(r => r.quote.feeQuote.expiresAt)) },
        mintFundingEstimate: { satoshis: sum(rows.map(r => r.mintFunding.satoshis)) },
        members: rows.map(r => ({ ...publicMint(r), id: null, requestId: null, payable: false, reservation: 'none',
          fees: r.quote.fees.map(({ dta, ...fee }) => fee), fullFees: undefined, missing: [], mintFundingEstimate: { satoshis: r.mintFunding.satoshis } })),
        redeem: { items: [], data: '', actions: [] }, extraOutputs: [] });
    }, { join: true });
  }
  async start(input, { requesterSecret, clientIP } = {}) {
    const priorId = rules.hex(input?.nonce, 32) && typeof input.tapAddress === 'string' &&
      rules.hashObject(['dmw-public-bulk-order-v1', this.parent.network, input.tapAddress, input.nonce]);
    const prior = priorId && this.store.get('publicBulkOrders', priorId);
    if (prior) {
      check(prior.fingerprint === rules.hashObject(input), 'public_bulk_conflict', 409);
      this.authorize(prior, requesterSecret);
      return this.status(priorId, requesterSecret);
    }
    input = this.input(input, true);
    check(requesterSecret === undefined || rules.hex(requesterSecret, 32), 'public_bulk_requester_secret');
    const secret = requesterSecret ?? newRequesterSecret(), fingerprint = rules.hashObject(input);
    const id = rules.hashObject(['dmw-public-bulk-order-v1', this.parent.network, input.tapAddress, input.nonce]);
    let created = false;
    await this.work.run(id, async () => {
      const old = this.store.get('publicBulkOrders', id);
      if (old) return;
      const ipHash = await this.single.admission.start(clientIP), rows = await this.prepare(input, id);
      const order = { id, input, fingerprint, members: rows.map(r => r.id), requesterSecretHash: requesterSecretHash(secret),
        created: rows[0].created, expiry: rows[0].expiry, expiresAt: Math.min(...rows.map(r => r.quote.feeQuote.expiresAt)), paymentIds: [] };
      // Verify the final response budget before creating any durable checkout.
      this.bounded({ order, requesterSecret: secret, members: rows.map(row => ({ ...publicMint(row), payer: row.payer,
        publicMint: true, publicBulkOrderId: id, catalogAsset: row.catalogAsset, unitsConsumed: false, refunds: [], winner: null,
        paymentPage: '/mint/' + row.id, mintFunding: row.mintFunding, mintSender: { state: 'waiting_funding' } })),
        redeem: { items: rules.walletFeeItems(rows.flatMap(row => row.quote.fees), this.parent.bitcoinNetwork), data: '', actions: [] },
        extraOutputs: rows.map(row => row.mintFunding) });
      await this.single.admission.admitMany(rows.map(r => ({ ...r, requesterSecretHash: order.requesterSecretHash })), ipHash, admitted =>
        this.store.transact([{ space: 'publicBulkOrders', id, value: order }, ...admitted.flatMap(row => [
          { space: 'mints', id: row.id, value: row }, { space: 'publicMintRequests', id: row.id, value: true },
          { space: 'publicMintCommitments', id: row.paymentRegistration.commitment, value: row.id },
          { space: 'publicMintPlots', id: rules.publicPlotId(row.request.asset, row.request.block, row.intent.supplyScope),
            value: { asset: row.request.asset, block: row.request.block, ...(row.intent.supplyScope ? { deployment: row.intent.supplyScope } : {}) } }
        ])]));
      created = true;
      // Existing single-request ticks register these durable members. Starting
      // 64 members does not wait for 64 consensus submissions in an HTTP call.
    }, { join: true });
    const order = this.row(id);
    check(order.fingerprint === fingerprint, 'public_bulk_conflict', 409);
    this.authorize(order, secret);
    return { ...this.status(id, secret), ...(created ? { requesterSecret: secret } : {}) };
  }
  row(id) {
    check(rules.hex(id, 32), 'public_bulk_order_id');
    const order = this.store.get('publicBulkOrders', id); check(order, 'public_bulk_not_found', 404); return order;
  }
  authorize(order, secret) { check(matchesRequesterSecret(order.requesterSecretHash, secret), 'public_mint_requester_required', 403); }
  status(id, secret) {
    const order = this.row(id), authorized = matchesRequesterSecret(order.requesterSecretHash, secret);
    const rows = order.members.map(id => this.store.get('mints', id));
    check(rows.every(Boolean), 'public_bulk_recovery_pending', 503);
    const members = order.members.map(id => this.single.public(id, secret));
    const counts = { total: members.length, minted: 0, minting: 0, refundable: 0, unpaid: 0 };
    for (const m of members) {
      if (m.state === 'minted') counts.minted++;
      else if (m.mintContent || m.winner?.id === m.requestId) counts.minting++;
      else if (m.refunds?.length) counts.refundable++;
      else if (!m.payment?.length) counts.unpaid++;
    }
    const expired = BigInt(this.store.get('meta', 'ruleState')?.counted ?? order.created) > BigInt(order.expiry) || Date.now() > order.expiresAt;
    const registered = rows.every(r => this.store.get('accountRecords', rules.publicPaymentKey(r.paymentRegistration.commitment)));
    const reported = order.paymentIds.length > 0 || rows.some(r => r.paymentIds.length > 0);
    const checked = reported && order.paymentPending === false && !order.lastError;
    const state = orderState({ counts, members, rows, reported, checked, expired, registered });
    const payable = authorized && state === 'awaiting_payment' && members.every(m => m.payable) && this.parent.mintSender?.ready();
    const result = { v: 1, publicBulk: true, orderId: id, state, payable: !!payable, reservation: 'none', unitsConsumed: false,
      counts, limits: { blocks: this.resources.publicBulkMintBlocks }, payBy: { rail: 'tap', untilBlock: order.expiry, expiresAt: order.expiresAt },
      paymentIds: order.paymentIds, ...(authorized ? {} : { requesterRequired: true }) };
    if (!authorized) return result;
    return this.bounded({ ...result, asset: order.input.asset, ...(order.input.deployment ? { deployment: order.input.deployment } : {}),
      payer: order.input.tapAddress, receiver: order.input.tapAddress, bitcoinNetwork: this.parent.bitcoinNetwork,
      price: sum(rows.map(r => r.quote.price)), payableAmount: sum(rows.map(r => r.quote.payableAmount)), unit: rules.TAP_UNIT,
      mintFundingSatoshis: sum(rows.map(r => r.mintFunding.satoshis)), members,
      redeem: { items: payable ? rules.walletFeeItems(rows.flatMap(r => r.quote.fees), this.parent.bitcoinNetwork) : [], data: '', actions: [] },
      extraOutputs: payable ? rows.map(r => ({ address: r.mintFunding.address, satoshis: r.mintFunding.satoshis, label: r.mintFunding.label })) : [],
      ...(order.lastError ? { retryReason: order.lastError } : {}) });
  }
  async payment(id, input, secret) {
    const order = this.row(id); this.authorize(order, secret);
    check(input && rules.exactKeys(input, [...(input.paymentId === undefined ? [] : ['paymentId']), ...(input.paymentIds === undefined ? [] : ['paymentIds'])]) &&
      (input.paymentIds === undefined || Array.isArray(input.paymentIds)), 'payment_id');
    const ids = [...new Set([...(input.paymentIds ?? []), ...(input.paymentId ? [input.paymentId] : [])])];
    check(ids.length > 0 && ids.length <= this.document.values.paymentPage && ids.every(inscription), 'payment_id');
    await this.work.run(id, async () => {
      const current = this.row(id), all = [...new Set([...current.paymentIds, ...ids])];
      check(all.length <= this.document.values.paymentPage, 'payment_id');
      await this.store.transact([{ space: 'publicBulkOrders', id, value: { ...current, paymentIds: all, paymentPending: true } },
        { space: 'publicBulkPending', id, value: true }]);
      await this.reconcile(id);
    }, { after: true });
    return this.status(id, secret);
  }
  async reconcile(id) {
    const order = this.row(id);
    try {
      const at = await this.reads.batchStamp();
      let pending = false;
      for (const paymentId of order.paymentIds) {
        const inclusion = await this.reads.included(paymentId, at);
        if (!inclusion || inclusion.confirmations < 1) { pending = true; continue; }
        let matched = false;
        for (const member of order.members) {
          const task = async () => {
            const row = this.store.get('mints', member);
            if (row.paymentIds.includes(paymentId)) { matched = true; return; }
            const receipts = await publicPaymentReceipts(this.reads, row, [paymentId], at);
            if (!receipts.length) {
              const payload = await this.reads.content(paymentId);
              // Bitcoin inclusion alone does not prove the TAP index has
              // resolved an item. Retain its hint while a matching fee item
              // has no independently verified positive receipt.
              if (payload?.redeem?.items?.some(item => row.quote.fees.some(fee => fee.dta === item.dta && fee.to === item.address &&
                fee.ticker === item.tick) && BigInt(rules.parseTapAmount(item.amt)) > 0n)) pending = true;
              return;
            }
            matched = true;
            await this.single.queuePlot(row.request.asset, row.request.block, receipts.reduce((h, r) => BigInt(r.verifiedHeight) > BigInt(h) ? r.verifiedHeight : h, '0'),
              [{ space: 'mints', id: member, value: { ...row, paymentIds: [...new Set([...row.paymentIds, paymentId])], state: row.permit ? row.state : 'scanning' } }], row.intent.supplyScope);
          };
          if (this.parent.mintWork) await this.parent.mintWork.run(member, task, { after: true }); else await task();
        }
        if (!matched) pending = true;
      }
      await this.store.transact([{ space: 'publicBulkOrders', id, value: { ...this.row(id), paymentPending: pending, lastError: null } },
        ...(!pending ? [{ space: 'publicBulkPending', id }] : [])]);
    } catch (error) {
      await this.store.put('publicBulkOrders', id, { ...this.row(id), lastError: safeReason(error) });
    }
  }
  async inscriptions(id, input, secret) {
    const order = this.row(id); this.authorize(order, secret);
    check(input && rules.exactKeys(input, ['inscriptions']) && Array.isArray(input.inscriptions) && input.inscriptions.length > 0 &&
      input.inscriptions.length <= order.members.length && new Set(input.inscriptions.map(r => r?.requestId)).size === input.inscriptions.length &&
      input.inscriptions.every(r => r && rules.exactKeys(r, ['requestId', 'inscription']) && order.members.includes(r.requestId) && inscription(r.inscription)), 'public_bulk_inscriptions');
    for (const report of input.inscriptions) check(this.store.get('mints', report.requestId)?.permit, 'mint_inscription');
    for (const report of input.inscriptions) await this.parent.payment({ id: report.requestId, inscription: report.inscription }, secret);
    return this.status(id, secret);
  }
  async tick() {
    const limit = this.parent.resources?.workPage ?? this.resources.workPage, after = this.store.get('meta', 'publicBulkPendingCursor') ?? '';
    let page = this.store.list('publicBulkPending', { after, limit });
    if (!page.length && after) page = this.store.list('publicBulkPending', { limit });
    for (const { id } of page) {
      try { await this.work.run(id, () => this.reconcile(id)); }
      catch (error) { if (error.message !== 'resource_busy') throw error; }
    }
    if (page.length || after) await this.store.put('meta', 'publicBulkPendingCursor', page.at(-1)?.id ?? '');
  }
}
