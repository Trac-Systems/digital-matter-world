import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';
import { financialFeeKey } from './financial-fee-identity.mjs';

const sum = rows => rows.reduce((n, row) => n + BigInt(row.amount), 0n).toString();
const clean = row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
export function publicFinancialTerms(id, evidence, action) {
  return clean({ id, owner: evidence.owner ?? action?.owner, asset: evidence.asset ?? action?.asset,
    amount: evidence.amount ?? action?.amount, block: evidence.request?.block ?? evidence.block ?? evidence.capacity?.block ?? evidence.capacity?.plot ?? null,
    kind: evidence.rail ?? null, receiver: evidence.receiver ?? null, payer: evidence.payer ?? null,
    expiry: evidence.expiry ?? action?.until ?? null, deployment: evidence.deployment?.id ?? null,
    price: sum(evidence.fees ?? []), ...(evidence.legacyDeploy ? { legacyDeploy: evidence.legacyDeploy } : {}), fees: (evidence.feeItems ?? []).map(f => clean({ key: financialFeeKey(f),
      role: f.role, to: f.to, ticker: f.ticker, amount: f.amount, beneficiary: f.financialIdentity?.beneficiary ?? null })) });
}

// This receives only the accepted draft and its exact write set. No source
// calls or scans are allowed here. All results commit with the accepted roots.
export function publicFinancialOperations(store, draft, acceptedWrites) {
  const changes = new Map(), overlay = new Map(), linked = new Map(), key = (space, id) => space + '\0' + id;
  for (const w of acceptedWrites) overlay.set(key(w.space, w.id), w.value);
  const get = (space, id) => overlay.has(key(space, id)) ? overlay.get(key(space, id)) : store.get(space, id);
  const put = (space, id, value) => {
    const w = { space, id, ...(value == null ? {} : { value }) }; changes.set(key(space, id), w); overlay.set(key(space, id), value);
  };
  const batch = rules.decimalV2(draft.proposal.batch.n);
  for (const item of draft.items) {
    const file = item.output.file, financial = [];
    for (const [index, input] of (file.financialOperations ?? []).entries()) {
      const t = input.transition, a = t.action, e = input.evidence, id = t.id;
      const action = a?.type ?? t.type, provenance = { batch, observation: rules.decimalV2(file.observation), index,
        evidence: rules.hashObject(e) };
      if (t.type === 'reserve' || action === 'link-reserve') put('publicFinancialTerms', id, publicFinancialTerms(id, e, a));
      const terms = get('publicFinancialTerms', id), owner = e.owner ?? a?.owner ?? terms?.owner ??
        get('accountRecords', 'bc/' + id)?.owner ?? get('accountRecords', 'fc/' + (a?.operation?.credit ?? id))?.owner;
      if (action === 'link-complete') linked.set(String(e.block ?? terms?.block), { requestId: id, acceptedOwner: owner });
      financial.push({ id: rules.hashObject(['dmw-public-financial-event-v2', t]), type:
        action === 'capacity-finish' ? 'mint_complete' : action === 'link-complete' ? 'link' : 'financial_' + action.replaceAll('-', '_'),
      data: clean({ requestId: id, owner, to: a?.operation?.to, asset: terms?.asset ?? e.asset, block: terms?.block ?? e.block,
        amount: terms?.amount ?? e.amount, action, state: e.state, credit: a?.operation?.credit }), provenance });
      if (t.type === 'fund' || t.type === 'surplus') for (const receipt of t.items) {
        const old = get('publicResults/payments', receipt.key), fee = terms?.fees.find(f => f.key === receipt.fee),
          fact = e.paymentFacts?.find(f => f.key === receipt.key);
        check(!old || old.total === receipt.total && old.fee === receipt.fee, 'public_payment_identity');
        const allocated = BigInt(old?.allocated ?? '0') + BigInt(receipt.amount);
        check(allocated <= BigInt(receipt.total), 'public_payment_allocation');
        put('publicResults/payments', receipt.key, clean({ id: receipt.key, requestId: id, owner, payer: terms?.payer,
          block: fact?.height ?? null, targetBlock: terms?.block ?? null, reference: fact?.reference ?? null, anchor: fact?.anchor,
          fee: receipt.fee, role: fee?.role ?? null, to: fee?.to ?? null, ticker: fee?.ticker ?? null,
          kind: terms?.kind ?? null, amount: receipt.total, total: receipt.total, allocated: String(allocated),
          action: 'paid', final: true, confirmations: e.confirmations, provenance }));
        // A receipt can fund several pages, then become a reusable credit.
        // Count its independently verified external total exactly once.
        if (!old && fee?.role === 'burn' && ['tap', 'ethereum'].includes(terms?.kind)) {
          const burn = get('publicSummaries', 'burn') ?? { tap: '0', ethereum: '0', meaning: 'verified_accepted_payment_receipts' };
          put('publicSummaries', 'burn', { ...burn, [terms.kind]: String(BigInt(burn[terms.kind]) + BigInt(receipt.total)), batch });
        }
      }
      if (action === 'custody-settle') {
        const row = get('accountRecords', 'bc/' + id);
        if (row) put('payoutPaid', 'custody/' + id, { beneficiary: row.owner, to: row.destination, amount: row.amount,
          rail: row.rail, receipt: row.receipt, requestId: row.request, evidence: 'independently_verified_settlement', provenance });
      }
      if (action === 'capacity-finish') put('publicMintReceipts', id, clean({ receipt: e.receipt, inscription: e.inscription, provenance }));
    }
    const feed = get('feedEvents', heightKey(file.observation));
    if (feed && financial.length) put('feedEvents', heightKey(file.observation), { ...feed, financial });
  }

  // The write set is bounded by this batch. Deduplicate keys before updating
  // aggregates, including when several observations touch the same record.
  const records = new Map(acceptedWrites.filter(w => w.space === 'accountRecords').map(w => [w.id, w.value]));
  const requests = new Set();
  let quarantined = BigInt(store.get('publicFinancialHealth', 'quarantined') ?? '0');
  for (const [id, row] of records) {
    let match;
    if (id.startsWith('fq/')) quarantined += BigInt(Number(row != null) - Number(store.get('accountRecords', id) != null));
    if ((match = /^(?:ao|fp|dc)\/([0-9a-f]{64})$/.exec(id))) requests.add(match[1]);
    if ((match = /^fl\/([0-9a-f]{64})$/.exec(id))) {
      const requestId = match[1], terms = get('publicFinancialTerms', requestId);
      put('publicResults/linkRequests', requestId, row && { ...terms, id: requestId, ...row, batch });
    }
    if (id.startsWith('k/link/') && row) {
      const link = typeof row === 'string' ? JSON.parse(row) : row;
      put('links', heightKey(link.block), { ...link, ...linked.get(String(link.block)) });
      put('feedBlockChanges', 'link/' + link.block, { block: link.block });
    }
    if ((match = /^fc\/([0-9a-f]{64})$/.exec(id))) put('publicResults/credits', match[1], row && {
      id: match[1], owner: row.owner, revision: row.revision, fees: row.fees, amount: sum(row.fees), batch });
    if ((match = /^bc\/([0-9a-f]{64})$/.exec(id))) {
      const requestId = match[1], old = store.get('publicResults/custody', requestId);
      put('publicResults/custody', requestId, row && { id: requestId, ...row, batch });
      if (row) {
        const totalId = 'custody/' + row.owner + '/' + row.rail;
        const total = get('payoutTotals', totalId) ?? { beneficiary: row.owner, rail: row.rail, accrued: '0', paid: '0' };
        put('payoutTotals', totalId, { ...total,
          accrued: String(BigInt(total.accrued) + (old ? 0n : BigInt(row.amount))),
          paid: String(BigInt(total.paid) + (row.state === 'settled' && old?.state !== 'settled' ? BigInt(row.amount) : 0n)) });
        put('commissionOwed', 'custody/' + requestId, row.state === 'settled' ? null : {
          id: requestId, to: row.owner, beneficiary: row.owner, rail: row.rail, amount: row.amount, state: row.state,
          role: 'custody', batch, source: 'accepted_custody_liability' });
      }
    }
  }
  check(quarantined >= 0n, 'public_quarantine_count');
  put('publicFinancialHealth', 'quarantined', String(quarantined));
  for (const id of requests) {
    const terms = get('publicFinancialTerms', id), obligation = get('accountRecords', 'ao/' + id), funding = get('accountRecords', 'fp/' + id), capacity = get('accountRecords', 'dc/' + id);
    if (obligation) {
      const state = capacity?.state === 'minted' ? 'minted' : obligation.state === 'consumed' ? 'permit_issued' :
        obligation.state === 'refunded' ? funding?.state ?? 'refunded' : funding?.paid.some(n => n !== '0') ?
          funding.fees.every((f, i) => f.amount === funding.paid[i]) ? 'paid' : 'partly_paid' : 'awaiting_payment';
      put('publicResults/mints', id, { ...terms, id, requestId: id, owner: obligation.owner, asset: obligation.asset,
        amount: obligation.amount, state, funding: funding ? { state: funding.state, paid: funding.paid, root: funding.root } : null,
        permitHash: obligation.permitHash ?? null, ...get('publicMintReceipts', id), batch, source: 'accepted_financial_delta' });
      if (capacity?.state === 'minted' && capacity.plot !== null) {
        put('minted', capacity.asset + '/' + capacity.plot, { id, batch, evidence: capacity.evidence });
        put('feedBlockChanges', 'mint/' + id, { block: capacity.plot, asset: capacity.asset });
      }
    }
    if (terms?.kind === 'ethereum' && funding) put('publicResults/ethereum', id, { id, owner: terms.owner, payer: terms.payer,
      amount: terms.price, status: funding.state === 'refunded' ? 3 : funding.paid.some(n => n !== '0') ? 2 : null,
      state: funding.state, paid: funding.paid, split: Object.fromEntries(terms.fees.flatMap(f => {
        const role = f.role === 'firstMaker' ? 'finder' : f.role;
        return [[role + 'Amount', f.amount], ...(role === 'burn' ? [] : [[role, f.to]])];
      })), batch, source: 'accepted_verified_escrow_delta' });
    const link = get('accountRecords', 'fl/' + id);
    if (link) put('publicResults/linkRequests', id, { ...terms, id, ...link, funding: funding ? {
      state: funding.state, paid: funding.paid, root: funding.root } : null, batch });
  }
  return [...changes.values()];
}
