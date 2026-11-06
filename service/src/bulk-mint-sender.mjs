import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { requestKey, validRequestId, validDestination } from './mint-sender-keys.mjs';
import { buildBulkInscriptionPlan, signBulkCommit } from '../../kit/lib/inscription-batch-core.mjs';
import { buildMintReturn } from './mint-sender.mjs';
import { validateDeployerPayment } from './direct-deployer.mjs';

export class BulkMintSender {
  constructor(sender) { this.sender = sender; this.lastDiscovery = 0; }
  save(row, change = {}) { return this.sender.journal.saveBulk({ ...row, ...change }); }
  async discover() {
    const s = this.sender;
    if (!s.gateway.bulkPage) return;
    const after = s.journal.meta('bulkCursor') ?? '';
    const page = await s.gateway.bulkPage({ after, limit: Math.min(50, s.settings.pageSize) });
    check(page.keyId === s.keyId && (page.next === null || validRequestId(page.next)) && page.rows.length <= Math.min(50, s.settings.pageSize), 'bulk_sender_gateway_identity');
    for (const item of page.rows) {
      check(validRequestId(item.orderId) && validRequestId(item.termsHash) && validDestination(item.payer, s.network) && validDestination(item.receiver, s.network) &&
        Number.isSafeInteger(item.count) && item.count > 0 && item.count <= 64 && Number.isSafeInteger(item.fundingSats) && item.fundingSats > 0 && item.fundingSats <= s.settings.maxFundingSats, 'bulk_sender_item');
      const key = requestKey(s.seed, item.orderId, s.network);
      try { check(item.fundingAddress === key.address, 'bulk_sender_funding_address'); } finally { key.privateKey.fill(0); }
      const prior = s.journal.bulk(item.orderId);
      if (prior) check(prior.termsHash === item.termsHash && prior.payer === item.payer && prior.receiver === item.receiver && prior.address === item.fundingAddress && prior.fundingSats === item.fundingSats && prior.count === item.count, 'bulk_sender_binding_changed');
      else this.save({ id: item.orderId, termsHash: item.termsHash, payer: item.payer, receiver: item.receiver, address: item.fundingAddress,
        fundingSats: item.fundingSats, count: item.count, state: 'waiting_funding', createdAt: s.now(), nextAttempt: 0 });
    }
    s.journal.meta('bulkCursor', page.next ?? ''); this.lastDiscovery = s.now();
  }
  async checkSpend(coin, expected) {
    const spend = await this.sender.bitcoin.outspend(coin);
    check(spend && (spend.spent === false || spend.spent === true && spend.txid === expected), 'bulk_funding_spent');
  }
  async send(row) {
    const s = this.sender, plan = row.plan;
    if (row.returnPlan) {
      await this.checkSpend(row.coin, row.returnPlan.txid);
      await s.bitcoin.broadcast(row.returnPlan.hex, row.returnPlan.txid);
      return this.save(row, { state: (await s.bitcoin.transaction(row.returnPlan.txid))?.confirmed ? 'returned' : 'returning' });
    }
    await this.checkSpend(row.coin, plan.commit.txid);
    await s.bitcoin.broadcast(plan.commit.hex, plan.commit.txid);
    for (const reveal of plan.reveals) {
      // A spent child input must belong to this exact saved child, including
      // the separate fee output. Never reconstruct a conflicting family.
      for (const index of [...reveal.members.map(m => m.index), row.count + reveal.batchIndex])
        await this.checkSpend({ txid: plan.commit.txid, vout: index }, reveal.txid);
      await s.bitcoin.broadcast(reveal.hex, reveal.txid);
      row = this.save(row, { sentBatches: Math.max(row.sentBatches ?? 0, reveal.batchIndex + 1) });
    }
    row = this.save(row, { state: 'sent', reason: null });
    // Reports are hints. B authenticates every mint and performs terminal
    // accounting; a successful broadcast/report is never relabelled minted.
    await s.gateway.reportBulkFinish({ orderId: row.id, members: plan.reveals.flatMap(r => r.members.map(m => ({ index: m.index, inscription: m.inscription }))) });
    return row;
  }
  async process(id) {
    const s = this.sender; let row = s.journal.bulk(id), response;
    try { response = await s.gateway.bulkItem(id); }
    catch (error) { if (!row.plan && !row.returnPlan) throw error; return this.send(row); }
    const { item, terms, permit: manifest, deployerPayment = null } = response;
    const { validateBulkTerms, bulkOrderId } = await import('../../rules/src/bulk-mint.js');
    validateBulkTerms(terms);
    check(response.keyId === s.keyId && item.orderId === id && bulkOrderId(terms.network, terms.owner, terms.nonce) === id &&
      rules.hashObject(terms) === row.termsHash && item.termsHash === row.termsHash && terms.bitcoinNetwork === s.network &&
      terms.payer === row.payer && terms.receiver === row.receiver && terms.mintFunding.address === row.address && terms.mintFunding.satoshis === row.fundingSats &&
      terms.members.length === row.count && item.payer === row.payer && item.receiver === row.receiver && item.fundingAddress === row.address && item.fundingSats === row.fundingSats && item.count === row.count, 'bulk_sender_binding_changed');
    if (deployerPayment) validateDeployerPayment(deployerPayment, terms, id);
    // An order first seen before its reservation was accepted has no side payment yet; the
    // accepted order then names it. Adopt it once, while nothing is planned or sent for the order.
    const adopt = row.deployerPayment === null && deployerPayment !== null && !row.plan && !row.returnPlan;
    if ('deployerPayment' in row && !adopt) check(rules.stableJSON(row.deployerPayment) === rules.stableJSON(deployerPayment), 'bulk_sender_binding_changed');
    else row = this.save(row, { deployerPayment });
    if (row.plan) {
      check(!item.permitRoot || item.permitRoot === row.permitRoot, 'bulk_sender_permit_changed');
      if (item.state === 'minted') return this.save(row, { state: 'minted', reason: null });
      return this.send(row);
    }
    if (row.returnPlan) return this.send(row);
    if (!item.paymentId) return this.save(row, { state: 'waiting_funding' });
    check(!row.paymentId || row.paymentId === item.paymentId, 'bulk_sender_receipt_changed');
    row = this.save(row, { paymentId: item.paymentId });
    const coin = await s.bitcoin.bulkFunding({ terms, orderId: id, paymentId: row.paymentId, deployerPayment,
      allowMissingDeployer: ['expired', 'credited'].includes(item.state) });
    if (!coin) return this.save(row, { state: 'waiting_funding' });
    row = this.save(row, { coin, state: 'funded' });
    if (['expired', 'credited'].includes(item.state)) {
      const status = await s.gateway.bulkStatus(id);
      check(status?.orderId === id && status.termsHash === row.termsHash && status.progress?.issued === 0 && status.progress.released === row.count, 'bulk_return_not_released');
      const feeRate = await s.bitcoin.feeRate(), key = requestKey(s.seed, id, s.network);
      try {
        const returnPlan = buildMintReturn({ coin, key, payer: row.payer, network: s.network, feeRate, settings: s.settings });
        row = this.save(row, { returnPlan, state: 'returning' });
      } finally { key.privateKey.fill(0); }
      return this.send(row);
    }
    // Existing detached/partial mints are recovered by B's bounded sources.
    // Their issued obligations stay held; the sender creates no duplicates.
    if (!['permit_issued', 'permit_pending', 'paid'].includes(item.state)) return this.save(row, { state: 'needs_attention', reason: 'bulk_state_unresolved' });
    if (!manifest?.complete || item.state !== 'permit_issued') return this.save(row, { state: 'waiting_permits' });
    check(manifest.permitRoot === item.permitRoot, 'bulk_sender_permit_changed');
    const feeRate = await s.bitcoin.feeRate();
    if (feeRate > terms.mintFunding.feeRateCeiling || feeRate > s.settings.maxFeeRate) return this.save(row, { state: 'fee_wait', reason: 'bulk_fee_wait' });
    const key = requestKey(s.seed, id, s.network);
    try {
      const draft = await buildBulkInscriptionPlan({ terms, manifest, funding: coin, publicKey: key.publicKey, feeRate });
      const plan = await signBulkCommit(draft, key.privateKey);
      check(BigInt(plan.feeSats) <= BigInt(s.settings.maxFeeSats), 'bulk_fee_wait');
      row = this.save(row, { plan, permitRoot: manifest.permitRoot, state: 'sending', reason: null });
    } catch (error) {
      if (error.message === 'bulk_fee_wait') return this.save(row, { state: 'fee_wait', reason: 'bulk_fee_wait' });
      throw error;
    } finally { key.privateKey.fill(0); }
    return this.send(row);
  }
  async attempt(id) {
    const s = this.sender;
    try {
      await this.process(id);
      const row = s.journal.bulk(id);
      this.save(row, { failures: 0, nextAttempt: s.now() + (['waiting_funding', 'waiting_permits', 'fee_wait'].includes(row.state) ? s.settings.fundingPollMs : s.settings.pollMs) });
    } catch (error) {
      const row = s.journal.bulk(id), failures = (row.failures ?? 0) + 1;
      const conflict = ['bulk_funding_spent', 'bulk_sender_binding_changed', 'bulk_sender_permit_changed', 'bulk_sender_receipt_changed'].includes(error.message);
      this.save(row, { failures, ...(conflict ? { state: 'needs_attention', reason: error.message } : {}),
        nextAttempt: s.now() + Math.min(s.settings.maxRetryMs, s.settings.retryMs * 2 ** Math.min(failures - 1, 16)) });
      s.log({ event: 'bulk_sender_retry', orderId: id, failures, code: conflict ? error.message : 'bulk_sender_dependency_unavailable' });
    }
  }
}
