import { payoutBalance, payoutMinimum } from './payout-values.mjs';
import { check, hash } from './util.mjs';
import { rules } from './rules.mjs';
import { payoutGate, payoutIndexOperation } from './payout-index.mjs';
import { validDestination } from './mint-sender-keys.mjs';

export class Payouts {
  constructor({ store, files }) { Object.assign(this, { store, files }); }
  accruals(draft) {
    const operations = [], totals = new Map(), seen = new Set();
    for (const item of draft.items) {
      const file = item.output.file;
      const commissions = [...file.commissions ?? [], ...(file.financialOperations ?? []).flatMap(input =>
        input.transition.action?.type === 'capacity-finish' ? input.evidence.commissions ?? [] :
          input.transition.type === 'bulk-finish' ? input.evidence.members.flatMap(m => (m.commissions ?? []).map(c => ({ ...c, bulkInscription: m.inscription }))) : [])];
      for (const commission of commissions) {
        const legacy = ['legacyDeploy', 'deployer'].includes(commission.role);
        const id = `${commission.id}/${commission.role}${legacy ? '/' + commission.deployment : ''}`;
        if (seen.has(id) || this.store.get('commissionOwed', id)) continue;
        seen.add(id);
        const key = hash(commission.to), total = totals.get(key) ?? this.store.get('payoutTotals', key) ?? { beneficiary: commission.to, accrued: '0', paid: '0' };
        total.accrued = (BigInt(total.accrued) + BigInt(commission.amount)).toString();
        if (legacy) {
          check(BigInt(commission.payoutMinAtoms) > 0n, 'legacy_deploy_threshold');
          if (commission.role === 'legacyDeploy') total.legacyDeploy = true;
          else total.deployer = true;
          total.payoutMinAtoms = String(BigInt(total.payoutMinAtoms ?? '0') > BigInt(commission.payoutMinAtoms) ? total.payoutMinAtoms : commission.payoutMinAtoms);
        }
        totals.set(key, total);
        operations.push({ space: 'commissionOwed', id, value: { ...commission,
          rail: legacy ? 'tap' : this.store.get('mints', commission.id)?.kind ?? null,
          batch: draft.proposal.batch.n, observation: file.observation,
          ...(legacy ? { source: commission.role === 'deployer' ? 'accepted_deployer_liability' : 'accepted_legacy_deploy_liability', inscription: commission.bulkInscription ?? file.financialOperations.find(input => input.transition.id === commission.id && input.transition.action?.type === 'capacity-finish')?.evidence.inscription } : {}) } });
      }
    }
    return [...operations, ...[...totals].map(([id, value]) => ({ space: 'payoutTotals', id, value }))];
  }
  prepare(beneficiary) {
    check(typeof beneficiary === 'string' && beneficiary.length > 0 && beneficiary.length <= 128, 'payout_input');
    check(!this.store.get('payoutReserved', hash(beneficiary)), 'payout_reserved');
    const total = this.store.get('payoutTotals', hash(beneficiary));
    check(total, 'payout_not_found');
    const value = payoutBalance(this.store, total);
    check(BigInt(value.owed) > 0n && value.eligible !== false, 'payout_below_minimum');
    return { beneficiary, amount: value.owed, ...(value.payoutMinAtoms ? { payoutMinAtoms: value.payoutMinAtoms } : {}),
      rail: 'tap', items: [{ tick: 'tap', amt: rules.formatTapAmount(value.owed), address: beneficiary }] };
  }
  automatic(beneficiary, network) {
    check(validDestination(beneficiary, network), 'payout_destination');
    const key = hash(beneficiary), reserved = this.store.get('payoutReserved', key);
    if (reserved) return reserved;
    const prepared = this.prepare(beneficiary), total = this.store.get('payoutTotals', key);
    const reference = 'automatic/' + hash('dmw-payout-v1|' + beneficiary + '|' + total.paid);
    return { ...prepared, reference };
  }
  page({ after = '', limit = 50 } = {}, network) {
    check((after === '' || /^[0-9a-f]{64}$/.test(after)) && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'payout_page');
    const page = this.store.list('payoutPayable', { after, limit }), rows = [];
    for (const { id, value } of page) {
      // Bad legacy destinations are reported, never signed or silently converted.
      if (!validDestination(value.beneficiary, network)) { rows.push({ id, beneficiary: value.beneficiary, blocked: 'payout_destination' }); continue; }
      const total = this.store.get('payoutTotals', id), balance = total && payoutBalance(this.store, total);
      if (balance && BigInt(balance.owed) > 0n && (balance.eligible !== false || this.store.get('payoutReserved', id)))
        rows.push({ id, ...this.automatic(value.beneficiary, network) });
    }
    return { rows, next: page.length === limit ? page.at(-1).id : null, queuedCount: this.store.countUint('payoutPayable') };
  }
  reserve(input, network) {
    return payoutGate(this.store, async () => {
      const prepared = this.automatic(input.beneficiary, network);
      check(input.reference === prepared.reference && input.amount === prepared.amount, 'payout_changed');
      if (!this.store.get('payoutReserved', hash(input.beneficiary)))
        await this.store.put('payoutReserved', hash(input.beneficiary), prepared);
      return prepared;
    });
  }
  async rebuildIndex() {
    let after = '';
    for (;;) {
      const rows = this.store.list('payoutPayable', { after, limit: 100 });
      if (!rows.length) break;
      await this.store.transact(rows.map(({ id }) => payoutIndexOperation(id, this.store.get('payoutTotals', id))));
      after = rows.at(-1).id;
    }
    after = '';
    for (;;) {
      const rows = this.store.list('payoutTotals', { after, limit: 100 });
      if (!rows.length) break;
      await this.store.transact(rows.map(({ id, value }) => payoutIndexOperation(id, value)));
      after = rows.at(-1).id;
    }
  }
  record(input, { automatic = false } = {}) {
    return payoutGate(this.store, () => this.recordLocked(input, automatic));
  }
  async recordLocked({ beneficiary, amount, txid, reference }, automatic) {
    check(typeof beneficiary === 'string' && beneficiary.length > 0 && beneficiary.length <= 128 && /^[1-9][0-9]{0,77}$/.test(amount) && /^[0-9a-f]{64}$/.test(txid) && typeof reference === 'string' && reference.length > 0 && reference.length <= 128, 'payout_input');
    const key = hash(beneficiary), total = this.store.get('payoutTotals', key);
    const id = hash(reference), old = this.store.get('payoutPaid', id), value = { beneficiary, amount, txid, reference,
      evidence: automatic ? 'automatic_payout_transaction' : 'operator_recorded_transaction',
      ...(automatic ? { rail: 'tap', to: beneficiary, state: 'paid' } : {}),
      ...(total?.legacyDeploy || total?.deployer ? { role: total.deployer ? 'deployer' : 'legacyDeploy', rail: 'tap', to: beneficiary, state: 'paid' } : {}) };
    if (old) { check(['beneficiary', 'amount', 'txid', 'reference'].every(key => old[key] === value[key]), 'payout_reference_conflict'); return; }
    check(total && BigInt(total.accrued) - BigInt(total.paid) >= BigInt(amount), 'payout_exceeds_owed');
    const reserved = this.store.get('payoutReserved', key);
    check(automatic ? reserved && reserved.reference === reference && reserved.amount === amount : !reserved, 'payout_reserved');
    const minimum = payoutMinimum(this.store, total);
    check(automatic || !minimum || BigInt(total.accrued) - BigInt(total.paid) >= BigInt(minimum), 'payout_below_minimum');
    await this.store.transact([{ space: 'payoutPaid', id, value }, { space: 'payoutTotals', id: key, value: { ...total, paid: (BigInt(total.paid) + BigInt(amount)).toString() } },
      ...(automatic ? [{ space: 'payoutReserved', id: key }] : [])]);
    await this.publish({ paged: automatic });
  }
  async publish({ paged = false } = {}) {
    if (paged || this.store.get('meta', 'ruleState')?.batchVersion === 2) {
      const collections = Object.fromEntries([['beneficiaries', 'payoutTotals'], ['owed', 'commissionOwed'], ['paid', 'payoutPaid']]
        .map(([name, space]) => [name, { count: this.store.countUint(space), page: '/payouts/' + name }]));
      return this.files.json('records/payouts/index.json', { version: 2, currency: 'TAP', unit: rules.TAP_UNIT,
        paidEvidence: 'per_record', ...collections });
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
    await this.files.json('records/payouts/index.json', { version: 1, currency: 'TAP', unit: rules.TAP_UNIT, paidEvidence: 'per_record', ...counts });
  }
}
