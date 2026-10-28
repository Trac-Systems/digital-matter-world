import { constants } from 'node:fs';
import { open, realpath, writeFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { rules as r } from '../../service/src/rules.mjs';
import { MigrationRows, migrationCommitment, migrationPages, migrationPageRoot, EMPTY_MIGRATION_ROOT, createMigrationRows, appendMigrationPage, orderedRow } from '../../service/src/migration-pages.mjs';
import { checkPublic, readPublicJSON } from './export.mjs';
const need = (ok, reason) => { if (!ok) throw Error(reason); };

export function operatorManifest(exported) {
  if (exported.version !== 2) return exported;
  const rows = exported.gatewayRows;
  return { ...exported, gatewayRows: rows instanceof MigrationRows ? rows.commitment : rows };
}
export const operatorExportHash = exported => r.hashObject(operatorManifest(exported));
export async function writeOperatorResponse(res, exported) {
  if (exported.version !== 2) { res.end(JSON.stringify(exported)); return; }
  need(exported.gatewayRows instanceof MigrationRows, 'pending_export_rows');
  res.setHeader('Content-Type', 'application/x-ndjson');
  const write = async value => {
    need(!res.destroyed, 'pending_export_disconnected');
    if (!res.write(r.stableJSON(value) + '\n')) await new Promise((resolve, reject) => {
      const clean = () => { res.off('drain', drain); res.off('close', close); res.off('error', error); };
      const drain = () => { clean(); resolve(); }, close = () => { clean(); reject(Error('pending_export_disconnected')); },
        error = () => { clean(); reject(Error('pending_export_disconnected')); };
      res.once('drain', drain); res.once('close', close); res.once('error', error);
    });
  };
  await write(operatorManifest(exported));
  for (const rows of migrationPages(exported.gatewayRows, exported.gatewayRows.commitment && {
    pageRows: exported.gatewayRows.commitment.pageRows, pageBytes: exported.gatewayRows.commitment.pageBytes })) await write(rows);
  res.end();
}
async function* lines(stream, maxBytes) {
  let parts = [], bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk); let start = 0;
    for (let at = buffer.indexOf(10); at >= 0; at = buffer.indexOf(10, start)) {
      const part = buffer.subarray(start, at); bytes += part.length; need(bytes <= maxBytes, 'pending_export_budget');
      parts.push(part); yield JSON.parse(Buffer.concat(parts, bytes)); parts = []; bytes = 0; start = at + 1;
    }
    if (start < buffer.length) { const part = buffer.subarray(start); bytes += part.length; need(bytes <= maxBytes, 'pending_export_budget'); parts.push(part); }
  }
  need(bytes === 0, 'pending_export_truncated');
}
export async function receiveOperatorPages(stream, output, { maxBytes = 128 * 1024 ** 2, verify } = {}) {
  let manifest, rows, count = 0, pages = 0, root = EMPTY_MIGRATION_ROOT, previous = null;
  // Exclusive reservation: never overwrite even a partial earlier capture.
  const reservation = await open(output + '.rows.sqlite', 'wx', 0o600); await reservation.close();
  try {
    for await (const value of lines(stream, maxBytes)) {
      checkPublic(value);
      if (!manifest) {
        manifest = value;
        need(manifest.version === 2 && manifest.gatewayRows?.version === 2, 'pending_export_format');
        const d = manifest.gatewayRows;
        need(Number.isSafeInteger(d.rows) && d.rows >= 0 && Number.isSafeInteger(d.pages) && d.pages >= 0 &&
          Number.isSafeInteger(d.pageRows) && d.pageRows > 0 && Number.isSafeInteger(d.pageBytes) && d.pageBytes > 0 && d.pageBytes <= maxBytes &&
          r.hex(d.root, 32) && r.hex(d.legacyRoot, 32), 'pending_export_format');
        // Authenticate the small manifest before accepting its pages.
        if (verify) verify(manifest);
        rows = createMigrationRows(output + '.rows.sqlite'); continue;
      }
      const d = manifest.gatewayRows;
      need(Array.isArray(value) && value.length > 0 && value.length <= d.pageRows && Buffer.byteLength(r.stableJSON(value)) <= d.pageBytes, 'pending_export_page');
      for (const row of value) { orderedRow(previous, row); previous = row; }
      appendMigrationPage(rows, value); count += value.length; pages++; root = migrationPageRoot(root, value);
      need(count <= d.rows && pages <= d.pages, 'pending_export_page');
    }
    need(manifest && count === manifest.gatewayRows.rows && pages === manifest.gatewayRows.pages && root === manifest.gatewayRows.root, 'pending_export_page_root');
    const measured = migrationCommitment(rows, { pageRows: manifest.gatewayRows.pageRows, pageBytes: manifest.gatewayRows.pageBytes });
    need(r.stableJSON(measured) === r.stableJSON(manifest.gatewayRows), 'pending_export_page_root');
    rows.commitment = measured; rows.db.exec('PRAGMA query_only=ON');
    const exported = { ...manifest, gatewayRows: rows };
    if (verify) verify(exported);
    await writeFile(output, r.stableJSON(manifest) + '\n', { flag: 'wx', mode: 0o600 });
    return exported;
  } catch (error) { rows?.close(); throw error; }
}
export async function readOperatorExport(path) {
  const { value } = await readPublicJSON(path);
  if (value.version !== 2) return value;
  const file = path + '.rows.sqlite';
  need(await realpath(file) === file && (await stat(file)).isFile(), 'pending_export_path');
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); await fd.close();
  const rows = new MigrationRows(new DatabaseSync(file, { readOnly: true }), { owned: true });
  try {
    rows.db.exec('PRAGMA query_only=ON; BEGIN');
    const d = value.gatewayRows, commitment = migrationCommitment(rows, { pageRows: d.pageRows, pageBytes: d.pageBytes });
    need(r.stableJSON(commitment) === r.stableJSON(d), 'pending_export_page_root');
    rows.commitment = commitment;
    return { ...value, gatewayRows: rows };
  } catch (error) { rows.close(); throw error; }
}
export const closeOperatorExport = exported => exported?.gatewayRows instanceof MigrationRows && exported.gatewayRows.close();
