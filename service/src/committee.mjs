import { randomBytes } from 'node:crypto';
import { check, hash, serial } from './util.mjs';
import { localURL } from './config.mjs';
import { ethereumSignature } from './ethereum.mjs';
import { rules } from './rules.mjs';
import { jsonRequest } from './http-client.mjs';
import { verifyBindingAttestation } from '../../rules/src/payout-bindings.mjs';
export async function post(signer, path, value, timeout = 15000) {
  const { ok, value: result } = await jsonRequest(localURL(signer.url) + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signer.token}` }, body: JSON.stringify(value), timeout, limitCode: 'committee_response_limit' });
  if (!ok) {
    const error = Object.assign(Error(/^[a-z][a-z0-9_]{0,70}$/.test(result.error) ? 'committee_' + result.error : 'committee_refused'), { status: 503 });
    if (path === '/prepare' && result.unreserved?.id === value.ceremony.id && result.unreserved.proposalHash === hash(JSON.stringify(value.proposal))) error.unreserved = true;
    throw error;
  }
  return result;
}
export class Committee {
  constructor({ store, network, signers, epoch = 1, timeoutMs = 180000 }) {
    check(signers.length === 5 && new Set(signers.map(s => s.id)).size === 5, 'committee_members');
    Object.assign(this, { store, network, signers, epoch, timeoutMs }); this.signatureGate = serial();
  }
  async healthy(at) {
    const replies = await Promise.allSettled(this.signers.map(s => post(s, at ? '/batch-ready' : '/health', {}, at ? 15000 : 1000)));
    return this.signers.filter((s, i) => replies[i].status === 'fulfilled' && replies[i].value.id === s.id && replies[i].value.network === this.network && replies[i].value.epoch === this.epoch
      && (!at || Number.isSafeInteger(replies[i].value.counted) && replies[i].value.counted >= at.counted && Number.isSafeInteger(replies[i].value.tip) && replies[i].value.tip >= at.tip));
  }
  async ready(at) { return (await this.healthy(at)).length >= 3; }
  async bindPayout(record, { bitcoinNetwork }) {
    const replies = await Promise.allSettled(this.signers.map(s => post(s, '/bind-payout', record)));
    const options = { network: this.network, bitcoinNetwork, members: this.signers.map(s => s.peer) };
    const attestations = replies.flatMap((r, i) => r.status === 'fulfilled' && r.value?.signer === this.signers[i].id && verifyBindingAttestation(record, r.value, options) ? [r.value] : []);
    check(attestations.length >= 3, 'binding_quorum_unavailable', 503);
    return attestations;
  }
  async attestRoot(seal) {
    const key = `${seal.tip}/${seal.hash}`, saved = this.store.get('receiptCertificates', key);
    if (saved) { check(saved.seal.root === seal.root && saved.seal.count === seal.count, 'receipt_root_conflict'); return saved.attestations; }
    const replies = await Promise.allSettled(this.signers.map(s => post(s, '/attest-root', { tip: seal.tip, hash: seal.hash })));
    const attestations = replies.filter(r => r.status === 'fulfilled').map(r => r.value);
    check(rules.verifyRootAttestations(seal, attestations, this.signers.map(s => s.peer)), 'receipt_quorum_unavailable', 503);
    await this.store.put('receiptCertificates', key, { seal, attestations }); return attestations;
  }
  signature(key, proposal) { return this.signatureGate(() => this.sign(key, proposal)); }
  retireUnprepared(key) { return this.signatureGate(async () => {
    const session = this.store.get('ceremonies', key);
    if (session?.stage !== 'blocked' || session.reason !== 'prepare_incomplete') return null;
    if (session.retryPrepare || session.retryBusy || session.unreserved?.length || session.failures?.every(e => e === 'committee_signer_busy')) return null;
    const selected = this.signers.filter(s => session.peers.includes(s.id));
    check(selected.length === 3, 'ceremony_members', 503);
    const states = await Promise.allSettled(selected.map(s => post(s, '/status', { id: session.id })));
    if (!states.every(r => r.status === 'rejected' && r.reason.message === 'committee_ceremony_id')) return null;
    const replies = await Promise.allSettled(selected.map(s => post(s, '/retire-unprepared', { network: this.network, id: session.id }, 60000)));
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
    const states = await Promise.allSettled(selected.map(s => post(s, '/preparation-state', { id: session.id })));
    check(states.every(r => r.status === 'fulfilled' && r.value.id === session.id && r.value.reserved === false && r.value.retired === false), 'ceremony_reservation_unresolved', 503);
    await this.store.put('ceremonies', key, { ...session, retryPrepare: true, unreserved: selected.map(s => s.id) });
    return { session: session.id, status: 'retry-original-preparation' };
  }); }
  async sign(key, proposal) {
    let session = this.store.get('ceremonies', key);
    if (!this.activeSigning) {
      this.activeSigning = new Set(); let after = '';
      for (;;) {
        const page = this.store.list('ceremonies', { after, limit: 256 });
        for (const row of page) if (['prepared', 'running'].includes(row.value.stage)) this.activeSigning.add(row.id);
        if (page.length < 256) break; after = page.at(-1).id;
      }
    }
    for (const id of this.activeSigning) if (!['prepared', 'running'].includes(this.store.get('ceremonies', id)?.stage)) this.activeSigning.delete(id);
    if (session?.stage !== 'complete' && [...this.activeSigning].some(id => id !== key)) return null;
    if (!session) {
      const at = proposal.kind === 'batch' ? { counted: proposal.batch.to, tip: Math.max(...proposal.files.map(f => rules.decodeBinary(Buffer.from(f, 'hex')).tip)) } : undefined;
      const quorum = (await this.healthy(at)).slice(0, 3);
      if (at && quorum.length < 3) return null;
      check(quorum.length === 3, 'committee_quorum_unavailable', 503);
      session = { id: randomBytes(32).toString('hex'), stage: 'prepared', proposal, peers: quorum.map(s => s.id), started: Date.now() };
      await this.store.put('ceremonies', key, session); this.activeSigning.add(key);
      const selected = this.signers.filter(s => session.peers.includes(s.id));
      const responses = await Promise.allSettled(selected.map(s => post(s, '/prepare', { proposal, ceremony: { id: session.id, epoch: this.epoch, peers: selected.map(s => s.peer) } }, 60000)));
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
      await Promise.all(selected.map(s => post(s, '/go', { id: session.id })));
    }
    check(session.proposalHash ? session.proposalHash === hash(JSON.stringify(proposal)) : JSON.stringify(session.proposal) === JSON.stringify(proposal), 'ceremony_proposal_changed', 409);
    if (session.stage === 'complete') return session.result;
    check(session.reason !== 'signature_disagreement', 'signature_disagreement', 503);
    const selected = this.signers.filter(s => session.peers.includes(s.id));
    // Status retrieval is safe even if the gateway died after signing completed.
    let states = await Promise.allSettled(selected.map(s => post(s, '/status', { id: session.id })));
    // Retry only missing members with a bound no-reservation refusal (or the
    // legacy busy refusal). Existing reservations remain untouched.
    const retry = session.stage === 'blocked' && session.reason === 'prepare_incomplete' &&
      (session.retryPrepare === true || session.retryBusy === true || session.failures?.length === selected.length && session.failures.every(e => e === 'committee_signer_busy'));
    if (retry && states.some(s => s.status === 'rejected')) {
      // Never prepare through a timeout or sidecar error. An authenticated
      // absent-session reply is needed as well as the earlier refusal proof.
      if (states.some((s, i) => s.status === 'rejected' && (s.reason.message !== 'committee_ceremony_id'
        || !(session.unreserved?.includes(selected[i].id) || session.retryBusy || session.failures?.every(e => e === 'committee_signer_busy'))))) return null;
      const responses = await Promise.allSettled(selected.map((s, i) => states[i].status === 'fulfilled' ? null :
        post(s, '/prepare', { proposal, ceremony: { id: session.id, epoch: this.epoch, peers: selected.map(s => s.peer) } }, 60000)));
      const failures = responses.filter(r => r.status === 'rejected').map(r => r.reason.message);
      const digests = responses.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value.digest);
      if (session.digest) digests.push(session.digest);
      if (digests.some(d => !/^[0-9a-f]{64}$/.test(d)) || new Set(digests).size > 1) {
        await this.store.put('ceremonies', key, { ...session, stage: 'blocked', reason: 'signature_disagreement', retryPrepare: false, retryBusy: false });
        throw Error('signature_disagreement');
      }
      const unreserved = selected.filter((s, i) => responses[i].status === 'rejected' && (responses[i].reason.unreserved || responses[i].reason.message === 'committee_signer_busy')).map(s => s.id);
      session = { ...session, retryBusy: false, retryPrepare: failures.length === unreserved.length, unreserved, failures,
        ...(digests.length ? { digest: digests[0] } : {}) };
      await this.store.put('ceremonies', key, session);
      if (failures.length) { check(session.retryPrepare, 'ceremony_requires_recovery', 503); return null; }
      states = await Promise.allSettled(selected.map(s => post(s, '/status', { id: session.id })));
    }
    const reported = states.filter(s => s.status === 'fulfilled' && s.value.digest !== undefined).map(s => s.value.digest);
    if (session.digest) reported.push(session.digest);
    if (reported.some(d => !/^[0-9a-f]{64}$/.test(d)) || new Set(reported).size > 1
      || states.some(s => s.status === 'fulfilled' && s.value.id !== undefined && s.value.id !== session.id)) {
      await this.store.put('ceremonies', key, { ...session, stage: 'blocked', reason: 'signature_disagreement', retryPrepare: false, retryBusy: false });
      throw Error('signature_disagreement');
    }
    const available = states.every(s => s.status === 'fulfilled' && ['prepared', 'running', 'complete'].includes(s.value.status));
    if (available && states.some(s => s.value.status === 'prepared')) {
      check(session.stage !== 'blocked' || session.reason === 'prepare_incomplete' && (session.failures?.length || session.retryBusy === true || session.retryPrepare === true), 'ceremony_requires_recovery', 503);
      // Resume only the original durable session, after every selected signer
      // confirms that exact session exists. Reserved slots are never replaced.
      session = { ...session, stage: 'running', started: Date.now(), resumed: Date.now() }; this.activeSigning.add(key);
      await this.store.put('ceremonies', key, session);
      await Promise.all(selected.map((s, i) => states[i].value.status === 'prepared' ? post(s, '/go', { id: session.id }) : null)); return null;
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
