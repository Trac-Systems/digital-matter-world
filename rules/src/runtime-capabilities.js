import { assert, hashObject } from './core.js';
import { validateSettingsDocument, SETTINGS_CAPABILITIES } from './settings-v2.js';
import { validateResourceDocument } from './resource-settings.js';

// Parser support is published separately from operator limits. A smaller local
// resource envelope makes a replica unready before a receipt is acknowledged.
export function runtimeCapabilities(document, resources) {
  const d = validateSettingsDocument(document), local = validateResourceDocument(resources).values, v = d.values;
  assert(resources.version >= 3, 'resource_upgrade_required');
  assert(!v.closureWorkBudget || resources.version >= 4, 'resource_closure_capacity');
  assert(v.receiptSegmentEntries <= local.storePageRows && v.receiptSegmentEntries <= local.intakeEntries &&
    v.moveBytes <= local.sourceResponseBytes && v.proofBytes <= local.sourceResponseBytes &&
    v.auditTotalBytes <= local.archiveObjectBytes && v.accountProofBytes <= local.archiveObjectBytes &&
    v.auditTotalBytes * 2 + v.batchBytes + v.batchEnvelopeReserveBytes <= local.signerRequestBytes,
    'resource_consensus_capacity');
  return { integer: 2, batch: 2, file: 5, receipt: 2, settingsHash: hashObject(d), resourceHash: hashObject(resources),
    parser: { ...SETTINGS_CAPABILITIES, binaryDepth: 16, outerWireBytes: 131072 } };
}
