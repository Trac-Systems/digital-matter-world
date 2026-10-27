import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateRegistry } from '../src/registry.mjs';

test('registry lock recovers process death on both sides of atomic persistence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-registry-')), path = join(directory, 'registry.json');
  t.after(() => rm(directory, { recursive: true }));
  await writeFile(path, JSON.stringify({ retained: true, revision: 0 }));
  for (const boundary of ['before', 'after']) {
    const source = `import { updateRegistry } from ${JSON.stringify(new URL('../src/registry.mjs', import.meta.url).href)};
      import { Store } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
      if (${JSON.stringify(boundary)} === 'after') Store.prototype.close = async () => process.exit(86);
      await updateRegistry(${JSON.stringify(path)}, row => { if (${JSON.stringify(boundary)} === 'before') process.exit(86); return {...row, committed:true}; });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 86, child.stderr);
    if (boundary === 'after') assert.equal(JSON.parse(await readFile(path, 'utf8')).committed, true);
    const row = await updateRegistry(path, value => ({ ...value, revision: value.revision + 1 }));
    assert.equal(row.retained, true);
  }
  assert.equal(JSON.parse(await readFile(path, 'utf8')).revision, 2);
});
