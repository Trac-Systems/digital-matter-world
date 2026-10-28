import { receiptSegmentKey as rulesSegmentKey } from '../../rules/src/receipt-segments.js';
import { opendir, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from './util.mjs';

export async function removeFile(path) {
  try { await unlink(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
export async function pruneDrafts(store) {
  const live = store.get('meta', 'draft')?.external;
  let dir; try { dir = await opendir(join(store.directory, 'drafts')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for await (const entry of dir) if (entry.isFile() && /^[0-9a-f]{64}\.json$/.test(entry.name) && entry.name !== live + '.json') await removeFile(join(store.directory, 'drafts', entry.name));
}
export async function collectFiles(store, files) {
  for (const { id } of store.list('fileGarbage', { limit: 256 })) {
    if (!/^\/patterns\/[a-z0-9]+\/[0-9]+(?:-detail(?:-index)?)?-[0-9a-f]{64}\.json$/.test(id)) throw Error('retention_path');
    await removeFile(files.path(id.slice(1))); await store.put('fileGarbage', id);
  }
}
// A current publication can crash between writing its immutable file, updating
// its pointer and checkpointing feedVersions. Reconcile those writes on startup.
export async function recoverFeedVersions(store, files) {
  let root; try { root = await opendir(files.path('patterns')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for await (const asset of root) if (asset.isDirectory() && /^[a-z0-9]+$/.test(asset.name)) {
    for await (const entry of await opendir(files.path('patterns/' + asset.name))) {
      const match = /^([0-9]+)-[0-9a-f]{64}\.json$/.exec(entry.name); if (!entry.isFile() || !match) continue;
      const path = `/patterns/${asset.name}/${entry.name}`, key = `${asset.name}/${match[1]}`;
      const saved = store.get('feedVersions', key) ?? [];
      let current; try { current = JSON.parse(await readFile(files.path(`patterns/${asset.name}/${match[1]}.json`), 'utf8')).path; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const versions = (current ? [current, ...saved.filter(p => p !== current)] : saved).slice(0, 16);
      if (JSON.stringify(versions) !== JSON.stringify(saved)) await store.put('feedVersions', key, versions);
      if (!versions.includes(path)) await removeFile(files.path(path.slice(1)));
    }
  }
}
// Completed batches are independently reconstructible from immutable audits.
// Financial ceremonies and unresolved proposals keep their original evidence.
export function acceptedRetention(store, draft) {
  const key = `batch/${draft.proposal.batch.epoch}/${draft.proposal.batch.n}`, session = store.get('ceremonies', key), ops = [];
  if (session?.stage === 'complete') {
    const { proposal, ...rest } = session;
    ops.push({ space: 'ceremonies', id: key, value: { ...rest, proposalHash: hash(JSON.stringify(proposal)) } });
  }
  for (const item of draft.items) {
    const id = item.input.receiptRoot ? rulesSegmentKey(item.input.receiptRoot) : `${item.input.tip}/${item.input.tipHash}`, old = store.get('receiptObservations', id);
    if (old && !old.archive && !item.missed && item.output.file.receipts.length) ops.push({ space: 'receiptObservations', id, value: { seal: old.seal, archive: item.publication.audit } });
  }
  return ops;
}
