import { payoutBalance, payoutMinimum } from './payout-values.mjs';
import { check, hash } from './util.mjs';
import { rules } from './rules.mjs';

export class Payouts {
  constructor({ store, files }) { Object.assign(this, { store, files }); }
  accruals(draft) {
    const operations = [], totals = new Map(), seen = new Set();
    for (const item of draft.items) {
      const file = item.output.file;
      const commissions = [...file.commissions ?? [], ...(file.financialOperations ?? []).flatMap(input =>
        input.transition.action?.type === 'capacity-finish' ? input.evidence.commissions ?? [] : [])];
      for (const commission of commissions) {
        const legacy = commission.role === 'legacyDeploy';
        const id = `${commission.id}/${commission.role}${legacy ? '/' + commission.deployment : ''}`;
        if (seen.has(id) || this.store.get('commissionOwed', id)) continue;
        seen.add(id);
        const key = hash(commission.to), total = totals.get(key) ?? this.store.get('payoutTotals', key) ?? { beneficiary: commission.to, accrued: '0', paid: '0' };
        total.accrued = (BigInt(total.accrued) + BigInt(commission.amount)).toString();
        if (legacy) {
          check(BigInt(commission.payoutMinAtoms) > 0n, 'legacy_deploy_threshold');
          total.legacyDeploy = true;
          total.payoutMinAtoms = String(BigInt(total.payoutMinAtoms ?? '0') > BigInt(commission.payoutMinAtoms) ? total.payoutMinAtoms : commission.payoutMinAtoms);
        }
        totals.set(key, total);
        operations.push({ space: 'commissionOwed', id, value: { ...commission,
          rail: legacy ? 'tap' : this.store.get('mints', commission.id)?.kind ?? null,
          batch: draft.proposal.batch.n, observation: file.observation,
          ...(legacy ? { source: 'accepted_legacy_deploy_liability', inscription: file.financialOperations.find(input => input.transition.id === commission.id && input.transition.action?.type === 'capacity-finish')?.evidence.inscription } : {}) } });
      }
    }
    return [...operations, ...[...totals].map(([id, value]) => ({ space: 'payoutTotals', id, value }))];
  }
  prepare(beneficiary) {
    check(typeof beneficiary === 'string' && beneficiary.length > 0 && beneficiary.length <= 128, 'payout_input');
    const total = this.store.get('payoutTotals', hash(beneficiary));
    check(total, 'payout_not_found');
    const value = payoutBalance(this.store, total);
    check(BigInt(value.owed) > 0n && value.eligible !== false, 'payout_below_minimum');
    return { beneficiary, amount: value.owed, ...(value.payoutMinAtoms ? { payoutMinAtoms: value.payoutMinAtoms } : {}),
      rail: 'tap', items: [{ tick: 'tap', amt: rules.formatTapAmount(value.owed), address: beneficiary }] };
  }
  async record({ beneficiary, amount, txid, reference }) {
    check(typeof beneficiary === 'string' && beneficiary.length > 0 && beneficiary.length <= 128 && /^[1-9][0-9]{0,77}$/.test(amount) && /^[0-9a-f]{64}$/.test(txid) && typeof reference === 'string' && reference.length > 0 && reference.length <= 128, 'payout_input');
    const key = hash(beneficiary), total = this.store.get('payoutTotals', key);
    const id = hash(reference), old = this.store.get('payoutPaid', id), value = { beneficiary, amount, txid, reference,
      ...(total?.legacyDeploy ? { role: 'legacyDeploy', rail: 'tap', to: beneficiary, state: 'paid', evidence: 'operator_recorded_transaction' } : {}) };
    if (old) { check(['beneficiary', 'amount', 'txid', 'reference'].every(key => old[key] === value[key]), 'payout_reference_conflict'); return; }
    check(total && BigInt(total.accrued) - BigInt(total.paid) >= BigInt(amount), 'payout_exceeds_owed');
    const minimum = payoutMinimum(this.store, total);
    check(!minimum || BigInt(total.accrued) - BigInt(total.paid) >= BigInt(minimum), 'payout_below_minimum');
    await this.store.transact([{ space: 'payoutPaid', id, value }, { space: 'payoutTotals', id: key, value: { ...total, paid: (BigInt(total.paid) + BigInt(amount)).toString() } }]);
    await this.publish();
  }
  async publish() {
    if (this.store.get('meta', 'ruleState')?.batchVersion === 2) {
      const collections = Object.fromEntries([['beneficiaries', 'payoutTotals'], ['owed', 'commissionOwed'], ['paid', 'payoutPaid']]
        .map(([name, space]) => [name, { count: this.store.countUint(space), page: '/payouts/' + name }]));
      return this.files.json('records/payouts/index.json', { version: 2, currency: 'TAP', unit: rules.TAP_UNIT,
        paidEvidence: 'operator_recorded_transaction', ...collections });
    }
    const counts = {};
    for (const [name, space] of [['beneficiaries', 'payoutTotals'], ['owed', 'commissionOwed'], ['paid', 'payoutPaid']]) {
      let after = '', page = 0;
      for (;;) {
        const rows = this.store.list(space, { after, limit: 100 });
        await this.files.json(`records/payouts/${name}/${page}.json`, { unit: rules.TAP_UNIT, rows: rows.map(({ id, value }) => ({ id, ...value, ...(space === 'payoutTotals' ? payoutBalance(this.store, value) : {}) })), next: rows.length === 100 ? `${page + 1}.json` : null });
        page++; if (rows.length < 100) break; after = rows.at(-1).id;
      }
      counts[name] = { count: this.store.count(space), first: `${name}/0.json` };
    }
    await this.files.json('records/payouts/index.json', { version: 1, currency: 'TAP', unit: rules.TAP_UNIT, paidEvidence: 'operator_recorded_transaction', ...counts });
  }
}
