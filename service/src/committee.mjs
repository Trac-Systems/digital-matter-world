import { randomBytes } from 'node:crypto';
import { check, hash, serial } from './util.mjs';
import { localURL } from './config.mjs';
import { ethereumSignature } from './ethereum.mjs';
import { rules } from './rules.mjs';
import { jsonRequest } from './http-client.mjs';
import { verifyBindingAttestation } from '../../rules/src/payout-bindings.mjs';
export async function post(signer, path, value, timeout = 15000) {
  const { ok, value: result } = await jsonRequest(localURL(signer.url) + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signer.token}` }, body: JSON.stringify(value), timeout, limitCode: 'committee_response_limit' });
  check(ok, /^[a-z][a-z0-9_]{0,70}$/.test(result.error) ? 'committee_' + result.error : 'committee_refused', 503); return result;
}
export class Committee {
  constructor({ store, network, signers, epoch = 1, timeoutMs = 180000 }) {
    check(signers.length === 5 && new Set(signers.map(s => s.id)).size === 5, 'committee_members');
    Object.assign(this, { store, network, signers, epoch, timeoutMs }); this.signatureGate = serial();
  }
  async healthy() {
    const replies = await Promise.allSettled(this.signers.map(s => post(s, '/health', {}, 1000)));
    return this.signers.filter((s, i) => replies[i].status === 'fulfilled' && replies[i].value.id === s.id && replies[i].value.network === this.network && replies[i].value.epoch === this.epoch);
  }
  async ready() { return (await this.healthy()).length >= 3; }
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
    const selected = this.signers.filter(s => session.peers.includes(s.id));
    check(selected.length === 3, 'ceremony_members', 503);
    const states = await Promise.allSettled(selected.map(s => post(s, '/status', { id: session.id })));
    if (!states.every(r => r.status === 'rejected' && r.reason.message === 'committee_ceremony_id')) return null;
    const replies = await Promise.allSettled(selected.map(s => post(s, '/retire-unprepared', { network: this.network, id: session.id }, 60000)));
    if (!replies.every(r => r.status === 'fulfilled' && r.value.id === session.id && r.value.status === 'retired-unprepared')) return null;
    return { session: session.id, peers: selected.map(s => s.id), status: 'retired-unprepared' };
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
      const quorum = (await this.healthy()).slice(0, 3); check(quorum.length === 3, 'committee_quorum_unavailable', 503);
      session = { id: randomBytes(32).toString('hex'), stage: 'prepared', proposal, peers: quorum.map(s => s.id), started: Date.now() };
      await this.store.put('ceremonies', key, session); this.activeSigning.add(key);
      const selected = this.signers.filter(s => session.peers.includes(s.id));
      const responses = await Promise.allSettled(selected.map(s => post(s, '/prepare', { proposal, ceremony: { id: session.id, epoch: this.epoch, peers: selected.map(s => s.peer) } }, 60000)));
      if (responses.some(r => r.status === 'rejected') || new Set(responses.filter(r => r.status === 'fulfilled').map(r => r.value.digest)).size !== 1) {
        await this.store.put('ceremonies', key, { ...session, stage: 'blocked', reason: 'prepare_incomplete', failures: responses.filter(r => r.status === 'rejected').map(r => r.reason.message) }); throw Error('committee_prepare_incomplete');
      }
      session = { ...session, stage: 'running', digest: responses[0].value.digest };
      await this.store.put('ceremonies', key, session);
      await Promise.all(selected.map(s => post(s, '/go', { id: session.id })));
    }
    check(session.proposalHash ? session.proposalHash === hash(JSON.stringify(proposal)) : JSON.stringify(session.proposal) === JSON.stringify(proposal), 'ceremony_proposal_changed', 409);
    if (session.stage === 'complete') return session.result;
    const selected = this.signers.filter(s => session.peers.includes(s.id));
    // Status retrieval is safe even if the gateway died after signing completed.
    let states = await Promise.allSettled(selected.map(s => post(s, '/status', { id: session.id })));
    // An explicit busy refusal occurs before a signer reserves anything. Retry
    // only missing members of that original ceremony, never a new identity or
    // an ambiguous failed preparation. Existing reservations remain untouched.
    const busyOnly = session.stage === 'blocked' && session.reason === 'prepare_incomplete' &&
      (session.retryBusy === true || session.failures?.length === selected.length && session.failures.every(e => e === 'committee_signer_busy'));
    if (busyOnly && states.some(s => s.status === 'rejected')) {
      const responses = await Promise.allSettled(selected.map((s, i) => states[i].status === 'fulfilled' ? null :
        post(s, '/prepare', { proposal, ceremony: { id: session.id, epoch: this.epoch, peers: selected.map(s => s.peer) } }, 60000)));
      const failures = responses.filter(r => r.status === 'rejected').map(r => r.reason.message);
      const digests = responses.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value.digest);
      if (session.digest) digests.push(session.digest);
      check(new Set(digests).size <= 1, 'signature_disagreement', 503);
      session = { ...session, retryBusy: failures.every(e => e === 'committee_signer_busy'), failures,
        ...(digests.length ? { digest: digests[0] } : {}) };
      await this.store.put('ceremonies', key, session);
      if (failures.length) { check(session.retryBusy, 'ceremony_requires_recovery', 503); return null; }
      states = await Promise.allSettled(selected.map(s => post(s, '/status', { id: session.id })));
    }
    const available = states.every(s => s.status === 'fulfilled' && ['prepared', 'running', 'complete'].includes(s.value.status));
    if (available && states.some(s => s.value.status === 'prepared')) {
      check(session.stage !== 'blocked' || session.reason === 'prepare_incomplete' && (session.failures?.length || session.retryBusy === true), 'ceremony_requires_recovery', 503);
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
