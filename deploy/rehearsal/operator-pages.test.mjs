import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MigrationRows, migrationCommitment, migrationPages, gatewayRowsRoot, iterableArrayRoot } from '../../service/src/migration-pages.mjs';
import { receiveOperatorPages, readOperatorExport, closeOperatorExport, operatorManifest } from './operator-pages.mjs';
import { operatorExportBytes, verifyOperatorExport } from './reconcile.mjs';
import { temp, agent, signEd } from '../../service/test/helpers.mjs';
import { rules as r } from '../../service/src/rules.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records (space TEXT,id TEXT,value TEXT,PRIMARY KEY(space,id)) WITHOUT ROWID');
  const put = db.prepare('INSERT INTO records VALUES(?,?,?)');
  for (let n = 0; n < 37; n++) put.run('headers', String(n).padStart(4, '0'), JSON.stringify({ value: '界😀'.repeat(17), n }));
  // SQLite BINARY orders UTF-8, which differs from JS UTF-16 at these keys.
  for (const id of ['😀', '\uE000']) put.run('unicode', id, JSON.stringify({ id }));
  const rows = new MigrationRows(db); rows.commitment = migrationCommitment(rows, { pageRows: 7, pageBytes: 1500 });
  const who = agent(9813), member = { id: 'operator1', identity: who.address };
  const body = { version: 2, signer: member.id, gatewayRows: rows };
  const exported = { ...body, signature: signEd(operatorExportBytes(body), who.secret) };
  return { db, rows, member, exported };
}
const stream = values => Readable.from(values.map(v => Buffer.from(r.stableJSON(v) + '\n')));
test('bounded signed migration pages survive disk export/reopen with the exact old source digest', async t => {
  const f = fixture(); t.after(() => f.db.close());
  const directory = await temp('ms1-pages-'), path = join(directory, 'operator.json');
  assert.equal(gatewayRowsRoot(f.rows), r.hashObject(['dmw-legacy-gateway-v1', [...f.rows]]));
  assert.equal(iterableArrayRoot(f.rows), r.hashObject([...f.rows]));
  assert.equal(iterableArrayRoot([]), r.hashObject([]));
  const pages = [...migrationPages(f.rows, { pageRows: 7, pageBytes: 1500 })];
  assert(pages.length > 5); assert(pages.every(p => Buffer.byteLength(r.stableJSON(p)) <= 1500));
  const exported = await receiveOperatorPages(stream([operatorManifest(f.exported), ...pages]), path, { maxBytes: 4000, verify: e => verifyOperatorExport(e, f.member) });
  assert.deepEqual([...exported.gatewayRows], [...f.rows]); closeOperatorExport(exported);
  const reopened = await readOperatorExport(path); verifyOperatorExport(reopened, f.member); closeOperatorExport(reopened);
  const db = new DatabaseSync(path + '.rows.sqlite'); db.prepare('DELETE FROM records WHERE id=?').run('0010'); db.close();
  await assert.rejects(readOperatorExport(path), /pending_export_page_root/);
});
test('missing, duplicated, shuffled, substituted, oversized and truncated pages fail closed', async t => {
  const f = fixture(); t.after(() => f.db.close()); const directory = await temp('ms1-page-errors-');
  const manifest = operatorManifest(f.exported), pages = [...migrationPages(f.rows, { pageRows: 7, pageBytes: 1500 })];
  for (const [i, changed] of [pages.slice(1), [...pages, pages[0]], [pages[1], pages[0], ...pages.slice(2)], pages.map((p, i) => i ? p : p.map(row => [row[0], row[1], { altered: true }]))].entries())
    await assert.rejects(receiveOperatorPages(stream([manifest, ...changed]), join(directory, i + '.json'), { verify: e => verifyOperatorExport(e, f.member) }), /migration_row_order|pending_export_page/);
  await assert.rejects(receiveOperatorPages(stream([{ ...manifest, gatewayRows: { ...manifest.gatewayRows, root: '0'.repeat(64) } }, ...pages]), join(directory, 'signature.json'), { verify: e => verifyOperatorExport(e, f.member) }), /reconcile_operator_signature/);
  await assert.rejects(receiveOperatorPages(Readable.from([r.stableJSON(manifest)]), join(directory, 'truncated.json')), /pending_export_truncated/);
  await assert.rejects(receiveOperatorPages(stream([manifest, ...pages]), join(directory, 'budget.json'), { maxBytes: 50 }), /pending_export_budget/);
  assert.throws(() => [...migrationPages([['space', 'id', 'x'.repeat(100)]], { pageBytes: 20, pageRows: 1 })], /migration_row_bytes/);
});
