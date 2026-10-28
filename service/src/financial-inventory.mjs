import { FINANCIAL_PREFIXES, financialRecoveryKey } from '../../contract/financial-records.js';
import { assetSettings } from '../../contract/asset-settings.js';
import { rules } from './rules.mjs';
import { check } from './util.mjs';

// A complete range read against the notary's pinned checkout, never the
// gateway's list of possibly affected IDs. Each call is bounded by live
// operator page/byte settings and resumes after its final key.
export async function financialInventoryPage(view, { after = '', limit }, settings) {
  const policy = assetSettings(settings);
  check((after === '' || financialRecoveryKey(after)) && Number.isSafeInteger(limit) && limit > 0 && limit <= policy.paymentPage, 'financial_inventory_range');
  const rows = []; let bytes = 0;
  for (const prefix of FINANCIAL_PREFIXES) {
    if (after >= prefix + '\uffff') continue;
    const range = { gte: prefix, lt: prefix + '\uffff', limit: limit - rows.length, ...(after >= prefix ? { gt: after } : {}) };
    for await (const row of view.createReadStream(range)) {
      check(financialRecoveryKey(row.key), 'financial_inventory_key');
      const size = Buffer.byteLength(rules.stableJSON([row.key, row.value]));
      check(size <= policy.proofBytes, 'financial_inventory_record_bytes');
      if (bytes + size > policy.proofBytes) return rows;
      rows.push({ key: row.key, value: row.value }); bytes += size;
      if (rows.length === limit) return rows;
    }
  }
  return rows;
}

export async function acceptedFinancialRecord({ store, audits, key, value }) {
  const location = await store.get('financialRecordProvenance', key);
  check(location && Number.isSafeInteger(location.file) && location.file >= 0 && Number.isSafeInteger(location.index) && location.index >= 0, 'financial_record_provenance_missing');
  const input = (await audits(location.n))[location.file]?.financialOperations?.[location.index];
  check(input?.recordCommitments?.some(([k, digest]) => k === key && digest === rules.hashObject(value)) && input.chainAnchor, 'financial_record_provenance_binding');
  return { anchor: input.chainAnchor, transition: input.transition };
}
