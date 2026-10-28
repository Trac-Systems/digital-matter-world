import assert from 'node:assert/strict';
import { readdir, mkdir, cp, lstat, realpath, statfs, symlink, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, json, save, command, checkout } from '../../service/load/common.mjs';

export function snapshotInventoryHash(files) {
  // Stable field order survives serializers which reorder object keys. Keep
  // the original inventory wire hash, including already captured snapshots.
  if (!Array.isArray(files) || files.some(f => Object.keys(f).sort().join(',') !== 'bytes,path,sha256'
    || typeof f.path !== 'string' || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || !/^[0-9a-f]{64}$/.test(f.sha256)))
    throw Error('snapshot_inventory_shape');
  return digest(JSON.stringify(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))));
}
export async function inventory(root) {
  const rows = [];
  async function walk(relative = '') {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = join(relative, name), st = await lstat(join(root, path));
      if (/(?:credentials|secrets|keyshare|wallet|\.cookie|source\.url)/i.test(path)) throw Error('snapshot_contains_credentials');
      if (st.isSymbolicLink()) throw Error('snapshot_symlink');
      if (st.isDirectory()) await walk(path);
      else if (st.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(join(root, path))) hash.update(chunk);
        rows.push({ path, bytes: st.size, sha256: hash.digest('hex') });
      }
      else throw Error('snapshot_special_file');
    }
  }
  await walk(); return { files: rows, hash: snapshotInventoryHash(rows) };
}
export async function copySnapshot(input, output, { maxBytes = 3 * 1024 ** 3 } = {}) {
  input = resolve(input);
  if (await realpath(input) !== input) throw Error('snapshot_symlink');
  const before = await inventory(input), descriptor = await json(join(input, 'snapshot.json'));
  const bytes = before.files.reduce((sum, file) => sum + file.bytes, 0), fs = await statfs(output.slice(0, output.lastIndexOf('/')));
  if (bytes > maxBytes || fs.bavail * fs.bsize - 3 * bytes < 40 * 1024 ** 3) throw Error('snapshot_copy_disk_budget');
  assert.equal(descriptor.version, 1, 'snapshot_schema');
  assert.equal(descriptor.reconciled, true, 'snapshot_not_reconciled');
  // Read only operator-approved non-secret copies. Never load existing keys.
  if (before.files.some(f => /(?:credentials|secrets|keyshare|wallet|\.cookie|source\.url)/i.test(f.path))) throw Error('snapshot_contains_credentials');
  await cp(input, output, { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await inventory(input), before, 'snapshot_changed_during_copy');
  assert.deepEqual(await inventory(output), before, 'snapshot_copy_mismatch');
  return { before, descriptor, source: input, copy: output };
}
export async function rollbackProbe(snapshot, directory, expected, acceptedV2) {
  // After v2 acceptance this is an isolated branch rehearsal, NEVER a live rollback.
  const rollback = join(directory, 'rollback-old');
  await cp(snapshot.source, rollback, { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await inventory(rollback), snapshot.before);
  // Pin the repository's old main release and load its actual code. Do not call
  // the new implementation's legacy mode and label that an old-binary rollback.
  const oldRevision = (await command('git', ['-C', checkout, 'rev-parse', 'main'])).stdout.trim();
  const release = join(directory, 'old-release'), archive = join(directory, 'old-release.tar'); await mkdir(release);
  await command('git', ['-C', checkout, 'archive', '--format=tar', '--output=' + archive, oldRevision]);
  await command('tar', ['-xf', archive, '-C', release]); await unlink(archive);
  for (const part of ['contract', 'rules', 'service', 'committee', 'kit', 'local', 'eth']) await symlink(join(checkout, part, 'node_modules'), join(release, part, 'node_modules'));
  const { harness } = await import(pathToFileURL(join(release, 'contract/tests/helpers/harness.mjs'))), { Store } = await import(pathToFileURL(join(release, 'service/src/store.mjs')));
  const saved = await json(join(rollback, 'contract.json')), old = harness(saved.options);
  for (const [key, value] of saved.records) old.db.set(key, value);
  assert.deepEqual(await old.state().batchLast(), expected);
  assert(!old.db.has('v2/ready'));
  const store = await Store.open(join(rollback, 'gateway'));
  try { assert(!store.get('meta', 'v2Activation')); assert.equal(store.get('meta', 'ruleState').batchVersion ?? 1, 1); }
  finally { await store.close(); }
  assert.deepEqual(await inventory(snapshot.source), snapshot.before, 'original_snapshot_modified');
  return { passed: true, acceptedV2, oldRevision, scope: 'actual archived main release contract state machine and gateway journal reopened on untouched legacy copy',
    liveRollbackAllowed: acceptedV2 === 0, boundary: 'After a v2 acceptance retain v2 semantics or use forward activation; this isolated copy is not a live rollback.' };
}
export async function syntheticSnapshot(directory, old, store, headers, height) {
  const snapshot = join(directory, 'synthetic-snapshot'); await mkdir(snapshot);
  const rows = [...store.db.prepare('SELECT space,id,value FROM records ORDER BY space,id').iterate()].map(r => [r.space, r.id, JSON.parse(r.value)]);
  await store.close();
  const { writeGatewayCheckpoint } = await import('./export.mjs');
  await writeGatewayCheckpoint({ output: join(snapshot, 'gateway'), rows, sequence: store.sequence });
  await cp(headers, join(snapshot, 'headers.bin'));
  await mkdir(join(snapshot, 'operators'));
  await save(join(snapshot, 'operators', 'terminal.json'), { synthetic: true, accepted: await old.state().batchLast(), unresolvedReservations: [] });
  await save(join(snapshot, 'contract.json'), { options: old.options, records: [...old.db] });
  await save(join(snapshot, 'snapshot.json'), { version: 1, reconciled: true, synthetic: true, height, network: old.options.network,
    accepted: await old.state().batchLast(), source: 'disposable local Bitcoin headers and real legacy contract transitions',
    limitations: ['No live host state', 'No unmodified installed-kit binary', 'No outstanding paid permits in this synthetic baseline'] });
  return snapshot;
}
