import { createPublicKey, verify } from 'node:crypto';
import { check, serial } from './util.mjs';
import { rules } from './rules.mjs';
import { publicIdentities, wireIdentities } from './public-identities.mjs';
import { verifyTapMessage, payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { calldata, TYPES, expectedEscrowSplit, escrowSplitForItems } from '../../committee/signer/escrow.mjs';
import { publicMint } from './mints.mjs';
import { publicMintTargetVisible, privatePublicMintView } from './public-mint-privacy.mjs';
import { createRecordHighlights } from './web-records.mjs';
import { linkFeePlan } from './link-fees.mjs';

export function webTarget(config) {
  check(['prod', 'regtest'].includes(config.mode), 'web_target_unavailable', 503);
  const eth = config.mode === 'prod' ? config.prod?.ethereum : config.local?.escrow;
  if (config.mode === 'prod') {
    check(!config.local && !config.endpoints && String(eth?.chainId) === '1', 'web_target_unavailable', 503);
  }
  const bitcoinNetwork = config.mode === 'regtest' ? 'regtest' : 'mainnet';
  check(eth && /^[1-9][0-9]*$/.test(String(eth.chainId)), 'web_target_unavailable', 503);
  return { network: config.network, bitcoinNetwork, ethereum: { chainId: '0x' + BigInt(eth.chainId).toString(16),
    token: eth.token, escrow: eth.address, ...(bitcoinNetwork === 'regtest' ? { localRpc: config.endpoints.ethereum } : {}) } };
}
export const linkWalletMessage = (network, id, paymentHash) => `dmw-link-payment-v1\n${network}\n${id}\n${paymentHash}`;

// Only public, bounded checkout projections. No whole row, registry, RPC URL,
// agent signature, wallet journal or committee secret is sent to the browser.
export class WebCheckout {
  constructor({ store, intents = store, config, reads, post, mints, bulkMints, links, inflight }) {
    Object.assign(this, { store, intents, reads, post, mints, bulkMints, links, inflight }); this.target = webTarget(config); this.gate = serial();
    this.records = createRecordHighlights(store);
  }
  enrollLink(input) { return this.gate(async () => {
    const body = wireIdentities(input), { request, sig, payer } = body;
    const digest = rules.paymentDigest(this.target.network, request, 'link'), id = rules.bytesToHex(digest);
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(request.owner, 'hex')]), format: 'der', type: 'spki' });
    check(rules.hex(sig, 64) && verify(null, digest, key, Buffer.from(sig, 'hex')), 'link_signature');
    payoutAddress('tap', payer, this.target.bitcoinNetwork);
    const old = this.intents.get('webLinkIntents', id);
    if (old) check(rules.stableJSON(old.body) === rules.stableJSON(body), 'link_terms_conflict', 409);
    else {
      const counted = await this.reads.counted();
      check(request.height <= counted && request.until > counted && request.until <= counted + 2016, 'link_deadline');
      const holder = await this.reads.bitmap(request.height);
      check(holder.agent === request.owner && holder.address === payer && await this.reads.link(request.height) === null, 'link_owner');
      // Bound enrollment independently of the gateway's active-link limit.
      const pending = this.intents.list('webLinkIntents', { limit: 257 }).filter(r => r.value.body.request.until >= counted);
      check(pending.length < 256, 'link_capacity', 503);
      check(pending.filter(r => r.value.body.request.owner === request.owner).length < 8, 'link_sender_capacity', 429);
      for (const r of this.intents.list('webLinkIntents', { limit: 257 })) if (r.value.body.request.until < counted) await this.intents.transact([{ space: 'webLinkIntents', id: r.id }]);
      await this.intents.put('webLinkIntents', id, { body });
    }
    return { id, state: 'awaiting_wallet', terms: { payer }, paymentLink: `/link/${id}` };
  }); }
  prepareLink(id, { paymentHash, walletSignature }) { return this.gate(async () => {
    const saved = this.intents.get('webLinkIntents', id); check(saved, 'request_not_found', 404);
    check(rules.hex(paymentHash, 32), 'payment_hash');
    verifyTapMessage(linkWalletMessage(this.target.network, id, paymentHash), saved.body.payer, walletSignature, this.target.bitcoinNetwork);
    const holder = await this.reads.bitmap(saved.body.request.height);
    check(holder.agent === saved.body.request.owner && holder.address === saved.body.payer, 'link_owner');
    check(!saved.paymentHash || saved.paymentHash === paymentHash, 'link_terms_conflict', 409);
    // Record before admission, so an uncertain retry cannot change the hash.
    if (!saved.paymentHash) await this.intents.put('webLinkIntents', id, { ...saved, paymentHash });
    return this.post('/link/request', { ...saved.body, paymentHash });
  }); }
  async linkLock(id, paymentId) {
    check(rules.hex(id, 32) && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*):0$/.test(paymentId ?? ''), 'payment_request');
    const row = this.store.get('linkIntents', id); check(row, 'request_not_found', 404);
    let payment;
    try { payment = await this.reads.linkLockPayment({ ...row, id, paymentId }); }
    catch (error) {
      if (['payment_lock_missing', 'payment_unconfirmed', 'payment_consume_unconfirmed'].includes(error.message)) return { ready: false };
      throw error;
    }
    const { price, split } = await linkFeePlan(this.reads, row.terms);
    check(payment.id === paymentId && payment.requestId === id && payment.payer === row.terms.payer && payment.kind === 'tap' &&
      payment.tick === 'tap' && payment.lockKind === 'htlc' && payment.conditionType === 'hashlock' && payment.hash === row.terms.hash &&
      payment.refund === row.terms.payer && payment.claim === row.terms.treasury && payment.total === price && payment.base === split.treasury &&
      rules.stableJSON(payment.allocations) === rules.stableJSON(rules.tapPaymentAllocations(split, {}, 'link', this.target.bitcoinNetwork)) &&
      payment.refundAfter === (row.refundAfter ?? row.request.until + 144), 'link_tap');
    check(Number.isSafeInteger(payment.confirmations) && payment.confirmations >= 1 && typeof payment.consumed === 'boolean' &&
      Number.isSafeInteger(payment.verifiedHeight) && payment.verifiedHeight >= 0 && payment.verifiedHeight <= row.request.until &&
      Number.isSafeInteger(payment.eventIndex) && payment.eventIndex >= 0, 'link_payment');
    return { ready: !payment.consumed, consumed: payment.consumed, paymentId };
  }
  async plan(type, id, requesterSecret) {
    check(['mint', 'link'].includes(type) && rules.hex(id, 32), 'payment_request');
    if (type === 'link' && this.links?.financialVersion === 2 && this.store.get('financialLinks', id)) {
      // A sent fee payment the gateway has seen on Bitcoin shows to every viewer until it is counted (display only).
      const status = this.inflight ? this.inflight.decorate('link', await this.links.public(id)) : await this.links.public(id);
      return publicIdentities({ ...status, type, kind: 'tap', financialVersion: 2, target: this.target, counted: await this.reads.counted(), deadline: status.payBy.untilBlock,
        submit: '/link/payment', walletPreparation: false, bitcoinWalletRequired: status.price !== '0', refundAfter: null, networkFee: null,
        redeem: { items: status.payable ? rules.walletFeeItems(status.missing, this.target.bitcoinNetwork) : [], data: '', actions: [] } });
    }
    const row = this.store.get(type === 'mint' ? 'mints' : type + 'Intents', id);
    if (!row && type === 'link') {
      const pending = this.intents.get('webLinkIntents', id); check(pending, 'request_not_found', 404);
      const counted = await this.reads.counted();
      return publicIdentities({ id, type, kind: 'tap', state: counted > pending.body.request.until ? 'expired' : 'awaiting_wallet', owner: pending.body.request.owner,
        payer: pending.body.payer, block: pending.body.request.height, deadline: pending.body.request.until,
        counted, target: this.target, walletPreparation: true });
    }
    check(row, 'request_not_found', 404);
    if (type === 'mint' && row.publicMint) {
      const counted = await this.reads.counted();
      const raw = this.mints ? this.mints.public(id, requesterSecret) : publicMint(row, counted);
      const status = publicMintTargetVisible(this.store, row, requesterSecret) ? raw : privatePublicMintView(raw);
      return publicIdentities({ ...status, type, target: this.target, counted, deadline: row.expiry,
        refundAfter: null, networkFee: null, submit: '/mint/payment', walletPreparation: false, bitcoinWalletRequired: true,
        redeem: { items: status.payable && !status.blocked.length ? rules.walletFeeItems(status.missing, this.target.bitcoinNetwork) : [], data: '', actions: [] } });
    }
    const counted = await this.reads.counted(), mint = type === 'mint', kind = mint ? row.kind : 'tap';
    let state, payment;
    if (mint) { state = row.state; payment = row.paymentId; }
    else { state = this.store.get('linkStatus', id)?.state ?? 'waiting_payment'; payment = this.store.get('linkRequests', id)?.paymentId; }
    if (state === 'waiting_payment' && counted > (mint ? row.expiry : row.request.until)) state = 'expired';
    const quote = mint ? row.quote : { price: rules.feeFor(type, row.terms.baseFee, 1, row.terms.feeSettings, counted), baseFee: row.terms.baseFee, feeSettings: row.terms.feeSettings ?? rules.FEE_DEFAULTS,
      destinations: { treasury: row.terms.treasury }, split: (await linkFeePlan(this.reads, row.terms, { counted })).split };
    const payer = mint ? row.payer : row.terms.payer, refundAfter = mint ? row.expiry + 144 : row.refundAfter ?? row.request.until + 144;
    const plan = { id, type, kind, state, payer, owner: row.request.owner, receiver: row.receiver ?? null,
      asset: row.request.asset ?? null, block: row.request.block ?? row.request.height ?? null, amount: row.request.amount ?? null,
      target: this.target, counted, deadline: mint ? row.expiry : row.request.until, refundAfter,
      price: quote.price, baseFee: quote.baseFee, feeSettings: quote.feeSettings ?? rules.FEE_DEFAULTS, unit: rules.TAP_UNIT, split: quote.split, destinations: quote.destinations,
      payment: payment ?? null, inscription: row.observation?.inscription ?? null, reason: row.reason ?? null,
      networkFee: mint ? { address: row.networkFeeAddress, sats: quote.networkFeeSats } : null,
      submit: `/${type}/payment`, walletPreparation: false };
    if (mint) {
      Object.assign(plan, this.mints ? this.mints.public(id) : publicMint(row, counted), { refundAfter: null, networkFee: null });
      plan.bitcoinWalletRequired = true;
      plan.redeem = { items: row.kind === 'tap' && plan.payable && !plan.blocked.length ? rules.walletFeeItems(plan.missing, this.target.bitcoinNetwork) : [], data: '', actions: [] };
    } else if (kind === 'tap' && row.terms.hash) {
      plan.redeem = { items: [], data: id, actions: [rules.tapPaymentLock({ split: quote.split, destinations: quote.destinations,
        payer, hash: row.terms.hash, expiry: refundAfter, kind: type, bitcoinNetwork: this.target.bitcoinNetwork })] };
    }
    if (kind === 'ethereum') {
      const eth = this.target.ethereum, depositFees = row.payment?.depositFees ?? quote.fees;
      const split = mint ? escrowSplitForItems(depositFees) : expectedEscrowSplit(quote.split, quote.destinations, false, payer);
      const latest = await this.reads.ethRPC('eth_getBlockByNumber', ['latest', false]);
      // Same conservative 10-day escrow horizon as the playground wallet plan.
      let deposit;
      if (this.reads.escrowDeposit) {
        try { deposit = (await this.reads.escrowDeposit(payer, id)).deposit; }
        catch (e) { if (payment || e.message !== 'escrow_payer') throw e; }
      }
      const expiry = deposit?.expiry ?? (BigInt(latest.timestamp) + 864000n).toString();
      plan.ethereumRefundAfter = expiry;
      plan.ethereumDepositStatus = deposit?.status ?? 0;
      plan.ethereumRefundEligible = deposit?.status === 1 && BigInt(expiry) <= BigInt(latest.timestamp);
      const payableAmount = mint ? depositFees.reduce((n,f)=>n+BigInt(f.amount),0n).toString() : quote.price;
      plan.ethereumDepositAmount = payableAmount;
      plan.ethereumDepositSplit = split;
      plan.transactions = [{ from: payer, to: eth.token, data: calldata('approve(address,uint256)', [['address', eth.escrow], ['uint256', payableAmount]]) },
        { from: payer, to: eth.escrow, data: calldata('deposit(bytes32,uint256,(address,uint256,address,uint256,address,uint256,address,uint256,uint256),uint256)',
          [['bytes32', id], ['uint256', payableAmount], ...TYPES.Split.map(({ name, type }) => [type, split[name]]), ['uint256', expiry]]) }];
      if (payableAmount === '0' || deposit?.status) plan.transactions = [];
      plan.refundTransaction = { from: payer, to: eth.escrow, data: calldata('refund(address,bytes32)', [['address', payer], ['bytes32', id]]) };
    }
    return publicIdentities(plan);
  }
}
