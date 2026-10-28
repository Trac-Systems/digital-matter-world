import { BUILD as configuredBuildRoot } from '../../../local/common.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
let target, entered, resume;
const reached = new Promise(r => entered = r), release = new Promise(r => resume = r);
mock.module('node:fs/promises', { exports: { ...Object.fromEntries(Object.entries(fs).filter(([key]) => key !== 'default')),
  unlink: async path => { if (path === target) { entered(); await release; } return fs.unlink(path); }
} });
const { Store } = await import('../../src/store.mjs');
test('stale-lock reclamation serializes before unlink and leaves one journal writer', async () => {
  const root = `${configuredBuildRoot}/service/regressions`; await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(join(root, 'race-')); target = join(directory, 'writer.lock');
  await fs.writeFile(target, '2000000000');
  const opening = Store.open(directory); await reached;
  await assert.rejects(Store.open(directory), /store_acquisition_recovery/);
  resume(); const a = await opening;
  await assert.rejects(Store.open(directory), /store_in_use/);
  await a.put('rows', 'a', true); await a.close();
  const reopened = await Store.open(directory); assert.equal(reopened.get('rows', 'a'), true); await reopened.close();
});
