import { publicIdentities, tracReadRoute } from '../../rules/src/trac-address.js';
import { bindingId, bindingKey, verifyAgentBinding, verifyWalletBinding, verifyBinding, payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { check, serial } from './util.mjs';
import { pageRows } from './paging.mjs';

const nonceKey = nonce => nonce.padStart(20, '0');
const WALLET_PLAYERS = 16;
export class Bindings {
  constructor({ store, network, bitcoinNetwork, members, committee, rosterHistory = [], now = Date.now }) {
    Object.assign(this, { store, network, bitcoinNetwork, members, committee, rosterHistory, now }); this.gate = serial();
  }
  options() { return { network: this.network, bitcoinNetwork: this.bitcoinNetwork, members: this.members, rosterHistory: this.rosterHistory, now: this.now() }; }
  current(agent, rail) {
    const id = this.store.get('payoutCurrent', bindingKey(agent, rail));
    if (!id) return null;
    const proof = this.validProof(id); if (!proof) return null;
    check(proof.request.agent === agent && proof.request.rail === rail, 'binding_index');
    return proof;
  }
  proof(id) { const row = this.store.get('payoutBindings', id); check(row, 'binding_missing'); return verifyBinding(row, this.options()); }
  validProof(id) {
    const row = this.store.get('payoutBindings', id);
    // Only fully verified certificates establish a current public binding.
    // Explicit proof/quote lookups remain strict and reject invalid records.
    try { return verifyBinding(row, this.options()); } catch { return null; }
  }
  resolve(agent, rail, snapshot, role) {
    if (!agent) { check(!snapshot?.payouts?.[role], 'binding_role'); return null; }
    const transition = this.store.get('payoutTransitions', bindingKey(agent, rail));
    check(!transition || snapshot && snapshot.issuedAt < transition.acceptedAt, 'binding_transition', 409);
    const record = snapshot ? this.proof(snapshot.payouts?.[role]) : this.current(agent, rail);
    check(record, (role === 'firstMaker' ? 'first_maker' : role) + '_address_missing');
    check(record.request.agent === agent && record.request.rail === rail, 'binding_role');
    if (snapshot) {
      check(record.acceptedAt <= snapshot.issuedAt, 'binding_quote_time');
      const next = this.store.list('payoutHistory/' + bindingKey(agent, rail), { after: nonceKey(record.request.nonce), limit: 1 })[0];
      check(!next || this.proof(next.value).acceptedAt > snapshot.issuedAt, 'binding_superseded');
    }
    return record;
  }
  owners(address) {
    const rows = []; let after = '';
    for (;;) {
      const page = this.store.list('payoutCurrent', { after, limit: 256 });
      for (const r of page) if (r.id.endsWith('/tap')) { const p = this.current(r.id.slice(0, -4), 'tap'); if (p?.request.address === address) rows.push(p.request.agent); }
      if (page.length < 256) return rows;
      after = page.at(-1).id;
    }
  }
  // Players whose current, verified payout binding names this wallet. Raw rows are
  // filtered by address first, so only matching certificates are verified.
  wallets(input) {
    const ethereum = /^0x[0-9a-fA-F]{40}$/.test(input ?? ''), address = ethereum ? input.toLowerCase() : input;
    try { payoutAddress(ethereum ? 'ethereum' : 'tap', address, this.bitcoinNetwork); } catch { check(false, 'wallet_address'); }
    const players = []; let after = '', more = false;
    for (;;) {
      const page = this.store.list('payoutCurrent', { after, limit: 256 });
      for (const r of page) {
        if (this.store.get('payoutBindings', r.value)?.request?.address !== address) continue;
        const rail = r.id.slice(65), proof = this.current(r.id.slice(0, 64), rail); if (proof?.request.address !== address) continue;
        if (players.length === WALLET_PLAYERS) { more = true; break; }
        players.push({ agent: proof.request.agent, rail, binding: proof.id, acceptedAt: proof.acceptedAt });
      }
      if (more || page.length < 256) return { address, rail: ethereum ? 'ethereum' : 'tap', players, more };
      after = page.at(-1).id;
    }
  }
  request(envelope) { return this.gate(async () => {
    check(envelope && Object.keys(envelope).every(k => ['request', 'agentSignature'].includes(k)), 'binding_envelope');
    const id = bindingId(this.network, this.bitcoinNetwork, envelope.request), saved = this.store.get('payoutRequests', id);
    if (saved) return this.pending(id);
    verifyAgentBinding(envelope, this.options());
    const current = this.current(envelope.request.agent, envelope.request.rail);
    check(!current || BigInt(envelope.request.nonce) > BigInt(current.request.nonce), 'binding_nonce', 409);
    await this.store.put('payoutRequests', id, envelope);
    return this.pending(id);
  }); }
  pending(id) {
    const envelope = this.store.get('payoutRequests', id); check(envelope, 'binding_request_missing', 404);
    return { id, ...envelope, network: this.network, bitcoinNetwork: this.bitcoinNetwork,
      message: verifyAgentBinding(envelope, { ...this.options(), historical: true }),
      state: this.store.get('payoutBindings', id) ? 'accepted' : 'awaiting_wallet', bindPath: '/bind-payout/' + id };
  }
  complete({ id, walletSignature }) { return this.gate(async () => {
    const accepted = this.store.get('payoutBindings', id);
    if (accepted) { check(accepted.walletSignature === walletSignature, 'binding_conflict', 409); return this.proof(id); }
    const pending = this.store.get('payoutRequests', id); check(pending, 'binding_request_missing', 404);
    const envelope = { ...pending, walletSignature };
    check(verifyWalletBinding(envelope, this.options()) === id, 'binding_id');
    const key = bindingKey(pending.request.agent, pending.request.rail), current = this.current(pending.request.agent, pending.request.rail);
    check(!current || BigInt(pending.request.nonce) > BigInt(current.request.nonce), 'binding_nonce', 409);
    let record = this.store.get('payoutAttempts', id);
    if (record) check(record.walletSignature === walletSignature, 'binding_conflict', 409);
    else {
      record = { id, ...envelope, acceptedAt: this.now() };
      check(!current || record.acceptedAt > current.acceptedAt, 'binding_clock');
      await this.store.transact([{ space: 'payoutAttempts', id, value: record }, { space: 'payoutTransitions', id: key, value: { id, acceptedAt: record.acceptedAt } }]);
    }
    record = { ...record, attestations: await this.committee.bindPayout(record, this.options()) };
    verifyBinding(record, this.options());
    await this.store.transact([{ space: 'payoutBindings', id, value: record }, { space: 'payoutCurrent', id: key, value: id },
      { space: 'payoutHistory/' + key, id: nonceKey(record.request.nonce), value: id }, { space: 'payoutAttempts', id }, { space: 'payoutTransitions', id: key }]);
    return record;
  }); }
  read(input) { return publicIdentities(this.readWire(tracReadRoute(input))); }
  readWire(input) {
    const url = new URL(input, 'http://127.0.0.1');
    const pending = /^\/payout-bindings\/requests\/([0-9a-f]{64})$/.exec(url.pathname);
    if (pending) { check(!url.search, 'unknown_parameter'); return this.pending(pending[1]); }
    const match = /^\/payout-bindings\/([0-9a-f]{64})\/(tap|ethereum)(\/history)?$/.exec(url.pathname);
    check(match, 'not_found', 404);
    if (!match[3]) { check(!url.search, 'unknown_parameter'); return { agent: match[1], rail: match[2], binding: this.current(match[1], match[2]) }; }
    const rows = []; let after = '';
    for (;;) {
      const page = this.store.list('payoutHistory/' + bindingKey(match[1], match[2]), { after, limit: 256 });
      for (const row of page) {
        const proof = this.validProof(row.value); if (!proof) continue;
        check(proof.request.agent === match[1] && proof.request.rail === match[2] && row.id === nonceKey(proof.request.nonce), 'binding_index');
        rows.push(proof);
      }
      if (page.length < 256) break; after = page.at(-1).id;
    }
    const page = pageRows(rows, url.searchParams, { keys: ['acceptedAt', 'id'], sort: 'acceptedAt', order: 'desc', route: url.pathname });
    return { bindings: page.entries.map(e => e.row), ...page.meta };
  }
}
