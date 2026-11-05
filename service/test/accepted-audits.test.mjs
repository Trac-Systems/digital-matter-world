import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcceptedAudits } from '../src/accepted-audits.mjs';
import { readerSettings } from '../prod/reader-settings.mjs';
import { rules } from '../src/rules.mjs';

function fixture() {
  const bytes = rules.encodeBinary({ v: 5, ops: [] }), accepted = rules.merkleRoot([bytes]);
  const f = { bytes, root: accepted, batch: { batch: { root: accepted }, publications: [{ audit: { path: '/blocks/v2/one.bin', hash: rules.hash(bytes) } }] }, roots: 0, archives: 0 };
  f.read = limits => createAcceptedAudits({ root: async () => { f.roots++; return f.root; }, store: { get: async () => f.batch },
    archive: async () => { f.archives++; return f.bytes; }, limits: readerSettings(limits) });
  return f;
}

test('accepted audit cache still checks independent roots and never accepts gateway substitutions', async () => {
  const f = fixture(), read = f.read();
  assert.deepEqual(await read('1'), [{ v: 5, ops: [] }]); await read('1');
  assert.equal(f.roots, 2); assert.equal(f.archives, 1);
  f.root = rules.hash('changed-root');
  await assert.rejects(read('1'), /accepted_batch_binding/);
  f.batch.batch.root = f.root;
  await assert.rejects(read('1'), /accepted_audit_root/);
  f.root = null;
  await assert.rejects(read('1'), /accepted_batch_missing/);
});

test('unauthenticated, oversized and unsupported audit responses are not retained', async () => {
  const f = fixture(), read = f.read(), original = f.bytes;
  f.bytes = rules.encodeBinary({ v: 5, ops: [{ op: 'fp', type: 'page' }] });
  await assert.rejects(read('1'), /accepted_audit_root/);
  f.bytes = original; assert.deepEqual(await read('1'), [{ v: 5, ops: [] }]);
  assert.equal(f.archives, 2);
  await assert.rejects(f.read({ auditTotalBytes: 1 })('1'), /audit_total_size/);
  f.bytes = rules.encodeBinary({ v: 6, ops: [] }); f.root = f.batch.batch.root = rules.merkleRoot([f.bytes]);
  await assert.rejects(f.read()('1'), /audit_version/);
});

test('a receipt-renewal reservation is accepted as an authenticated batch without audit files', async () => {
  const body = { v: 2, n: '2', ops: [], renewal: { kind: 'reserve', cutoff: { settingsHash: rules.hash('settings') }, votes: [] } };
  const batch = { ...body, root: rules.renewalReservationRoot(body) };
  let accepted = batch.root;
  const read = createAcceptedAudits({ root: async () => accepted, store: { get: async () => ({ batch, publications: [] }) },
    archive: async () => { throw Error('no_archive_expected'); }, limits: readerSettings() });
  assert.deepEqual(await read('2'), []);
  // Any operation, file or different root keeps the ordinary audit-root check.
  for (const change of [{ ops: [{ op: 'kv' }] }, { renewal: { ...body.renewal, kind: 'execute' } }]) {
    const changed = { ...body, ...change }, root = rules.renewalReservationRoot(changed);
    const strict = createAcceptedAudits({ root: async () => root, store: { get: async () => ({ batch: { ...changed, root }, publications: [] }) },
      archive: async () => { throw Error('no_archive_expected'); }, limits: readerSettings() });
    await assert.rejects(strict('2'), /accepted_audit_root/);
  }
  accepted = rules.hash('other-root');
  await assert.rejects(read('3'), /accepted_batch_binding/);
});
