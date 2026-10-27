import { rules } from './rules.mjs';
import { check, serial, heightKey } from './util.mjs';

// Links are paid before publication. The payer supplies the hash and arranges
// release; the gateway never receives or holds the payment preimage.
export class Links {
  constructor({ store, network, reads, terms }) { Object.assign(this, { store, network, reads, terms }); this.gate = serial(); }
  request({ request, sig, payer, paymentHash }) { return this.gate(async () => {
    const digest = rules.paymentDigest(this.network, request, 'link'), id = rules.bytesToHex(digest);
    // Verification uses the same signed domain as the replay rules.
    const { createPublicKey, verify } = await import('node:crypto');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(request.owner, 'hex')]), format: 'der', type: 'spki' });
    check(rules.hex(sig, 64) && verify(null, digest, key, Buffer.from(sig, 'hex')), 'link_signature');
    check(typeof payer === 'string' && payer.length > 0 && payer.length <= 128 && rules.hex(paymentHash, 32), 'link_terms');
    let row = this.store.get('linkIntents', id);
    if (!row) {
      const counted = await this.reads.counted(); await this.retire(counted);
      check(request.height <= counted && request.until > counted && request.until <= counted + 2016, 'link_deadline');
      check((await this.reads.bitmap(request.height)).agent === request.owner, 'link_owner');
      check(await this.reads.link(request.height) === null, 'link_exists');
      const active = this.store.list('activeLinks', { limit: 256 });
      check(active.length < 256, 'link_capacity', 503);
      check(active.filter(r => this.store.get('linkIntents', r.id)?.request.owner === request.owner).length < 8, 'link_sender_capacity', 429);
      row = { id, request, sig, terms: { ...await this.terms(id, request.until, counted), payer, hash: paymentHash } };
      await this.reads.validateFeeTerms('link', row);
      await this.store.transact([{ space: 'linkIntents', id, value: row }, { space: 'activeLinks', id, value: true }]);
    }
    check(row.terms.payer === payer && row.terms.hash === paymentHash, 'link_terms_conflict');
    const price = rules.feeFor('link', row.terms.baseFee, 1, row.terms.feeSettings);
    return { id, price, unit: rules.TAP_UNIT, split: rules.splitFee(price, { kind: 'link' }), terms: row.terms, state: this.store.get('linkStatus', id)?.state ?? 'waiting_payment' };
  }); }
  payment({ id, paymentId }) { return this.gate(async () => {
    const row = this.store.get('linkIntents', id); check(row && typeof paymentId === 'string' && paymentId.length <= 160, 'link_intent');
    const old = this.store.get('linkRequests', id); check(!old || old.paymentId === paymentId, 'link_payment_conflict');
    if (this.store.get('linkStatus', id)?.state === 'accepted') return { id, state: 'accepted' };
    check(this.store.get('activeLinks', id), 'link_inactive');
    const funded = { ...row, paymentId };
    await this.reads.validateFeeTerms('link', funded);
    const payment = await this.reads.linkPaymentFor(funded);
    rules.verifyLinkInput({ request: row.request, sig: row.sig, terms: row.terms, payment }, this.network, await this.reads.counted());
    check((await this.reads.bitmap(row.request.height)).agent === row.request.owner && await this.reads.link(row.request.height) === null, 'link_owner');
    await this.store.transact([{ space: 'linkRequests', id, value: funded }, { space: 'linkStatus', id, value: { state: 'queued' } }]);
    return { id, state: 'queued', paymentId };
  }); }
  async retire(counted) {
    for (const { id } of this.store.list('activeLinks', { limit: 256 })) if (!this.store.get('linkRequests', id) && this.store.get('linkIntents', id).request.until < counted) {
      await this.store.transact([{ space: 'activeLinks', id }, { space: 'linkStatus', id, value: { state: 'expired' } }]);
    }
  }
  async inputs(view) {
    await this.retire(view.height); const inputs = [], heights = new Set();
    for (const { id } of this.store.list('activeLinks', { limit: 256 })) {
      const row = this.store.get('linkRequests', id); if (!row) continue;
      try {
        const bitmap = await this.reads.bitmap(row.request.height, view), previous = await this.reads.link(row.request.height, view);
        if (bitmap.agent !== row.request.owner || previous !== null) {
          await this.store.transact([{ space: 'activeLinks', id }, { space: 'linkStatus', id, value: { state: 'rejected', reason: previous ? 'link_exists' : 'link_owner_changed', paymentId: row.paymentId } }]); continue;
        }
        if (heights.has(row.request.height)) continue;
        const terms = await this.reads.linkTerms(id, row.request, view), payment = await this.reads.linkPayment(id, view);
        const paid = { request: row.request, sig: row.sig, terms, payment };
        rules.verifyLinkInput(paid, this.network, view.height);
        inputs.push({ ...paid, bitmap, previous }); heights.add(row.request.height);
        if (inputs.length === 4) break;
      } catch (e) { await this.store.put('linkStatus', id, { state: 'deferred', reason: /^[a-z][a-z0-9_]{0,80}$/.test(e.message) ? e.message : 'link_read_unavailable', height: view.height }); }
    }
    return inputs;
  }
  acceptedOperations(draft) {
    const ops = [];
    for (const item of draft.items) item.output.file.linkOperations.forEach((input, i) => {
      if (item.output.file.linkOutcomes[i].reason !== 'accepted') return;
      const id = rules.linkId(this.network, input.request), block = input.request.height;
      ops.push({ space: 'activeLinks', id }, { space: 'linkStatus', id, value: { state: 'accepted', batch: draft.proposal.batch.n } },
        { space: 'links', id: heightKey(block), value: { block, linkHeight: item.input.executionHeight } });
    });
    return ops;
  }
}
