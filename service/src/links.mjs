import { rules } from './rules.mjs';
import { check, serial, heightKey } from './util.mjs';
import { assetResources } from './asset-resources.mjs';

// Links are paid before publication. The payer supplies the hash and arranges
// release; the gateway never receives or holds the payment preimage.
export class Links {
  constructor({ store, network, reads, terms, resources = {} }) { Object.assign(this, { store, network, reads, terms }); this.resources = assetResources(resources); this.gate = serial(); }
  ownerSpace(owner) { return 'activeLinksByOwner/' + owner; }
  async indexPage() {
    const cursor = this.store.get('linkMaintenance', 'ownerIndex');
    if (cursor?.done) return true;
    const page = this.store.list('activeLinks', { after: cursor?.after ?? '', limit: this.resources.workPage });
    await this.store.transact([...page.map(({ id }) => ({ space: this.ownerSpace(this.store.get('linkIntents', id).request.owner), id, value: true })),
      { space: 'linkMaintenance', id: 'ownerIndex', value: { after: page.at(-1)?.id ?? '', done: page.length < this.resources.workPage } }]);
    return page.length < this.resources.workPage;
  }
  inactive(id) {
    const row = this.store.get('linkIntents', id);
    return [{ space: 'activeLinks', id }, { space: 'linkRecovery', id }, ...(row ? [{ space: this.ownerSpace(row.request.owner), id }] : [])];
  }
  async preservePaid(row, reason, payment = row.paymentEvidence) {
    // A durable obligation is not a claimed refund. Settlement must verify the
    // retained payment against the accepted usage root before issuing credit.
    await this.store.transact([...this.inactive(row.id), { space: 'linkRequests', id: row.id, value: row },
      { space: 'linkRecovery', id: row.id, value: true },
      { space: 'linkObligations', id: row.id, value: { request: row.request, paymentId: row.paymentId, payment: payment ?? null, reason, state: 'reconciliation_required' } },
      { space: 'linkStatus', id: row.id, value: { state: 'recovery', reason, paymentId: row.paymentId } }]);
  }
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
      check(await this.indexPage(), 'link_index_warming', 503);
      check(this.store.countUint('activeLinks') < this.resources.activeLinks, 'link_capacity', 503);
      check(this.store.countUint(this.ownerSpace(request.owner)) < this.resources.linksPerAgent, 'link_sender_capacity', 429);
      row = { id, request, sig, terms: { ...await this.terms(id, request.until, counted), payer, hash: paymentHash } };
      await this.reads.validateFeeTerms('link', row);
      await this.store.transact([{ space: 'linkIntents', id, value: row }, { space: 'activeLinks', id, value: true }, { space: this.ownerSpace(request.owner), id, value: true }]);
    }
    check(row.terms.payer === payer && row.terms.hash === paymentHash, 'link_terms_conflict');
    const price = rules.feeFor('link', row.terms.baseFee, 1, row.terms.feeSettings);
    return { id, price, unit: rules.TAP_UNIT, split: rules.splitFee(price, { kind: 'link' }), terms: row.terms, state: this.store.get('linkStatus', id)?.state ?? 'waiting_payment' };
  }); }
  payment({ id, paymentId }) { return this.gate(async () => {
    const row = this.store.get('linkIntents', id); check(row && typeof paymentId === 'string' && paymentId.length <= 160, 'link_intent');
    const old = this.store.get('linkRequests', id); check(!old || old.paymentId === paymentId, 'link_payment_conflict');
    if (this.store.get('linkStatus', id)?.state === 'accepted') return { id, state: 'accepted' };
    check(this.store.get('activeLinks', id) || this.store.get('linkRecovery', id), 'link_inactive');
    const funded = { ...row, paymentId };
    await this.reads.validateFeeTerms('link', funded);
    const payment = await this.reads.linkPaymentFor(funded);
    rules.verifyLinkInput({ request: row.request, sig: row.sig, terms: row.terms, payment }, this.network, await this.reads.counted());
    funded.paymentEvidence = payment;
    if ((await this.reads.bitmap(row.request.height)).agent !== row.request.owner || await this.reads.link(row.request.height) !== null) {
      await this.preservePaid(funded, 'link_owner_or_existing', payment); check(false, 'link_owner');
    }
    await this.store.transact([{ space: 'linkRequests', id, value: funded }, { space: 'linkStatus', id, value: { state: 'queued' } }]);
    return { id, state: 'queued', paymentId };
  }); }
  async retire(counted) {
    await this.indexPage();
    const page = this.store.list('activeLinks', { after: this.expiryCursor ?? '', limit: this.resources.workPage });
    this.expiryCursor = page.length === this.resources.workPage ? page.at(-1).id : '';
    for (const { id } of page) if (!this.store.get('linkRequests', id) && this.store.get('linkIntents', id).request.until < counted) {
      await this.store.transact([...this.inactive(id), { space: 'linkStatus', id, value: { state: 'expired' } }]);
    }
  }
  async inputs(view) {
    await this.retire(view.height); const inputs = [], heights = new Set();
    this.inputCursors ??= {};
    this.recoveryFirst = !this.recoveryFirst;
    const spaces = this.recoveryFirst ? ['linkRecovery', 'activeLinks'] : ['activeLinks', 'linkRecovery'];
    const pages = spaces.map(space => ({ space, rows: this.store.list(space, { after: this.inputCursors[space] ?? '', limit: this.resources.workPage }) }));
    for (const { id, space } of pages.flatMap(page => page.rows.map(row => ({ ...row, space: page.space })))) {
      this.inputCursors[space] = id;
      const row = this.store.get('linkRequests', id); if (!row) continue;
      try {
        const bitmap = await this.reads.bitmap(row.request.height, view), previous = await this.reads.link(row.request.height, view);
        if (bitmap.agent !== row.request.owner || previous !== null) {
          await this.preservePaid(row, previous ? 'link_exists' : 'link_owner_changed'); continue;
        }
        if (heights.has(row.request.height)) continue;
        const terms = await this.reads.linkTerms(id, row.request, view), payment = await this.reads.linkPayment(id, view);
        const paid = { request: row.request, sig: row.sig, terms, payment };
        rules.verifyLinkInput(paid, this.network, view.height);
        inputs.push({ ...paid, bitmap, previous }); heights.add(row.request.height);
        if (inputs.length === 4) break;
      } catch (e) {
        const reason = /^[a-z][a-z0-9_]{0,80}$/.test(e.message) ? e.message : 'link_read_unavailable';
        if (view.height > row.request.until) await this.preservePaid(row, reason);
        else await this.store.put('linkStatus', id, { state: 'deferred', reason, height: view.height });
      }
    }
    for (const { space, rows } of pages) if (!rows.length || rows.length < this.resources.workPage && this.inputCursors[space] === rows.at(-1).id) this.inputCursors[space] = '';
    return inputs;
  }
  acceptedOperations(draft) {
    const ops = [];
    for (const item of draft.items) item.output.file.linkOperations.forEach((input, i) => {
      if (item.output.file.linkOutcomes[i].reason !== 'accepted') return;
      const id = rules.linkId(this.network, input.request), block = input.request.height;
      ops.push(...this.inactive(id), { space: 'linkStatus', id, value: { state: 'accepted', batch: draft.proposal.batch.n } },
        { space: 'feedBlockChanges', id: 'link/' + block, value: { block } },
        { space: 'links', id: heightKey(block), value: { block, linkHeight: item.input.executionHeight } });
      const obligation = this.store.get('linkObligations', id);
      if (obligation) ops.push({ space: 'linkObligations', id, value: { ...obligation, state: 'completed', batch: draft.proposal.batch.n } });
    });
    return ops;
  }
}
