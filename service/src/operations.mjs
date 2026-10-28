import { paidMintPlan } from '../../committee/signer/pay-first.mjs';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { releaseCreditClaims } from './mint-credits.mjs';
import { assetResources } from './asset-resources.mjs';
import { releaseAdmission } from './mint-admission.mjs';

export class MintOperations {
  constructor({ store, network, reads, resources = {} }) { Object.assign(this, { store, network, reads }); this.resources = assetResources(resources); this.supportsMintBatches = true; }
  async ensure(key, op) {
    const id = op.op === 'rq' ? rules.pendingId(this.network, op.request) : op.id, request = this.store.get('mints', id);
    check(request && ['rq', 'mp', 'mc'].includes(op.op), 'mint_request_missing');
    const pending = await this.reads.pending(id), acceptance = await this.reads.pendingAcceptance(id);
    let accepted = null;
    if (op.op === 'rq' && acceptance && pending?.s === 0) accepted = acceptance;
    if (op.op === 'mp' && pending?.h === true) accepted = true;
    if (op.op === 'mc' && pending?.s === 1 && pending.permitHash === op.permitHash && pending.paymentHash === rules.paymentCommitment(op.payments)) accepted = true;
    if (accepted) { await this.store.put('mintInputs', key); return accepted; }
    if (this.store.get('mintRejected', key) || this.store.get('mintDeferred', key)) return null;
    if (!this.store.get('mintInputs', key)) {
      check(this.store.countUint('mintInputs') < this.resources.mintInputCapacity, 'mint_operation_capacity', 503);
      await this.store.put('mintInputs', key, { id, op: op.op });
    }
    return null;
  }
  acceptedOperations(draft) {
    return draft.proposal.batch.ops.filter(op => ['rq', 'mp', 'mc'].includes(op.op)).map(op => ({ space: 'mintInputs', id: op.op + '/' + (op.op === 'rq' ? rules.pendingId(this.network, op.request) : op.id) }));
  }
  async retire(key, row, reason, counted, retryable = false) {
    await this.store.transact([{ space: 'mintInputs', id: key }, { space: retryable ? 'mintDeferred' : 'mintRejected', id: key, value: { id: row.id, reason, counted } },
      ...(retryable ? [{ space: 'mints', id: row.id, value: { ...row, reason, checkedAt: counted } }] : []),
      ...(!retryable && key.startsWith('rq/') ? [{ space: 'mints', id: row.id, value: { ...row, state: 'expired', reason } }, { space: 'activeMints', id: row.id },
        { space: 'expiredMints', id: row.id, value: true }, ...releaseCreditClaims(this.store, row), ...releaseAdmission(row),
        ...(row.key && this.store.get('holds', row.key)?.id === row.id ? [{ space: 'holds', id: row.key, value: { id: row.id, expiry: counted - 1, safeToReplace: true } }] : [])] : [])]);
  }
  async inputs({ counted, last, files, view, limit }) {
    // Deferred evidence is retried once per new counted snapshot. The original
    // request and rejection reason remain durable and publicly inspectable.
    const deferred = this.store.list('mintDeferred', { after: this.deferredCursor ?? '', limit: this.resources.workPage });
    this.deferredCursor = deferred.length === this.resources.workPage ? deferred.at(-1).id : '';
    for (const { id: key, value } of deferred) if (value.counted < counted && this.store.countUint('mintInputs') < this.resources.mintInputCapacity) {
      await this.store.transact([{ space: 'mintInputs', id: key, value: { id: value.id, op: key.split('/')[0] } }, { space: 'mintDeferred', id: key }]);
    }
    const at = { counted, last }, balances = new Map(), nonces = new Set(), holds = new Map();
    const balance = async (owner, asset) => {
      const key = owner + '/' + asset;
      if (!balances.has(key)) balances.set(key, BigInt(await this.reads.balance(owner, asset, at)));
      return balances.get(key);
    };
    const change = async (owner, asset, delta) => balances.set(owner + '/' + asset, await balance(owner, asset) + delta);
    for (const file of files) for (const op of file.ops) {
      if (op.op === 'ac') { for (const [asset, amount] of op.assets) await change(op.to, asset, BigInt(amount)); }
      else if (op.op === 'mk') await change(op.to, op.asset, BigInt(op.amount));
      if (op.op === 'xc') { nonces.add(op.request.owner + ':' + op.request.nonce); for (const [asset, n] of op.request.in) await change(op.request.owner, asset, -BigInt(n)); for (const [asset, n] of op.request.out) await change(op.request.owner, asset, BigInt(n)); }
    }
    const inputs = [], ids = new Set(), projected = { balances: {}, usedNonces: {}, mints: {} };
    const page = this.store.list('mintInputs', { after: this.inputCursor ?? '', limit: this.resources.workPage });
    for (const { id: queueKey, value: queued } of page) {
      if (inputs.length === limit) break; if (ids.has(queued.id)) continue;
      this.inputCursor = queueKey;
      const row = this.store.get('mints', queued.id); check(row, 'mint_request_missing');
      const { request, signature: sig, receiver, id } = row, op = queued.op;
      let evidence;
      try {
      const accepted = op === 'rq' ? await this.reads.pendingAcceptance(id, at) : null;
      if (op === 'rq' && accepted || op !== 'rq' && (accepted?.op === op || this.store.get('mintFinished', id))) {
        await this.store.transact([{ space: 'mintInputs', id: queueKey }, { space: 'mintApplied', id: queueKey, value: { id, counted } }]); continue;
      }
      if (op === 'rq') {
        if (counted > request.until || request.expires - counted < 6) { await this.retire(queueKey, row, 'request_expired', counted); continue; }
        const snapshot = await this.reads.mintPayoutSnapshot?.(id);
        const context = rules.mintContext(await this.reads.assetContext(request.asset, request.block, view, snapshot)), key = request.asset + '/' + request.block;
        const hasBlock = Object.hasOwn(request, 'block');
        if (hasBlock && !holds.has(key)) holds.set(key, await this.reads.blockHold(request.asset, request.block, at));
        evidence = { context, bitmap: context.link ? await this.reads.bitmap(request.block, view) : null,
          minted: hasBlock ? await this.reads.isMinted(context.deployment.id, context.deployment.tick, request.block, view) : false,
          hold: hasBlock ? holds.get(key) : null, balance: (await balance(request.owner, request.asset)).toString(),
          nonceUsed: nonces.has(request.owner + ':' + request.nonce) || await this.reads.nonceUsed(request.owner, request.nonce, at) };

      } else {
        const authority = await this.reads.authority();
        const plan = await paidMintPlan({ reads: this.reads, network: this.network, publicKey: authority.committee, request, signature: sig, receiver, final: op === 'mc' });
        if (op === 'mp' && plan.raw.h || op === 'mc' && plan.raw.s === 1) { await this.store.put('mintInputs', queueKey); continue; }
        const authorization = { ...rules.mintAuthorization(plan.details), fees: plan.fees, paymentHash: rules.paymentCommitment(plan.progress.allocations) };
        evidence = { pending: plan.pending, reservation: plan.raw, payment: plan.payment, authorization, balance: (await balance(request.owner, request.asset)).toString() };

      }
      const input = { op, request, sig, receiver, evidence };
      const state = structuredClone(projected);
      rules.applyMintInput({ input, network: this.network, counted, tip: view.tip, hashAt: h => h === evidence.cancellation?.height ? evidence.cancellation.blockHash : null, state });
      Object.assign(projected, state);
      if (op === 'rq') { await change(request.owner, request.asset, -BigInt(request.amount)); nonces.add(request.owner + ':' + request.nonce); if (Object.hasOwn(request, 'block')) holds.set(request.asset + '/' + request.block, { id, expiry: request.expires }); }
      if (op === 'mp' && counted > request.expires && !evidence.reservation.h) await change(request.owner, request.asset, -BigInt(request.amount));
      inputs.push(input); ids.add(id);
      } catch (e) {
        const permanent = new Set(['owner_signature', 'mint_capacity', 'mint_deployment', 'mint_evidence', 'mint_replay', 'mint_no_find', 'mint_balance', 'mint_pending_expired', 'mint_block_pending', 'mint_already_real', 'mint_owner']);
        await this.retire(queueKey, row, /^[a-z][a-z0-9_]{0,80}$/.test(e.message) ? e.message : 'evidence_unavailable', counted, op !== 'rq' || !permanent.has(e.message));
      }
    }
    if (page.length < this.resources.workPage && this.inputCursor === page.at(-1)?.id || !page.length) this.inputCursor = '';
    return inputs;
  }
  async accepted(draft) {
    const operations = draft.proposal.batch.ops.filter(op => ['rq', 'mp', 'mc'].includes(op.op));
    for (const op of operations) { const id = op.op === 'rq' ? rules.pendingId(this.network, op.request) : op.id; await this.store.put('mintInputs', op.op + '/' + id); }
  }
}
