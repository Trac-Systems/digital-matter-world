import { pendingRows } from './migration-pages.mjs';
import { join } from 'node:path';
import { readPublicJSON } from '../../deploy/rehearsal/export.mjs';
import { rules as r } from './rules.mjs';
import { check } from './util.mjs';

export function verifyPendingArtifacts(rows, artifacts) {
  rows = pendingRows(rows);
  const references = rows.flatMap(([space, id, value]) => space === 'supersededDrafts'
    ? [{ path: 'gateway/retired-drafts/' + value.evidence?.id + '.json', sha256: value.evidence?.hash }]
    : space === 'observationRecovery' ? [{ path: 'gateway/static' + value.path }]
    : space === 'meta' && id === 'draft' && value.external ? [{ path: 'gateway/drafts/' + value.external + '.json', sha256: value.external }] : []);
  check(Array.isArray(artifacts) && artifacts.length === references.length && new Set(artifacts.map(a => a.path)).size === artifacts.length,
    'pending_artifact_coverage');
  for (const ref of references) {
    const artifact = artifacts.find(a => a.path === ref.path);
    check(artifact && r.hex(artifact.sha256, 32) && (!ref.sha256 || ref.sha256 === artifact.sha256) &&
      Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, 'pending_artifact_binding');
  }
  return r.hashObject(artifacts);
}

// Only references committed by the snapshot can name migration artifacts.
// Hashes become part of each operator's signed public evidence.
export async function pendingArtifactInventory(directory, rows) {
  rows = pendingRows(rows);
  const artifacts = [];
  for (const [space, id, value] of rows) {
    let path, expected;
    if (space === 'supersededDrafts') {
      check(r.hex(value.evidence?.id, 32) && r.hex(value.evidence?.hash, 32), 'pending_retired_reference');
      path = 'retired-drafts/' + value.evidence.id + '.json'; expected = value.evidence.hash;
    } else if (space === 'observationRecovery') {
      check(/^[0-9]+$/.test(id) && value.path === '/records/deferred/' + id + '.json', 'pending_recovery_reference');
      path = 'static' + value.path;
    } else if (space === 'meta' && id === 'draft' && value.external) {
      check(r.hex(value.external, 32), 'pending_draft_reference'); path = 'drafts/' + value.external + '.json'; expected = value.external;
    } else continue;
    const artifact = await readPublicJSON(join(directory, path));
    check(!expected || artifact.sha256 === expected, 'pending_artifact_checksum');
    if (space === 'supersededDrafts') check(r.stableJSON(artifact.value.draft?.proposal?.batch) === r.stableJSON(value.batch), 'pending_retired_binding');
    if (space === 'meta') check(r.stableJSON(artifact.value.proposal?.batch) === r.stableJSON(value.proposal?.batch), 'pending_draft_binding');
    if (space === 'observationRecovery') check(artifact.value.reason === value.reason && Array.isArray(artifact.value.entries), 'pending_recovery_binding');
    artifacts.push({ path: 'gateway/' + path, sha256: artifact.sha256, bytes: artifact.bytes,
      ...(space === 'observationRecovery' ? { disposition: 'retained_original_rejection', entries: artifact.value.entries.length } : {}) });
  }
  return artifacts.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
