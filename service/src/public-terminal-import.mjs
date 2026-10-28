import { heightKey, check } from './util.mjs';

// The caller has already verified/pinned the complete terminal snapshot. This
// offline pass preserves historical results; it never runs on a public read.
export function publicTerminalFinancialWrites(records, identities, height) {
  const writes = [], payments = new Map(), totals = new Map();
  const put = (space, id, value) => writes.push({ space, id, value });
  for (const [key, value] of records) if (key.startsWith('k/link/')) {
    const row = typeof value === 'string' ? JSON.parse(value) : value;
    check(row?.block != null && row.linkHeight != null, 'public_import_link');
    put('links', heightKey(row.block), row);
  }
  for (const { space, id, value: row } of identities) {
    if (space === 'financialRequests') {
      const raw = records.get('m/' + id), r = row.request;
      const terms = { id, owner: r.owner, asset: r.asset, amount: r.amount, block: r.block ?? null,
        kind: row.payment.rail, payer: row.payment.payer, receiver: row.receiver, deployment: row.deployment.id,
        expiry: r.expires, price: null, fees: [], importedAt: String(height) };
      put('publicFinancialTerms', id, terms);
      put('publicResults/mints', id, { ...terms, requestId: id,
        state: row.terminal ? 'minted' : raw.s === 1 ? 'permit_issued' : raw.h || height <= raw.e ? 'awaiting_payment' : 'expired',
        permitHash: raw.permitHash ?? null, receipt: row.terminal?.evidence ?? null, source: 'verified_terminal_import' });
      if (row.terminal && r.block != null) put('minted', r.asset + '/' + r.block, { id, evidence: row.terminal.evidence, importedAt: String(height) });
      // Pending snapshots can retain candidate allocations for later source
      // verification. Only consumed legacy requests commit paid allocations.
      for (const item of raw.s === 1 ? row.payment.allocations ?? [] : []) {
        const old = payments.get(item.key), used = records.get('pay/' + item.key);
        check(used && used.total === item.total, 'public_import_payment');
        payments.set(item.key, { id: item.key, requestId: old?.requestId ?? id, owner: r.owner, payer: row.payment.payer,
          kind: row.payment.rail, amount: item.total, total: item.total, allocated: used.used,
          role: null, action: 'paid', final: true, source: 'verified_terminal_import', importedAt: String(height) });
      }
    }
    if (space === 'financialLinks') put('publicResults/linkRequests', id, { id, owner: row.request.owner,
      block: String(row.request.height), paymentId: row.paymentId, state: 'imported', source: 'verified_terminal_import' });
    if (space === 'financialCustody') {
      const value = { id, owner: row.owner, amount: row.amount, rail: row.rail ?? null, state: row.state ?? 'claimable', importedAt: String(height) };
      put('publicResults/custody', id, value);
      if (value.state !== 'settled') put('commissionOwed', 'custody/' + id, { ...value, to: row.owner, role: 'custody' });
      const key = 'custody/' + row.owner + '/' + row.rail, total = totals.get(key) ?? { beneficiary: row.owner, rail: row.rail ?? null, accrued: '0', paid: '0' };
      total.accrued = String(BigInt(total.accrued) + BigInt(row.amount));
      if (value.state === 'settled') total.paid = String(BigInt(total.paid) + BigInt(row.amount));
      totals.set(key, total);
    }
  }
  for (const [id, row] of payments) put('publicResults/payments', id, row);
  for (const [id, row] of totals) put('payoutTotals', id, row);
  // Old allocation commitments do not encode fee roles. Never label their
  // unclassified amounts as zero historical burn or invent a split on import.
  put('publicSummaries', 'burn', { tap: '0', ethereum: '0', meaning: 'verified_v2_payment_receipts',
    sinceHeight: String(height), legacyAllocations: String(payments.size), legacyBurn: payments.size ? null : '0' });
  return writes;
}
