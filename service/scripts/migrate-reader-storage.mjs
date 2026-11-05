import { parseArgs } from 'node:util';
import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { migrateRegistry } from '../src/registry.mjs';
import { rules } from '../src/rules.mjs';
import { check, hash, atomicWrite } from '../src/util.mjs';
import { evidenceSettings } from '../prod/evidence.mjs';

export async function migrateReaderStorage({ data, network, contexts, registry, settings = {}, storeSettings, registrySettings }) {
  const limits = evidenceSettings(settings);
  if (registry) await migrateRegistry(registry, registrySettings);
  if (!data) return;
  check(isAbsolute(data) && typeof network === 'string' && network.length > 0 && isAbsolute(contexts), 'migration_arguments');
  const store = await Store.open(data, storeSettings); // refuses a live writer
  try {
    let after = store.get('readerMigration', 'batches') ?? '';
    for (;;) {
      const page = store.list('batches', { after, limit: limits.pageRows });
      for (const { id, value } of page) {
        const bytes = [];
        for (const p of value.publications) {
          check(/^\/blocks\/[a-zA-Z0-9._-]+\.bin$/.test(p.audit.path), 'migration_archive_path');
          const filename = resolve(data, 'static', p.audit.path.slice(1));
          check((await stat(filename)).size <= limits.maxObjectBytes, 'migration_archive_size');
          const b = await readFile(filename); check(hash(b) === p.audit.hash, 'migration_archive_hash'); bytes.push(b);
        }
        check(rules.merkleRoot(bytes) === value.batch.root, 'migration_batch_root');
        for (const [file, b] of bytes.entries()) {
          const audit = rules.decodeBinary(b);
          for (const [index, input] of (audit.mintOperations ?? []).entries()) if (input.op === 'rq' && audit.mintOutcomes?.[index]?.reason === 'accepted') {
            await store.put('mintAdmissions', rules.pendingId(network, input.request), { n: value.batch.n, file, index });
          }
        }
        // Only the derived cursor/index changes; accepted bytes stay untouched.
        await store.put('readerMigration', 'batches', id);
      }
      if (page.length < limits.pageRows) break; after = page.at(-1).id;
    }
    for (const name of await readdir(contexts)) if (/^[1-9][0-9]*\.json$/.test(name)) {
      const filename = join(contexts, name); check((await stat(filename)).size <= limits.maxObjectBytes, 'migration_context_size');
      const bytes = await readFile(filename), digest = hash(bytes);
      await atomicWrite(join(contexts, digest + '.json'), bytes);
      await store.put('evidenceContexts', name.slice(0, -5), { path: digest + '.json', hash: digest });
    }
    await store.rebuildEvidenceIndex(); await store.compact();
  } finally { await store.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['data', 'network', 'contexts', 'registry', 'settings'].map(k => [k, { type: 'string' }])) });
    check(values.data || values.registry, 'migration_arguments');
    const { settings: settingsFile, ...paths } = values;
    await migrateReaderStorage({ ...paths, ...(settingsFile ? JSON.parse(await readFile(settingsFile, 'utf8')) : {}) });
    console.log('Reader storage migration complete. Accepted records and archives retained.');
  } catch { console.error('Reader storage migration failed. Use stopped, backed-up stores and explicit --data, --network, --contexts and/or --registry paths.'); process.exitCode = 1; }
}
