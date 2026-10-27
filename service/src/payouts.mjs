import { check, hash } from './util.mjs';
import { rules } from './rules.mjs';

export class Payouts {
  constructor({ store, files }) { Object.assign(this, { store, files }); }
  accruals(draft) {
    const operations = [], totals = new Map();
    for (const item of draft.items) for (const commission of item.output.file.commissions ?? []) {
      const id = `${commission.id}/${commission.role}`;
      if (this.store.get('commissionOwed', id)) continue;
      const key = hash(commission.to), total = totals.get(key) ?? this.store.get('payoutTotals', key) ?? { beneficiary: commission.to, accrued: '0', paid: '0' };
      total.accrued = (BigInt(total.accrued) + BigInt(commission.amount)).toString(); totals.set(key, total);
      operations.push({ space: 'commissionOwed', id, value: { ...commission, rail: this.store.get('mints', commission.id)?.kind ?? null, batch: draft.proposal.batch.n, observation: item.output.file.observation } });
    }
    return [...operations, ...[...totals].map(([id, value]) => ({ space: 'payoutTotals', id, value }))];
  }
  async record({ beneficiary, amount, txid, reference }) {
    check(typeof beneficiary === 'string' && beneficiary.length > 0 && beneficiary.length <= 128 && /^[1-9][0-9]{0,77}$/.test(amount) && /^[0-9a-f]{64}$/.test(txid) && typeof reference === 'string' && reference.length > 0 && reference.length <= 128, 'payout_input');
    const id = hash(reference), old = this.store.get('payoutPaid', id), value = { beneficiary, amount, txid, reference };
    if (old) { check(JSON.stringify(old) === JSON.stringify(value), 'payout_reference_conflict'); return; }
    const key = hash(beneficiary), total = this.store.get('payoutTotals', key);
    check(total && BigInt(total.accrued) - BigInt(total.paid) >= BigInt(amount), 'payout_exceeds_owed');
    await this.store.transact([{ space: 'payoutPaid', id, value }, { space: 'payoutTotals', id: key, value: { ...total, paid: (BigInt(total.paid) + BigInt(amount)).toString() } }]);
    await this.publish();
  }
  async publish() {
    const counts = {};
    for (const [name, space] of [['beneficiaries', 'payoutTotals'], ['owed', 'commissionOwed'], ['paid', 'payoutPaid']]) {
      let after = '', page = 0;
      for (;;) {
        const rows = this.store.list(space, { after, limit: 100 });
        await this.files.json(`records/payouts/${name}/${page}.json`, { unit: rules.TAP_UNIT, rows: rows.map(({ id, value }) => ({ id, ...value, ...(space === 'payoutTotals' ? { owed: (BigInt(value.accrued) - BigInt(value.paid)).toString() } : {}) })), next: rows.length === 100 ? `${page + 1}.json` : null });
        page++; if (rows.length < 100) break; after = rows.at(-1).id;
      }
      counts[name] = { count: this.store.count(space), first: `${name}/0.json` };
    }
    await this.files.json('records/payouts/index.json', { version: 1, currency: 'TAP', unit: rules.TAP_UNIT, paidEvidence: 'operator_recorded_transaction', ...counts });
  }
}
