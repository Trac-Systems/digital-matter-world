import { randomBytes } from 'node:crypto';
import { check, hash, serial } from './util.mjs';
import { localURL } from './config.mjs';
import { ethereumSignature } from './ethereum.mjs';
import { rules } from './rules.mjs';
import { financialMintId } from '../../rules/src/financial-mint.js';
import { jsonRequest } from './http-client.mjs';
import { verifyBindingAttestation } from '../../rules/src/payout-bindings.mjs';
import { lifecycleSignal } from './lifecycle.mjs';
export async function post(signer, path, value, timeout = 15000, maxBytes = 4000000, signal = lifecycleSignal()) {
  signal?.throwIfAborted();
  const { ok, value: result } = await jsonRequest(localURL(signer.url) + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signer.token}` }, body: JSON.stringify(value), timeout, maxBytes, signal, limitCode: 'committee_response_limit' });
  if (!ok) {
    const error = Object.assign(Error(/^[a-z][a-z0-9_]{0,70}$/.test(result.error) ? 'committee_' + result.error : 'committee_refused'), { status: 503 });
    if (path === '/prepare' && result.unreserved?.id === value.ceremony.id && result.unreserved.proposalHash === hash(JSON.stringify(value.proposal))) error.unreserved = true;
    throw error;
  }
  return result;
}
const validClock = n => Number.isSafeInteger(n) && n >= 0 || typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n);
export class Committee {
  constructor({ store, network, signers, epoch = 1, timeoutMs = 180000, prepareMs = 60000, healthMs = 1000, readyMs = 15000, requestMs = 15000, responseBytes = 4000000, pollMs = 0, historyPage = 256, batchRetryMs = 5000, assetRecoveryVersion = 1 }) {
    check(signers.length === 5 && new Set(signers.map(s => s.id)).size === 5, 'committee_members');
    check([timeoutMs, prepareMs, healthMs, readyMs, requestMs, responseBytes, historyPage].every(n => Number.isSafeInteger(n) && n > 0) && Number.isSafeInteger(pollMs) && pollMs >= 0, 'committee_resources');
    check(Number.isSafeInteger(batchRetryMs) && batchRetryMs > 0 && batchRetryMs <= 600000, 'committee_resources');
    Object.assign(this, { store, network, signers, epoch, timeoutMs, prepareMs, healthMs, readyMs, requestMs, responseBytes, pollMs, historyPage, batchRetryMs, assetRecoveryVersion }); this.signatureGate = serial();
    this.controller = new AbortController();
    this.signal = lifecycleSignal() ? AbortSignal.any([this.controller.signal, lifecycleSignal()]) : this.controller.signal;
  }
  close() { this.controller.abort(Error('committee_closed')); }
  request(signer, path, value, timeout = this.requestMs) { return post(signer, path, value, timeout, this.responseBytes, this.signal); }
  async healthy(at) {
    const replies = await Promise.allSettled(this.signers.map(s => this.request(s, at ? '/batch-ready' : '/health', at?.settingsHash ? { settingsHash: at.settingsHash } : {}, at ? this.readyMs : this.healthMs)));
    return this.signers.filter((s, i) => replies[i].status === 'fulfilled' && replies[i].value.id === s.id && replies[i].value.network === this.network && validClock(replies[i].value.epoch) && rules.compareOrdinal(replies[i].value.epoch, this.epoch) === 0
      && (!at || validClock(replies[i].value.counted) && rules.compareOrdinal(replies[i].value.counted, at.counted) >= 0 && validClock(replies[i].value.tip) && rules.compareOrdinal(replies[i].value.tip, at.tip) >= 0)
      && (!at?.manifestHash || replies[i].value.manifestHash === at.manifestHash)
      && (!at?.settingsHash || replies[i].value.capabilities?.settingsHash === at.settingsHash &&
        replies[i].value.capabilities.integer === 2 && replies[i].value.capabilities.batch === 2 &&
        replies[i].value.capabilities.file === 5 && replies[i].value.capabilities.receipt === 2));
  }
  async ready(at) { return (await this.healthy(at)).length >= 3; }
  async receiptFence(kind, value, evidence) {
    const path = kind === 'admission' ? '/ack-receipt' : '/fence-receipts';
    const body = kind === 'admission' ? { receipt: value, checkpoint: evidence } : { cutoff: value, evidence };
    const completed = new Map(), cursors = new Map();
    for (;;) {
      const pending = this.signers.filter(s => !completed.has(s.id));
      const replies = await Promise.allSettled(pending.map(s => this.request(s, path, body)));
      let progressed = false;
      for (const [i, reply] of replies.entries()) {
        if (reply.status !== 'fulfilled') continue;
        const result = reply.value, signer = pending[i];
        if (result.signer === signer.id && rules.verifyReceiptFenceVotes(kind, value, [result], this.signers.map(s => s.peer), 1)) completed.set(signer.id, result);
        else if (kind === 'cutoff' && value.v === 2 && result.pending && result.signer === signer.id && result.cutoff === rules.hashObject(value) &&
          typeof result.next === 'string' && /^(0|[1-9][0-9]*)$/.test(result.next) &&
          rules.compareUint(result.next, cursors.get(signer.id) ?? '0') > 0 && rules.compareUint(result.next, value.segmentCount) < 0) {
          cursors.set(signer.id, result.next); progressed = true;
        }
      }
      const votes = [...completed.values()];
      if (rules.verifyReceiptFenceVotes(kind, value, votes, this.signers.map(s => s.peer)) && !progressed) return votes;
      check(progressed, 'receipt_fence_quorum_unavailable', 503);
    }
  }

  acknowledgeReceipt(receipt, checkpoint) { return this.receiptFence('admission', receipt, checkpoint); }
  fenceReceipts(cutoff, evidence) { return this.receiptFence('cutoff', cutoff, evidence); }
  async bindPayout(record, { bitcoinNetwork }) {
    const replies = await Promise.allSettled(this.signers.map(s => this.request(s, '/bind-payout', record)));
    const options = { network: this.network, bitcoinNetwork, members: this.signers.map(s => s.peer) };
    const attestations = replies.flatMap((r, i) => r.status === 'fulfilled' && r.value?.signer === this.signers[i].id && verifyBindingAttestation(record, r.value, options) ? [r.value] : []);
    check(attestations.length >= 3, 'binding_quorum_unavailable', 503);
    return attestations;
  }
  async attestRoot(seal) {
    const key = rules.receiptSegmentKey(seal), saved = this.store.get('receiptCertificates', key);
    if (saved) { check(seal.v === 2 ? rules.stableJSON(saved.seal) === rules.stableJSON(seal) : saved.seal.root === seal.root && saved.seal.count === seal.count, 'receipt_root_conflict'); return saved.attestations; }
    const replies = await Promise.allSettled(this.signers.map(s => this.request(s, '/attest-root', { tip: seal.tip, hash: seal.hash, ...(seal.v === 2 ? { segment: seal.segment } : {}) })));
    const attestations = replies.filter(r => r.status === 'fulfilled').map(r => r.value);
    check(rules.verifyRootAttestations(seal, attestations, this.signers.map(s => s.peer)), 'receipt_quorum_unavailable', 503);
    await this.store.put('receiptCertificates', key, { seal, attestations }); return attestations;
  }
  signature(key, proposal) { return this.signatureGate(() => this.sign(key, proposal)); }
  retireUnprepared(key) { return this.signatureGate(async () => {
    const session = this.store.get('ceremonies', key);
    if (session?.stage !== 'blocked' || session.reason !== 'prepare_incomplete') return null;
    if (session.resetting || session.retry === 'same-batch' || session.retryPrepare || session.retryBusy || session.unreserved?.length || session.failures?.every(e => e === 'committee_signer_busy')) return null;
    const selected = this.signers.filter(s => session.peers.includes(s.id));
    check(selected.length === 3, 'ceremony_members', 503);
    const states = await Promise.allSettled(selected.map(s => this.request(s, '/status', { id: session.id })));
    if (!states.every(r => r.status === 'rejected' && r.reason.message === 'committee_ceremony_id')) return null;
    const replies = await Promise.allSettled(selected.map(s => this.request(s, '/retire-unprepared', { network: this.network, id: session.id }, this.prepareMs)));
    if (!replies.every(r => r.status === 'fulfilled' && r.value.id === session.id && r.value.status === 'retired-unprepared')) return null;
    return { session: session.id, peers: selected.map(s => s.id), status: 'retired-unprepared' };
  }); }
  // Explicit recovery of an ambiguous preparation retains the original ID,
  // proposal and peers. The signer serializes this inventory with prepare and
  // refuses reuse if a late request subsequently reserves that same ID.
  recoverPreparation(key) { return this.signatureGate(async () => {
    const session = this.store.get('ceremonies', key);
    check(session?.stage === 'blocked' && session.reason === 'prepare_incomplete', 'ceremony_requires_recovery', 503);
    const selected = this.signers.filter(s => session.peers.includes(s.id));
    check(selected.length === 3, 'ceremony_members', 503);
    const states = await Promise.allSettled(selected.map(s => this.request(s, '/preparation-state', { id: session.id })));
    check(states.every(r => r.status === 'fulfilled' && r.value.id === session.id && r.value.reserved === false && r.value.retired === false), 'ceremony_reservation_unresolved', 503);
    await this.store.put('ceremonies', key, { ...session, retryPrepare: true, unreserved: selected.map(s => s.id) });
    return { session: session.id, status: 'retry-original-preparation' };
  }); }
  async renewBatchAttempt(key, session, proposal) {
    if (Date.now() - (session.lastReset ?? session.started ?? 0) < this.batchRetryMs) return null;
    const selected = this.signers.filter(s => session.peers.includes(s.id));
    check(selected.length === 3, 'ceremony_members', 503);
    session = { ...session, resetting: true, lastReset: Date.now() };
    await this.store.put('ceremonies', key, session);
    const batchHash = hash(JSON.stringify(proposal.batch));
    const replies = await Promise.allSettled(selected.map(s => this.request(s, '/retire-batch-attempt', {
      network: this.network, id: session.id, batch: proposal.batch
    })));
    if (!replies.every(r => r.status === 'fulfilled' && r.value.id === session.id && r.value.status === 'batch-attempt-retired' && r.value.batchHash === batchHash)) return null;
    const digests = [...replies.flatMap(r => r.value.digest ? [r.value.digest] : []), ...(session.digest ? [session.digest] : [])];
    if (!digests.every(d => /^[0-9a-f]{64}$/.test(d)) || new Set(digests).size > 1) {
      await this.store.put('ceremonies', key, { ...session, resetting: false, reason: 'signature_disagreement', retryPrepare: false, retryBusy: false });
      throw Object.assign(Error('signature_disagreement'), { status: 503 });
    }
    // Never discard/rebuild the draft or release a signing slot. All original
    // peers fence the old session while retaining its permanent digest lock.
    const renewed = { id: randomBytes(32).toString('hex'), proposal, peers: session.peers, stage: 'blocked', reason: 'prepare_incomplete',
      retry: 'same-batch', retryOf: session.id, retryPrepare: true, fresh: true, unreserved: session.peers, started: Date.now(),
      ...(digests.length ? { digest: digests[0] } : {}) };
    await this.store.transact([{ space: 'batchCeremonyAttempts', id: key + '/' + session.id, value: session }, { space: 'ceremonies', id: key, value: renewed }]);
    this.activeSigning?.delete(key); return null;
  }
  async sign(key, proposal) {
    let session = this.store.get('ceremonies', key);
    if (!this.activeSigning) {
      this.activeSigning = new Set(); let after = '';
      for (;;) {
        const page = this.store.list('ceremonies', { after, limit: this.historyPage });
        for (const row of page) if (['prepared', 'running'].includes(row.value.stage)) this.activeSigning.add(row.id);
        if (page.length < this.historyPage) break; after = page.at(-1).id;
      }
    }
    for (const id of this.activeSigning) if (!['prepared', 'running'].includes(this.store.get('ceremonies', id)?.stage)) this.activeSigning.delete(id);
    if (session?.stage !== 'complete' && [...this.activeSigning].some(id => id !== key)) return null;
    if (!session) {
      const at = proposal.kind === 'batch' ? { counted: proposal.batch.to, tip: proposal.files.map(f => rules.decodeBinary(Buffer.from(f, 'hex')).tip).reduce((a, b) => rules.ordinalCodec(!!proposal.batch.settingsHash).max(a, b), proposal.batch.to) } : undefined;
      const quorum = (await this.healthy(at)).slice(0, 3);
      if (at && quorum.length < 3) return null;
      check(quorum.length === 3, 'committee_quorum_unavailable', 503);
      session = { id: randomBytes(32).toString('hex'), stage: 'prepared', proposal, peers: quorum.map(s => s.id), started: Date.now() };
      await this.store.put('ceremonies', key, session); this.activeSigning.add(key);
      const selected = this.signers.filter(s => session.peers.includes(s.id));
      const responses = await Promise.allSettled(selected.map(s => this.request(s, '/prepare', { proposal, ceremony: { id: session.id, epoch: this.epoch, peers: selected.map(s => s.peer) } }, this.prepareMs)));
      const digests = responses.filter(r => r.status === 'fulfilled').map(r => r.value.digest);
      const disagreement = digests.some(d => !/^[0-9a-f]{64}$/.test(d)) || new Set(digests).size > 1;
      if (responses.some(r => r.status === 'rejected') || disagreement) {
        const unreserved = selected.filter((s, i) => responses[i].status === 'rejected' && (responses[i].reason.unreserved || responses[i].reason.message === 'committee_signer_busy')).map(s => s.id);
        const failures = responses.filter(r => r.status === 'rejected').map(r => r.reason.message);
        const retryPrepare = !disagreement && failures.length === unreserved.length;
        await this.store.put('ceremonies', key, { ...session, stage: 'blocked', reason: disagreement ? 'signature_disagreement' : 'prepare_incomplete', failures,
          retryPrepare, unreserved, ...(!disagreement && digests.length ? { digest: digests[0] } : {}) });
        if (retryPrepare) return null;
        throw Error('committee_prepare_incomplete');
      }
      session = { ...session, stage: 'running', digest: responses[0].value.digest };
      await this.store.put('ceremonies', key, session);
      await Promise.all(selected.map(s => this.request(s, '/go', { id: session.id })));
    }
    check(session.proposalHash ? session.proposalHash === hash(JSON.stringify(proposal)) : JSON.stringify(session.proposal) === JSON.stringify(proposal), 'ceremony_proposal_changed', 409);
    if (session.stage === 'complete') return session.result;
    check(session.reason !== 'signature_disagreement', 'signature_disagreement', 503);
    if (session.resetting) return this.renewBatchAttempt(key, session, proposal);
    const selected = this.signers.filter(s => session.peers.includes(s.id));
    // Status retrieval is safe even if the gateway died after signing completed.
    const readStates = () => Promise.allSettled(selected.map(s => this.request(s, '/status', { id: session.resultSources?.[s.id] ?? session.id })));
    if (session.stage === 'running' && this.lastPoll?.id === session.id && Date.now() - this.lastPoll.at < this.pollMs) return null;
    this.lastPoll = { id: session.id, at: Date.now() };
    let states = await readStates();
    if (session.stage === 'blocked' && session.reason === 'prepare_incomplete' && session.fresh !== true && proposal.kind === 'batch' &&
      validClock(proposal.batch?.epoch) && /^[0-9a-f]{64}$/.test(proposal.batch?.root) &&
      Date.now() - (session.started ?? 0) >= this.batchRetryMs &&
      states.some(s => s.status === 'rejected' || !['prepared', 'running', 'complete'].includes(s.value.status)))
      return this.renewBatchAttempt(key, session, proposal);
    // Retry only missing members with a bound no-reservation refusal (or the
    // legacy busy refusal). Existing reservations remain untouched.
    const retry = session.stage === 'blocked' && session.reason === 'prepare_incomplete' &&
      (session.retryPrepare === true || session.retryBusy === true || session.failures?.length === selected.length && session.failures.every(e => e === 'committee_signer_busy'));
    if (retry && states.some(s => s.status === 'rejected')) {
      // Never prepare through a timeout or sidecar error. An authenticated
      // absent-session reply is needed as well as the earlier refusal proof.
      if (states.some((s, i) => s.status === 'rejected' && (s.reason.message !== 'committee_ceremony_id'
        || !(session.unreserved?.includes(selected[i].id) || session.retryBusy || session.failures?.every(e => e === 'committee_signer_busy'))))) return null;
      if (session.fresh) { session = { ...session, fresh: false }; await this.store.put('ceremonies', key, session); }
      const responses = await Promise.allSettled(selected.map((s, i) => states[i].status === 'fulfilled' ? null :
        this.request(s, '/prepare', { proposal, ceremony: { id: session.id, epoch: this.epoch, peers: selected.map(s => s.peer), ...(session.retry ? { retry: session.retry } : {}) } }, this.prepareMs)));
      const failures = responses.filter(r => r.status === 'rejected').map(r => r.reason.message);
      const digests = responses.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value.digest);
      if (session.digest) digests.push(session.digest);
      if (digests.some(d => !/^[0-9a-f]{64}$/.test(d)) || new Set(digests).size > 1) {
        await this.store.put('ceremonies', key, { ...session, stage: 'blocked', reason: 'signature_disagreement', retryPrepare: false, retryBusy: false });
        throw Error('signature_disagreement');
      }
      const unreserved = selected.filter((s, i) => responses[i].status === 'rejected' && (responses[i].reason.unreserved || responses[i].reason.message === 'committee_signer_busy')).map(s => s.id);
      const resultSources = { ...session.resultSources };
      if (this.assetRecoveryVersion === 2 && proposal.kind === 'mint') for (const [i, response] of responses.entries()) {
        if (response.status === 'fulfilled' && response.value?.recovered) {
          check(/^[0-9a-f]{64}$/.test(response.value.id), 'ceremony_result_source');
          resultSources[selected[i].id] = response.value.id;
        }
      }
      session = { ...session, retryBusy: false, retryPrepare: failures.length === unreserved.length, unreserved, failures,
        ...(digests.length ? { digest: digests[0] } : {}), ...(Object.keys(resultSources).length ? { resultSources } : {}) };
      await this.store.put('ceremonies', key, session);
      if (failures.length) { check(session.retryPrepare, 'ceremony_requires_recovery', 503); return null; }
      states = await readStates();
    }
    const reported = states.filter(s => s.status === 'fulfilled' && s.value.digest !== undefined).map(s => s.value.digest);
    if (session.digest) reported.push(session.digest);
    if (reported.some(d => !/^[0-9a-f]{64}$/.test(d)) || new Set(reported).size > 1
      || states.some((s, i) => s.status === 'fulfilled' && s.value.id !== undefined && s.value.id !== (session.resultSources?.[selected[i].id] ?? session.id))) {
      await this.store.put('ceremonies', key, { ...session, stage: 'blocked', reason: 'signature_disagreement', retryPrepare: false, retryBusy: false });
      throw Error('signature_disagreement');
    }
    if (this.assetRecoveryVersion === 2 && proposal.kind === 'mint') {
      const complete = states.filter(s => s.status === 'fulfilled' && s.value.status === 'complete');
      if (complete.length) {
        const result = complete[0].value;
        check(complete.every(s => rules.stableJSON(s.value.signature) === rules.stableJSON(result.signature)) &&
          result.result?.permit?.digest === session.digest && result.result.details?.id === (proposal.version === 'public-v1' ? proposal.id : financialMintId(this.network, proposal.request)), 'signature_disagreement', 503);
        // Every recipient independently verifies the exact permit signature
        // against its durable reservation before adding its result attestation.
        states = await Promise.allSettled(selected.map((s, i) => states[i].status === 'fulfilled' && states[i].value.status === 'complete' ? states[i].value :
          this.request(s, '/recover-result', { network: this.network, id: result.result.details.id, signature: result.signature })));
      } else if (states.every(s => s.status === 'fulfilled' && s.value.status === 'aborted' && s.value.digest === session.digest)) {
        // Only explicit replies from all original participants retire an
        // attempt. A timeout or missing signer never proves an absent result.
        const renewed = { id: randomBytes(32).toString('hex'), proposal, peers: session.peers, digest: session.digest,
          stage: 'blocked', reason: 'prepare_incomplete', retryPrepare: true, unreserved: session.peers,
          retry: 'same-mint-v2', retryOf: session.id, started: Date.now() };
        await this.store.transact([{ space: 'mintCeremonyAttempts', id: key + '/' + session.id, value: session },
          { space: 'ceremonies', id: key, value: renewed }]);
        this.activeSigning.delete(key);
        return null;
      }
    }
    const available = states.every(s => s.status === 'fulfilled' && ['prepared', 'running', 'complete'].includes(s.value.status));
    if (available && states.some(s => s.value.status === 'prepared')) {
      check(session.stage !== 'blocked' || session.reason === 'prepare_incomplete' && (session.failures?.length || session.retryBusy === true || session.retryPrepare === true), 'ceremony_requires_recovery', 503);
      // Resume only the original durable session, after every selected signer
      // confirms that exact session exists. Reserved slots are never replaced.
      session = { ...session, stage: 'running', started: Date.now(), resumed: Date.now() }; this.activeSigning.add(key);
      await this.store.put('ceremonies', key, session);
      await Promise.all(selected.map((s, i) => states[i].value.status === 'prepared' ? this.request(s, '/go', { id: session.id }) : null)); return null;
    }
    if (states.every(s => s.status === 'fulfilled' && s.value.status === 'complete')) {
      check(new Set(states.map(s => JSON.stringify(s.value.signature))).size === 1, 'signature_disagreement', 503);
      const { signature, result: details } = states[0].value;
      const p = details.permit;
      const result = { session: session.id, signature, ...(p ? { authorization: rules.mintAuthorization(details.details), certificate: { domain: 'dmw-mint-result-v1', network: this.network, details: details.details, signature, attestations: states.map(s => s.value.result.attestation) }, payload: { ...p.payload, prv: { address: p.address, salt: p.salt, hash: p.digest, sig: { r: signature.r, s: signature.s, v: String(signature.v) } } } } : {}), ...(details.typedData ? { typedData: details.typedData, ethereumSignature: ethereumSignature(signature) } : {}) };
      await this.store.put('ceremonies', key, { ...session, stage: 'complete', result }); return result;
    }
    check(session.stage !== 'blocked', 'ceremony_requires_recovery', 503);
    if (Date.now() > session.started + this.timeoutMs || states.some(s => s.status === 'fulfilled' && s.value.status === 'aborted')) {
      await this.store.put('ceremonies', key, { ...session, stage: 'blocked', reason: 'ceremony_incomplete' }); throw Error('ceremony_requires_recovery');
    }
    return null;
  }
}
