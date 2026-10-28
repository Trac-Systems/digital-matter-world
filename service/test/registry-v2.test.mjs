import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFeePolicy, changeFeePolicy, FeeQuotes, currentFee } from '../src/fees.mjs';
import { migrateRegistry, readRegistry, updateRegistryAsset, updateRegistryFees, retainRegistryGeneration } from '../src/registry.mjs';

test('keyed registry retains old generations and quotes beyond former lifetime file/row limits', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dmw-registry-v2-'))), path = join(directory, 'registry.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['p' + i, { id: 'deployment-' + i, label: 'x'.repeat(1800), tap: { treasury: 'treasury' } }]));
  let legacy = { feePolicy: createFeePolicy('100'), assets };
  // Many fee revisions are retained, including an admitted quote from the first.
  const revisions = Array.from({ length: 4201 }, (_, i) => ({ ...createFeePolicy(String(100 + i), i * 1000).revisions[0], retiredAt: i < 4200 ? (i + 1) * 1000 : null }));
  legacy.feePolicy = { current: revisions.at(-1).id, revisions };
  await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
  assert.ok((await readFile(path)).length > 8_000_000);
  const original = legacy.feePolicy.revisions[0];
  const migrated = await migrateRegistry(path, { pageRows: 17 });
  assert.equal(migrated.assets.p4999.id, 'deployment-4999'); assert.deepEqual(migrated.feeRevision(original.id), original);
  assert.throws(() => Object.values(migrated.assets), /registry_page_required/);
  assert.ok((await readFile(path)).length < 100); assert.equal(migrated.page('assets', { after: 'p99' }).length, 10);
  await updateRegistryAsset(path, 'p1', old => ({ ...old, id: 'replacement', generation: 2 }));
  await assert.rejects(Promise.resolve().then(() => migrated.assets.p1), /registry_snapshot_changed/);
  let registry = await readRegistry(path);
  assert.equal(registry.assets.p1.id, 'replacement'); assert.deepEqual(registry.asset('p1', 'deployment-1'), assets.p1);
  await assert.rejects(retainRegistryGeneration(path, 'p1', { ...assets.p1, label: 'rewritten' }), /registry_history_changed/);
  const secret = Buffer.alloc(32, 21); let now = 4_200_000;
  const quotes = new FeeQuotes({ network: 'test', secret, registry: () => readRegistry(path), now: () => now });
  const quote = await quotes.issue('test', 5), accepted = await quotes.accept(quote, 'test', 'id', 8, 5);
  now += 1000; await updateRegistryFees(path, { baseFee: '99999' }, now);
  assert.equal((await quotes.accepted(accepted, 'test', 'id', 8)).baseFee, '4300');
  registry = await readRegistry(path); assert.equal(currentFee(registry).baseFee, '99999'); assert.deepEqual(registry.feeRevision(original.id), original);
  assert.deepEqual(JSON.parse(await readFile(path + '.legacy', 'utf8')), legacy);
});

test('keyed registry recovers process death before and after its transaction commit', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dmw-keyed-crash-'))), path = join(root, 'registry.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify({ assets: { p1: { id: 'original' } }, feePolicy: createFeePolicy('100') }), { mode: 0o600 });
  await migrateRegistry(path);
  for (const boundary of ['before', 'after']) {
    const source = `import { updateRegistryAsset } from ${JSON.stringify(new URL('../src/registry.mjs', import.meta.url).href)};
      import { Store } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
      if (${JSON.stringify(boundary)} === 'after') Store.prototype.close = async () => process.exit(86);
      await updateRegistryAsset(${JSON.stringify(path)}, 'p1', old => { if (${JSON.stringify(boundary)} === 'before') process.exit(86); return {id:'replacement'}; });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 86, child.stderr);
    assert.equal((await readRegistry(path)).assets.p1.id, boundary === 'before' ? 'original' : 'replacement');
    await updateRegistryAsset(path, 'p1', old => old); // recovers the abandoned writer lock
    assert.deepEqual((await readRegistry(path)).asset('p1', 'original'), { id: 'original' });
  }
});
