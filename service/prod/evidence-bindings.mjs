import { bindingKey, verifyBinding } from '../../rules/src/payout-bindings.mjs';
import { Bindings } from '../src/bindings.mjs';
import { check, hash } from '../src/util.mjs';

// Read-only asynchronous counterpart; gateway writes keep the existing API.
export class EvidenceBindings extends Bindings {
  async proof(id) { const row = await this.store.get('payoutBindings', id); check(row, 'binding_missing'); return verifyBinding(row, this.options()); }
  async current(agent, rail) {
    const id = await this.store.get('payoutCurrent', bindingKey(agent, rail));
    if (!id) return null;
    const proof = await this.proof(id);
    check(proof.request.agent === agent && proof.request.rail === rail, 'binding_index'); return proof;
  }
  async resolve(agent, rail, snapshot, role) {
    if (!agent) { check(!snapshot?.payouts?.[role], 'binding_role'); return null; }
    const key = bindingKey(agent, rail), transition = await this.store.get('payoutTransitions', key);
    check(!transition || snapshot && snapshot.issuedAt < transition.acceptedAt, 'binding_transition', 409);
    const record = snapshot ? await this.proof(snapshot.payouts?.[role]) : await this.current(agent, rail);
    check(record, (role === 'firstMaker' ? 'first_maker' : role) + '_address_missing');
    check(record.request.agent === agent && record.request.rail === rail, 'binding_role');
    if (snapshot) {
      check(record.acceptedAt <= snapshot.issuedAt, 'binding_quote_time');
      const next = (await this.store.list('payoutHistory/' + key, { after: record.request.nonce.padStart(20, '0'), limit: 1 }))[0];
      check(!next || (await this.proof(next.value)).acceptedAt > snapshot.issuedAt, 'binding_superseded');
    }
    return record;
  }
  async owners(address) {
    const owners = []; let after = '';
    for (;;) {
      const page = await this.store.list('payoutOwners/' + hash(address), { after });
      for (const row of page) {
        const p = await this.proof(row.value);
        check(p.request.address === address && row.id === bindingKey(p.request.agent, 'tap'), 'binding_index');
        owners.push(p.request.agent); if (owners.length > 1) return owners;
      }
      if (page.length < this.store.settings.pageRows) return owners;
      after = page.at(-1).id;
    }
  }
}
