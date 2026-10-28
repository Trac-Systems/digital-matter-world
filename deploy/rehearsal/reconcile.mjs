import { MigrationRows, gatewayRowsRoot } from '../../service/src/migration-pages.mjs';
import { operatorManifest, operatorExportHash } from './operator-pages.mjs';
import { createPublicKey, verify, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { rules as r } from '../../service/src/rules.mjs';
import { preparePendingWork } from '../../service/src/pending-work.mjs';
import { prepareFinancialMigration, terminalRecordsRoot } from '../../service/src/pending-financial.mjs';
import { reconcileLegacySignatures } from '../../service/src/pending-signatures.mjs';
import { prepareTerminalImport } from '../../service/src/terminal-import.mjs';
import { prepareDiskTerminalImport } from '../../service/src/terminal-plan.mjs';
import { checkPublic } from './export.mjs';

const need = (ok, reason) => { if (!ok) throw Error(reason); };
const same = (a, b) => r.stableJSON(a) === r.stableJSON(b);
export const operatorExportBytes = body => Buffer.from((body.version === 2 ? 'dmw-operator-migration-export-v2|' : 'dmw-operator-migration-export-v1|') + r.stableJSON(operatorManifest(body)));

// This view is built afresh for EACH operator from THAT operator's signed
// export. No derivation shares a gateway Store, notary map or import plan.
function publicView(rows) {
  if (rows instanceof MigrationRows) return { db: rows.db, migrationRowsView: rows, get: (s, id) => rows.get(s, id), hasRows: s => rows.hasRows(s) };
  need(Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.length === 3 && row.slice(0, 2).every(x => typeof x === 'string')), 'reconcile_gateway_rows');
  const map = new Map(rows.map(([space, id, value]) => [JSON.stringify([space, id]), value]));
  need(map.size === rows.length, 'reconcile_gateway_duplicates');
  need(same(rows, [...rows].sort(([a, b], [c, d]) => a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0)), 'reconcile_gateway_order');
  return { migrationRowsView: rows, get: (space, id) => map.get(JSON.stringify([space, id])) ?? null,
    hasRows: space => rows.some(([s]) => s === space),
    db: { prepare: query => {
      need(query === 'SELECT space,id,value FROM records ORDER BY space,id', 'reconcile_read_query');
      return { iterate: () => rows.map(([space, id, value]) => ({ space, id, value: JSON.stringify(value) })) };
    } } };
}
export function verifyOperatorExport(exported, member) {
  checkPublic(exported);
  const { signature, ...body } = exported;
  need([1, 2].includes(body.version) && body.signer === member.id && r.hex(member.identity, 32) && r.hex(signature, 64), 'reconcile_operator_identity');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(member.identity, 'hex')]), format: 'der', type: 'spki' });
  need(verify(null, operatorExportBytes(body), key, Buffer.from(signature, 'hex')), 'reconcile_operator_signature');
  return body;
}
export function deriveOperatorImport({ exported, member, expected, history, workDirectory }) {
  const body = verifyOperatorExport(exported, member);
  need(body.network === expected.network, 'reconcile_operator_identity');
  need(body.gateway === expected.gateway && same(body.anchor, expected.anchor) && body.headersHash === expected.headersHash &&
    r.hashObject(body.document) === expected.settingsHash && same(body.legacySettings, expected.legacySettings), 'reconcile_operator_pins');
  if (expected.artifactsRoot) need(Array.isArray(body.artifacts) && r.hashObject(body.artifacts) === expected.artifactsRoot, 'reconcile_artifact_pins');
  need(body.notary.options.network === body.network && Array.isArray(body.notary.records) && new Map(body.notary.records).size === body.notary.records.length, 'reconcile_notary_records');
  const records = new Map(body.notary.records), store = publicView(body.gatewayRows), last = records.get('bt/last');
  need(terminalRecordsRoot(records) === expected.notaryRoot && gatewayRowsRoot(body.gatewayRows) === expected.gatewayRoot &&
    String(records.get('b/cnt')) === body.anchor.height && String(last.to) === String(store.get('meta', 'ruleState')?.counted) &&
    history.hashAt(Number(body.anchor.height)) === body.anchor.hash && records.get('b/r/' + body.anchor.hash)?.[0] === Number(body.anchor.height), 'reconcile_source_disagreement');
  if (expected.gatewayPages) need(same(body.gatewayRows.commitment, expected.gatewayPages), 'reconcile_page_pins');
  const snapshot = body.financialSnapshot && { ...body.financialSnapshot,
    requests: new Map(body.financialSnapshot.requests), links: new Map(body.financialSnapshot.links), custody: new Map(body.financialSnapshot.custody) };
  for (const kind of ['requests', 'links', 'custody']) if (snapshot) need(snapshot[kind].size === body.financialSnapshot[kind].length, 'reconcile_financial_duplicates');
  need(Array.isArray(body.reservations), 'reconcile_signer_journal');
  const signatureReconciliation = reconcileLegacySignatures({ rows: body.gatewayRows, records, network: body.network, reservations: body.reservations });
  const financialMigration = snapshot && prepareFinancialMigration({ rows: body.gatewayRows, records, snapshot,
    network: body.network, document: body.document, height: Number(body.anchor.height), gateway: body.gateway });
  const pendingWork = preparePendingWork({ store, network: body.network, document: body.document, anchor: body.anchor, lastTo: last.to,
    legacySettings: body.legacySettings, gateway: body.gateway, history, hashAt: history.hashAt, signatureReconciliation, financialMigration, artifactInventory: body.artifacts });
  const args = { records, height: Number(body.anchor.height), network: body.network, document: body.document,
    financialSnapshot: snapshot, pendingWork, gatewayRows: body.gatewayRows };
  const imported = body.gatewayRows instanceof MigrationRows && !snapshot && !financialMigration
    ? prepareDiskTerminalImport({ ...args, file: join(workDirectory ?? dirname(body.gatewayRows.db.location()), 'terminal-plan-' + randomUUID() + '.sqlite') })
    : prepareTerminalImport(args);
  try {
  const roots = { network: body.network, gatewayRoot: pendingWork.sourceRoot, notaryRoot: terminalRecordsRoot(records), headersHash: body.headersHash,
    ...(body.version === 2 ? { gatewayPages: body.gatewayRows.commitment } : {}),
    pendingRoot: pendingWork.root, importRoot: imported.importRoot, importRows: imported.importRows, financialRoot: imported.financialRoot,
    catalogRoot: pendingWork.commitment.catalogRoot, claimsRoot: pendingWork.commitment.claimsRoot,
    ...(expected.artifactsRoot ? { artifactsRoot: expected.artifactsRoot } : {}) };
  if (body.derivation) need(same(body.derivation, roots), 'reconcile_operator_derivation');
  return { signer: member.id, exportHash: operatorExportHash(exported), reservationsRoot: r.hashObject(body.reservations), roots, imported };
  } catch (error) { imported.close?.(); throw error; }
}

export function reconcileOperatorExports({ exports, roster, expected, historyFor }) {
  need(Array.isArray(roster) && roster.length === 5 && new Set(roster.map(m => m.id)).size === 5 &&
    new Set(roster.map(m => m.identity)).size === 5 && Array.isArray(exports) && exports.length === 5 &&
    new Set(exports.map(e => e.signer)).size === 5, 'reconcile_five_operators');
  const results = roster.map(member => {
    const exported = exports.find(row => row.signer === member.id);
    need(exported, 'reconcile_operator_missing');
    const { imported, ...result } = deriveOperatorImport({ exported: exported.version === 2 ? exported : structuredClone(exported), member, expected, history: historyFor(member.id) });
    imported.close?.();
    return result;
  });
  need(results.every(result => same(result.roots, results[0].roots)), 'reconcile_import_disagreement');
  const evidence = { version: 1, reconciled: true, expected, roster, roots: results[0].roots,
    operators: results.map(({ signer, exportHash, reservationsRoot, roots }) => ({ signer, exportHash, reservationsRoot, roots })) };
  return { ...evidence, hash: r.hashObject(['dmw-five-operator-import-v1', evidence]) };
}
