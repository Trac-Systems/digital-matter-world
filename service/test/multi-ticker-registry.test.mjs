import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeePolicy } from '../src/fees.mjs';
import { migrateRegistry, readRegistry, registerAdditionalDeployment, selectedDeployment, updateRegistryAsset } from '../src/registry.mjs';
import { generationDigest } from '../src/deployments.mjs';
const id = n => n.repeat(64) + 'i0';
test('chosen ticker names take precedence over convenience aliases while omission stays official', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dmw-ticker-aliases-')); t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, 'registry.json'), official = { asset: 'c1', id: id('1'), kind: 'compound', tick: 'dmwc1', indexTick: 'dmwc1',
    privilege: id('2'), authorityKey: 'key', options: { max: '100', dec: '0' }, generation: 1 };
  await writeFile(path, JSON.stringify({ feePolicy: createFeePolicy('100'), assets: { c1: official } })); await migrateRegistry(path);
  for (const [tick, value] of [['1', '3'], ['official', '4']]) {
    const entry = { ...official, id: id(value), tick, indexTick: tick, officialDeployment: official.id };
    entry.approval = generationDigest(entry); await registerAdditionalDeployment(path, 'c1', entry);
    assert.equal((await readRegistry(path)).deployment('c1', tick).id, entry.id);
  }
  assert.equal((await readRegistry(path)).deployment('c1').id, official.id);
  assert.equal((await readRegistry(path)).deployment('c1', official.id).id, official.id);
});
test('additional entries have stable ordinals, preserve official bytes and resolve by named keys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dmw-tickers-')); t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, 'registry.json'), official = { asset: 'p2:0', id: id('1'), kind: 'dmt', tick: 'official', indexTick: 'dmt-official',
    elementId: id('2'), privilege: id('3'), authorityKey: 'key', options: {}, generation: 1 };
  official.approval = generationDigest(official);
  await writeFile(path, JSON.stringify({ feePolicy: createFeePolicy('100'), assets: { 'p2:0': official } })); await migrateRegistry(path);
  const entry = { ...official, id: id('4'), tick: 'chosen', indexTick: 'dmt-chosen', officialDeployment: official.id };
  entry.approval = generationDigest(entry);
  const a = await registerAdditionalDeployment(path, 'p2:0', entry); assert.equal(a.ordinal, '2');
  assert.deepEqual(await registerAdditionalDeployment(path, 'p2:0', entry), a);
  await assert.rejects(registerAdditionalDeployment(path, 'p2:0', { ...entry, id: id('5') }), /ticker_registered/);
  await assert.rejects(registerAdditionalDeployment(path, 'p2:1', { ...entry, asset: 'p2:1' }), /additional_deployment_binding/);
  const registry = await readRegistry(path);
  assert.equal(JSON.stringify(registry.asset('p2:0')), JSON.stringify(official));
  for (const selector of ['chosen', 'dmt-chosen', id('4')]) assert.deepEqual(selectedDeployment(registry, 'p2:0', selector), a);
  assert.deepEqual(selectedDeployment(registry, 'p2:0'), official);
  assert.equal(registry.deployment('p2:1', id('4')), null);
  assert.equal(registry.officialName('official'), 'p2:0');
  const successor = { ...official, id: id('6'), tick: 'nextofficial', indexTick: 'dmt-nextofficial', generation: 2 };
  successor.approval = generationDigest(successor);
  await updateRegistryAsset(path, 'p2:0', () => successor);
  const pending = { ...entry, id: id('7'), tick: 'later', indexTick: 'dmt-later' }; pending.approval = generationDigest(pending);
  assert.equal((await registerAdditionalDeployment(path, 'p2:0', pending)).ordinal, '3');
  assert.deepEqual((await readRegistry(path)).asset('p2:0'), successor);
});
