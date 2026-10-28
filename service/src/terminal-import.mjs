import { buildAccountImport } from '../../contract/account-import.js';
import { EMPTY_IMPORT_ROOT, importPageRoot } from '../../contract/activation-v2.js';
import { AccountAvailability } from './account-availability.mjs';
import { EMPTY_ACCOUNT_ROOT } from '../../contract/account-tree.js';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { importFinancialIdentities } from './financial-import.mjs';
import { verifyFinancialMigration } from './pending-financial.mjs';
import { reconcileLegacySignatures } from './pending-signatures.mjs';
import { publicAccountWrites } from './public-accounts.mjs';
import { publicTerminalFinancialWrites } from './public-terminal-import.mjs';

// Offline transformation of a complete, independently reconciled terminal
// state. Runtime admission never calls this enumerating importer.
export function prepareTerminalImport({ records, height, pageBytes = 90000, network, financialSnapshot, pendingWork, gatewayRows, document }) {
  const financial = buildAccountImport(records, height), imported = new Map(records), nodes = new AccountAvailability({ get: () => null });
  check(!financialSnapshot || financialSnapshot.height === height && typeof network === 'string', 'financial_snapshot_height');
  const identities = importFinancialIdentities({ network, records, snapshot: financialSnapshot });
  const migration = pendingWork?.financialMigration && verifyFinancialMigration(pendingWork.financialMigration,
    { rows: gatewayRows, records, snapshot: financialSnapshot, network, document, height });
  const signatures = pendingWork?.signatureReconciliation && reconcileLegacySignatures({ rows: gatewayRows, records, network });
  if (signatures) check(rules.stableJSON(signatures) === rules.stableJSON(pendingWork.signatureReconciliation), 'pending_signature_reconciliation');
  if (pendingWork) {
    // An incomplete gateway index must not hide a notary-side obligation.
    // Identity retention exists, but pending financial execution still needs
    // the separate legacy-to-v2 payment/permit adapter.
    const outstanding = [...records].some(([key, row]) => /^m\/[0-9a-f]{64}$/.test(key) &&
      (row.s === 0 && (row.h || height <= row.e) || row.s === 1 && !financialSnapshot?.requests.get(key.slice(2))?.terminal));
    check(migration || !outstanding && !(financialSnapshot?.links.size) && !(financialSnapshot?.custody.size), 'pending_financial_adapter_required');
  }
  for (const [key, value] of identities.records) {
    if (migration && /^fi\/(capacity|deployment|plot)\//.test(key)) continue;
    check(!imported.has(key), 'financial_import_collision'); imported.set(key, value);
  }
  const remember = (name, leaves, record) => {
    imported.set('ar/' + name, record);
    if (leaves.size) nodes.update(EMPTY_ACCOUNT_ROOT, { empty: true }, leaves, { accountLeaves: leaves.size, proofBytes: Number.MAX_SAFE_INTEGER });
  };
  for (const a of financial.accounts) remember(a.address, a.leaves, a.record);
  remember('supply', financial.supply.leaves, { root: financial.supply.root, revision: financial.supply.revision });
  imported.set('fp/usage', { root: financial.payments.root, revision: financial.payments.revision });
  if (financial.payments.leaves.size) nodes.update(EMPTY_ACCOUNT_ROOT, { empty: true }, financial.payments.leaves, { accountLeaves: financial.payments.leaves.size, proofBytes: Number.MAX_SAFE_INTEGER });
  for (const [key, value] of [...financial.obligations, ...financial.locks]) imported.set(key, value);
  if (migration) for (const [key, value] of migration.records) {
    check(!imported.has(key) || key.startsWith('ao/'), 'financial_import_collision'); imported.set(key, value);
  }
  let financialRoot = identities.root ? rules.hashObject(['dmw-terminal-financial-v2', financial.financialRoot, identities.root]) : financial.financialRoot;
  if (pendingWork) {
    check(pendingWork.commitment.network === network && pendingWork.commitment.anchor.height === String(height) &&
      pendingWork.root === rules.hashObject(['dmw-pending-work-v1', pendingWork.commitment]), 'pending_import_root');
    imported.set('v2-pending-work', pendingWork.commitment);
    financialRoot = rules.hashObject(['dmw-terminal-pending-v1', financialRoot, pendingWork.root]);
  }
  imported.set('v2-financial-root', financialRoot);
  const ordered = [...imported].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), pages = [];
  let previous = EMPTY_IMPORT_ROOT, rows = [];
  const flush = () => { if (!rows.length) return; const page = { part: pages.length, previous, records: rows, final: false }; previous = importPageRoot(previous, rows); pages.push(page); rows = []; };
  for (const row of ordered) {
    if (rows.length && Buffer.byteLength(rules.stableJSON({ part: pages.length, previous, records: [...rows, row], final: false })) > pageBytes) flush();
    check(Buffer.byteLength(rules.stableJSON(row)) + 256 <= pageBytes, 'activation_import_record_budget'); rows.push(row);
  }
  flush(); pages.at(-1).final = true;
  const owners = new Map([...records].filter(([k]) => /^a\/[0-9a-f]{64}$/.test(k)).map(([k, v]) => [String(v), k.slice(2)])), balances = new Map();
  const touch = (owner, asset) => balances.set(owner + '/' + asset, { owner, asset });
  for (const [key, value] of records) {
    const match = /^(?:v|e)\/([0-9]+)\/([0-9a-z]+)$/.exec(key);
    if (match) touch(owners.get(match[1]), match[2]);
    if (/^l\/[0-9a-f]{64}$/.test(key)) for (const [asset] of value.assets) touch(owners.get(String(value.o)), asset);
  }
  const publicWrites = publicAccountWrites({ store: { get: () => null }, get: key => imported.get(key), availability: nodes, balances: balances.values() });
  const heads = new Set(publicWrites.filter(w => w.space === 'publicBalanceHeads').map(w => w.id));
  for (const a of financial.accounts) if (!heads.has(a.address))
    publicWrites.push({ space: 'publicBalanceHeads', id: a.address, value: a.record });
  if (!balances.size) publicWrites.push({ space: 'publicSummaries', id: 'outstandingSupply', value: {
    matterIssued: '0', matterBurned: '0', matter: '0', matterHead: imported.get('ar/supply'),
    matterMeaning: 'materialized_account_units_including_holds' } });
  publicWrites.push(...publicTerminalFinancialWrites(records, identities.gateway, height));
  return { financialRoot, importRoot: previous, importRows: ordered.length, pages, financialIdentities: identities.gateway, publicWrites, ...(pendingWork ? { pendingWork } : {}),
    ...(migration ? { financialMigration: { records, snapshot: financialSnapshot, document, height, writes: migration.writes } } : {}),
    ...(signatures ? { signatureRecords: records } : {}),
    availability: nodes.writes(), accountRecords: ordered.filter(([key]) => (migration ? /^(ar|ao|al|fp|fi|fm|fd|dc|fl|fc|bc)\// : /^(ar|ao|al|fp)\//).test(key)).map(([id, value]) => ({ space: 'accountRecords', id, value })) };
}
