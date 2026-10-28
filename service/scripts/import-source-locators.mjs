// Explicit operator maintenance for registries created before named locators.
// Never called by an HTTP action, poll, or signer. The source address is read
// only at runtime; progress and output contain IDs/offsets, never endpoints.
import { readFile, writeFile, rename, stat, chown } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { HttpSource } from '../prod/http.mjs';
import { tapEndpoint } from '../prod/config.mjs';
import { TapReader } from '../prod/tap.mjs';
import { sourcePolicy } from '../prod/source-cache.mjs';
import { check } from '../src/util.mjs';

export async function locateRegistry(registry, tap, { pageSize = 500, pagesPerRun = 16, progress = {}, save = async () => {} } = {}) {
  check(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 500 && Number.isSafeInteger(pagesPerRun) && pagesPerRun > 0, 'locator_import_policy');
  const entries = [...Object.values(registry.assets ?? {}), ...Object.values(registry.generations ?? {}).flat()];
  const operator = registry.operator?.provisioning;
  const wanted = { element: new Set(entries.map(e => e.elementId).filter(Boolean)), authority: new Set([...entries.map(e => e.privilege), operator?.privilege].filter(Boolean)) };
  let remaining = pagesPerRun;
  for (const [kind, method] of [['element', 'getDmtElementsList'], ['authority', 'getPrivilegeAuthList']]) {
    const cursor = progress[kind] ??= { offset: 0, found: {} };
    // Revalidate registry hints before using them. A reorg may move a position;
    // rejecting the old hint must still allow the explicit import to resume.
    const hints = [...entries.map(entry => entry.sourceLocators?.[kind]), ...(kind === 'authority' ? [operator?.sourceLocators?.authority] : [])];
    for (const loc of hints) if (loc && wanted[kind].has(loc.id) && cursor.found[loc.id] === undefined && Number.isSafeInteger(loc.offset) && loc.offset >= 0) {
      const rows = await tap(`${method}?offset=${loc.offset}&max=1`);
      if (Array.isArray(rows) && rows.length === 1 && rows[0].ins === loc.id) cursor.found[loc.id] = loc.offset;
    }
    while ([...wanted[kind]].some(id => cursor.found[id] === undefined) && remaining > 0) {
      const rows = await tap(`${method}?offset=${cursor.offset}&max=${pageSize}`); remaining--;
      check(Array.isArray(rows) && rows.length <= pageSize, 'locator_import_page');
      rows.forEach((row, index) => { if (wanted[kind].has(row.ins)) cursor.found[row.ins] = cursor.offset + index; });
      cursor.offset += rows.length; await save(progress);
      if (rows.length < pageSize && [...wanted[kind]].some(id => cursor.found[id] === undefined)) throw Error('source_locator_missing');
    }
  }
  const complete = Object.entries(wanted).every(([kind, ids]) => [...ids].every(id => progress[kind].found[id] !== undefined));
  if (!complete) return { complete, progress };
  // Re-read every supplied position before publishing the registry update.
  for (const [kind, method] of [['element', 'getDmtElementsList'], ['authority', 'getPrivilegeAuthList']]) for (const id of wanted[kind]) {
    const offset = progress[kind].found[id], rows = await tap(`${method}?offset=${offset}&max=1`);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].ins !== id) {
      delete progress[kind].found[id]; progress[kind].offset = 0; await save(progress);
      return { complete: false, progress };
    }
  }
  const updated = structuredClone(registry);
  for (const entry of [...Object.values(updated.assets ?? {}), ...Object.values(updated.generations ?? {}).flat()]) {
    entry.sourceLocators = { ...entry.sourceLocators, authority: { id: entry.privilege, offset: progress.authority.found[entry.privilege] },
      ...(entry.elementId ? { element: { id: entry.elementId, offset: progress.element.found[entry.elementId] } } : {}) };
  }
  if (operator?.privilege) updated.operator.provisioning.sourceLocators = { ...operator.sourceLocators, authority: { id: operator.privilege, offset: progress.authority.found[operator.privilege] } };
  return { complete, progress, registry: updated };
}

async function main([runtimeFile, progressFile, pages = '16']) {
  check(runtimeFile && progressFile && resolve(runtimeFile) === runtimeFile && resolve(progressFile) === progressFile, 'locator_import_arguments');
  const config = JSON.parse(await readFile(runtimeFile, 'utf8')), policy = sourcePolicy(config.prod.sourceReads);
  const source = new HttpSource({ ...config.prod.http, ...await tapEndpoint(config.prod.bitcoin), maxBytes: policy.tapMaxBytes });
  const indexer = new TapReader({ sources: [source], agreement: 1, sharedTransport: true, policy });
  let progress = {}; try { progress = JSON.parse(await readFile(progressFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const before = await indexer.stamp();
  // A reorg can move positional rows. Restart only this explicit import cursor.
  if (progress.anchor && await indexer.agree('/r/blockhash/' + progress.anchor.height) !== progress.anchor.hash) progress = {};
  progress.anchor = before;
  const save = async value => { await writeFile(progressFile + '.tmp', JSON.stringify(value), { mode: 0o600 }); await rename(progressFile + '.tmp', progressFile); };
  const registry = JSON.parse(await readFile(config.prod.registry, 'utf8'));
  const result = await locateRegistry(registry, path => indexer.tap(path), { progress, pageSize: policy.pageSize, pagesPerRun: Number(pages), save });
  // An append is harmless, but every scanned position must remain on the
  // branch observed when this maintenance slice began.
  check(await indexer.agree('/r/blockhash/' + before.height) === before.hash, 'locator_import_reorg');
  await save(result.progress);
  if (!result.complete) { console.log('Locator import saved; repeat the same command to continue.'); process.exitCode = 75; return; }
  const file = config.prod.registry, owner = await stat(file), tmp = file + '.source-locators';
  await writeFile(tmp, JSON.stringify(result.registry, null, 2) + '\n', { mode: owner.mode & 0o777, flag: 'wx' });
  await chown(tmp, owner.uid, owner.gid); await rename(tmp, file);
  console.log('Registry locators imported. IDs, fees, approvals and generations are unchanged.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(() => { console.error('Locator import failed; retained progress requires operator review.'); process.exitCode = 1; });
