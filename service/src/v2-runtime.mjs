import { migrationGatewayRows } from './migration-pages.mjs';
import { FinancialLinks } from './financial-links.mjs';
import { FinancialActions } from './financial-actions.mjs';
import { FinancialCustody } from './financial-custody.mjs';
import { RecoveryCoordinator } from './recovery-coordinator.mjs';
import { assetCheckpoint } from './asset-provenance.mjs';
import { rules } from './rules.mjs';
import { check, edPublic } from './util.mjs';
import { NamedStorage } from './named-storage.mjs';
import { NamedAdmission } from './named-admission.mjs';
import { SegmentedIntake } from './segmented-intake.mjs';
import { StoredSettingsHistory } from './settings-history.mjs';
import { FinancialExecution } from './financial-execution.mjs';
import { FinancialMints } from './financial-mints.mjs';
import { verifyPendingWork, pendingFinancialWork } from './pending-work.mjs';
import { verifyFinancialMigration } from './pending-financial.mjs';
import { reconcileLegacySignatures } from './pending-signatures.mjs';
import { pendingArtifactInventory } from './pending-artifacts.mjs';
import { pendingInventory, requireSupportedInventory } from './pending-inventory.mjs';
import { closureTimeouts } from '../../rules/src/closure-timeouts.js';
import { requireProductionRelease } from './production-release.mjs';
import { phase } from './lifecycle.mjs';
import { KeyedWork } from './keyed-work.mjs';

// Explicit offline step on a reconciled copy, before starting the new gateway.
// Pending work is reconciled before the manifest/import roots are pinned.
// Installation rederives that plan from the unchanged legacy snapshot.
export async function installGatewayActivation({ store, manifest, manifestHash, document, imported, named, legacySettings, gateway, history, hashAt = history?.hashAt }) {
  rules.activatedBatchSettings({ manifest, manifestHash, document });
  const state = store.get('meta', 'ruleState');
  check(!store.get('meta', 'v2Activation'), 'activation_already_installed');
  const sourceSequence = store.sequence, gatewayRows = migrationGatewayRows(store);
  const inventory = pendingInventory(gatewayRows, imported.records ?? new Map((imported.pages ?? []).flatMap(p => p.records)));
  try { requireSupportedInventory(inventory); }
  catch (error) { throw Error((inventory.unsupported.craftReceipts ? 'pending_receipt_drain_required: ' : 'pending_financial_adapter_required: ') + error.message); }
  if (imported.pendingWork?.artifactInventory) check(rules.stableJSON(await pendingArtifactInventory(store.directory, gatewayRows)) ===
    rules.stableJSON(imported.pendingWork.artifactInventory), 'pending_artifact_changed');
  const pending = imported.pendingWork && verifyPendingWork({ store, pending: imported.pendingWork, network: manifest.network, document,
    anchor: manifest.bitcoinAnchor, lastTo: state?.counted, legacySettings, gateway, history, hashAt, gatewayRows });
  const migration = pending?.financialMigration && verifyFinancialMigration(pending.financialMigration, { ...imported.financialMigration,
    network: manifest.network, document, rows: gatewayRows, gateway });
  const signatures = pending?.signatureReconciliation && reconcileLegacySignatures({ rows: gatewayRows, records: imported.signatureRecords, network: manifest.network });
  if (signatures) check(rules.stableJSON(signatures) === rules.stableJSON(pending.signatureReconciliation), 'pending_signature_reconciliation');
  if (!pending) {
    check(!store.hasRows('supersededDrafts') && !store.hasRows('observationRecovery'), 'pending_artifact_reconciliation_required');
    check(!pendingFinancialWork(gatewayRows).length && !(imported.financialIdentities ?? []).some(row =>
      row.space === 'financialRequests' && !row.value.terminal || ['financialLinks', 'financialCustody'].includes(row.space)), 'pending_financial_adapter_required');
    check(!store.hasRows('outbox'), 'pending_signed_transport_reconciliation');
  }
  check(state && (pending || !(state.rounds?.length) && !(state.discoveryCommits?.length) && !(state.discoveryQueue?.length) &&
    !store.hasRows('observations') && !store.hasRows('dedupe')) && (!store.get('meta', 'draft') || signatures) && !store.get('meta', 'namedReservedBatch'), 'activation_pending_work');
  check(pending || !(store.get('meta', 'patterns')?.length), 'activation_legacy_catalog_adapter_required');
  if (pending) check(rules.namedStateRoot(named) === pending.commitment.catalogRoot, 'pending_catalog_root');
  check(rules.namedStateRoot(named) === manifest.catalogRoot && imported.financialRoot === manifest.accountsRoot, 'activation_import_roots');
  const saved = new NamedStorage({ get: id => store.get('namedNodes', id), cacheSize: 64 }).save(named);
  const claimSnapshot = pending?.commitment.claimSnapshot ?? rules.initialClaimSnapshot(manifest, state.counted), claimRoot = rules.claimStateRoot(claimSnapshot);
  // Neutral exported checkpoints intentionally contain no version-specific
  // derived indexes. Build the evidence index here, while still offline and
  // after reconciliation, before activation writes begin updating it.
  if (!store.evidenceReady) store.rebuildEvidenceIndex();
  check(store.sequence === sourceSequence, 'activation_snapshot_changed');
  function* writes() {
    for (const rows of [pending?.writes ?? [], signatures?.writes ?? [], saved.writes, imported.availability, imported.accountRecords, imported.financialIdentities ?? [], migration?.writes ?? []]) yield* rows;
    if (pending) yield { space: 'meta', id: 'legacyPendingWork', value: { root: pending.root, commitment: pending.commitment } };
    yield* [
    { space: 'meta', id: 'ruleState', value: { ...state, ...claimSnapshot.hot, claimSnapshot, claimRoot, batchVersion: 2, namedSnapshot: saved.snapshot,
      catalogRoot: manifest.catalogRoot, accountRoot: manifest.accountsRoot, nextPatternNumber: named.nextPattern, catalogRevision: named.catalogRevision } },
    { space: 'assetCheckpoint', id: 'current', value: assetCheckpoint({ namedSnapshot: saved.snapshot, claimSnapshot }) },
    { space: 'meta', id: 'v2Activation', value: manifestHash },
    { space: 'settingsHistory', id: manifest.settingsHash, value: document }];
    yield* imported.publicWrites ?? [];
  }
  await store.transactIterable(writes());
}

export async function createV2Runtime({ config, store, secret, history, reads, committee, deferRecovery = false }) {
  await requireProductionRelease({ config, store, reads });
  const pin = config.v2; check(pin?.manifest && pin.document && pin.resources, 'activation_config');
  const settings = rules.activatedBatchSettings({ ...pin,
    receiptSigners: config.committee.map(({ peer: { id, identity } }) => ({ id, identity })) });
  rules.validateResourceDocument(pin.resources);
  check(store.get('meta', 'v2Activation') === pin.manifestHash, 'activation_gateway_import_required');
  const historySettings = new StoredSettingsHistory(store);
  if (reads.feeQuotes) { reads.feeQuotes.settings = () => settings.document; reads.feeQuotes.settingsHistory = historySettings; }
  let accepted, ready = false, intake, financial, mints, links, readyCheck = null, receiptRecovery = null;
  const receiptWork = new KeyedWork();
  const fenceReceipts = current => intake.fence({ document: current.settings, successor: current.scheduledSettings, predecessor: {
    n: rules.decimalV2(current.last.n), root: current.predecessorRoot,
    claims: current.claimsRoot, catalog: current.catalogRoot
  } });
  const recoverReceipts = async () => {
    const current = receiptRecovery;
    if (!current) return;
    return receiptWork.run(current.settingsHash, async () => {
      const predecessorRoot = BigInt(current.last.n) ? await reads.batchRoot(current.last.n) : current.manifest.previousBatchRoot;
      await fenceReceipts({ ...current, predecessorRoot });
      await refresh();
    }, { join: true });
  };
  const context = () => {
    const state = store.get('meta', 'ruleState'), storage = new NamedStorage({ get: id => store.get('namedNodes', id), cacheSize: pin.resources.values.namedNodeCache });
    return { ruleset: 'dmw-v2', ready: ready && !accepted.receiptRenewal && !store.get('meta', 'financialRecoveryActive') && !!intake?.head && state.catalogRoot === accepted.catalogRoot && state.claimRoot === accepted.claimsRoot,
      segmented: true, settings: settings.document, settingsHistory: historySettings, batch: rules.nextUint(rules.decimalV2(accepted.last.n)),
      tip: String(intake?.head?.tip ?? 0), counted: String(intake?.head?.counted ?? 0), observation: intake?.head?.id,
      sealed: intake?.rotating || store.hasRows('observations'), state: storage.load(state.namedSnapshot), snapshot: state.namedSnapshot, acceptedRoot: accepted.catalogRoot };
  };
  // Keep the last decision while a refresh runs (signers can take seconds to answer);
  // only a failed or incapable refresh closes admission.
  const refreshOnce = async () => { try { return await refreshChecked(); } catch (error) { ready = false; throw error; } };
  const refreshChecked = async () => {
    const current = await phase('v2.notary', () => reads.rulesContext());
    check(current?.ready && current.manifestHash === pin.manifestHash && rules.hashObject(current.manifest) === pin.manifestHash &&
      current.settings.network === config.network && rules.hashObject(current.settings) === current.settingsHash, 'activation_notary_mismatch');
    if (current.receiptProtocol === 1 || pin.receiptProtocol === 1) check(current.receiptProtocol === 1 && pin.receiptProtocol === 1 &&
      pin.gateway === edPublic(secret) && rules.stableJSON(pin.receiptSigners) === rules.stableJSON(settings.receiptSigners), 'receipt_protocol_pin');
    await historySettings.refresh(current);
    const pendingFence = store.get('namedFences', current.settingsHash);
    const selected = historySettings.at(rules.nextUint(rules.decimalV2(current.last.n)),
      String(intake?.head?.counted ?? store.get('meta', 'head')?.counted ?? pin.manifest.bitcoinAnchor.height));
    const boundary = rules.hashObject(selected) !== current.settingsHash;
    receiptRecovery = null;
    // The accepted amendment authorizes the boundary, but never moves an
    // acknowledged receipt by itself. Finish an uncertain draft first, then
    // certify the complete predecessor checkpoint under the admission lock.
    if (!current.receiptRenewal && (pendingFence || boundary) && intake?.head && !store.get('meta', 'draft')) {
      // Certification has its own worker. Observation/readiness refreshes do
      // not wait for peer recovery; admission remains closed until it ends.
      if (deferRecovery) {
        if (pendingFence?.phase !== 'certified') { receiptRecovery = current; accepted = current; ready = false; return false; }
      } else await fenceReceipts({ ...current,
        predecessorRoot: BigInt(current.last.n) ? await reads.batchRoot(current.last.n) : current.manifest.previousBatchRoot });
    }
    const document = current.receiptRenewal ? historySettings.get(current.receiptRenewal.cutoff.settingsHash) : current.settings;
    settings.receiptRenewal = current.receiptRenewal ?? null;
    if (rules.hashObject(document) !== settings.settingsHash) {
      // Finish the old segment with its original policy before admitting new
      // receipts. Replay retains the old document by hash.
      if (intake?.head) await intake.seal();
      const updated = rules.batchSettings({ document, receiptSigners: settings.receiptSigners, batchVersion: 2, activation: settings.activation });
      Object.assign(settings, updated);
      if (intake) { intake.settings = settings; intake.maxEntries = Math.min(pin.resources.values.intakeEntries, document.values.receiptSegmentEntries); intake.auditLimit = document.values.auditChunkBytes; }
      if (financial) financial.document = document;
      if (mints) { mints.document = document; mints.pendingBlocks = document.values.pendingBlocks; }
    }
    if (financial) financial.document = document;
    if (links) links.document = document;
    if (mints) { mints.document = document; mints.pendingBlocks = document.values.pendingBlocks; }
    const capability = rules.runtimeCapabilities(document, pin.resources);
    const timing = closureTimeouts(document, pin.resources);
    if (timing) Object.assign(committee, { prepareMs: timing.prepareMs, timeoutMs: timing.sessionMs });
    const at = { counted: intake?.head?.counted ?? pin.manifest.bitcoinAnchor.height, tip: intake?.head?.tip ?? pin.manifest.bitcoinAnchor.height, manifestHash: pin.manifestHash, settingsHash: capability.settingsHash };
    // Each /batch-ready costs every signer Trac reads (seconds). Polling it on every 1 s observation
    // pass kept all signer queues full, so receipt acknowledgements (agent moves) waited behind it.
    // A capable answer for the same clock and policy is reused for readyMs; a new tip asks again.
    const key = rules.stableJSON(at);
    const capable = readyCheck?.key === key && Date.now() - readyCheck.at < committee.readyMs ? readyCheck.capable : await phase('v2.committee', () => committee.healthy(at));
    readyCheck = capable.length >= 3 ? (readyCheck?.key === key && readyCheck.capable === capable ? readyCheck : { key, at: Date.now(), capable }) : null;
    accepted = current; ready = capable.length >= 3; return ready;
  };
  // The observation and pipeline workers both refresh admission. Share only
  // concurrent work: serially queuing duplicate source/committee reads can
  // outlive their callers and starve authenticated signer observations.
  // A completed or failed refresh is never cached for the next request.
  let refreshing;
  const refresh = () => refreshing ??= refreshOnce().finally(() => { refreshing = null; });
  await refresh();
  intake = new SegmentedIntake({ store, network: config.network, secret, hashAt: history.hashAt, settings, rulesContext: context, resources: pin.resources });
  intake.namedAdmission = new NamedAdmission({ store, secret, context, history: { get: h => history.get(h) }, hashAt: h => history.hashAt(h), resources: pin.resources, committee });
  intake.prepareBatch = refresh;
  financial = typeof reads.financialEvidence === 'function' && typeof reads.financialRecord === 'function'
    ? new FinancialExecution({ store, reads, document: settings.document, resources: config.assetResources }) : null;
  if (financial) {
    check(config.assetRecoveryVersion === 2, 'financial_permit_recovery_required');
    financial.admissionReady = async () => {
      const current = await reads.rulesContext(), height = rules.decimalV2(await reads.counted());
      if (!ready || store.get('meta', 'financialRecoveryActive') || current.receiptRenewal || store.get('namedFences', current.settingsHash)) return false;
      return rules.hashObject(rules.effectiveSettings(current.settings, current.scheduledSettings,
        rules.nextUint(rules.decimalV2(current.last.n)), height)) === rules.hashObject(financial.document);
    };
  }
  mints = financial ? new FinancialMints({ store, network: config.network, reads, committee, financial, document: settings.document,
    bitcoinNetwork: config.mode === 'regtest' ? 'regtest' : 'mainnet', resources: config.assetResources }) : null;
  links = financial ? new FinancialLinks({ store, network: config.network, reads, financial, document: settings.document, resources: config.assetResources }) : null;
  const financialActions = financial ? new FinancialActions({ financial, reads, store }) : null;
  const custody = financial ? new FinancialCustody({ financial, reads, store, network: config.network }) : null;
  const recovery = financial ? new RecoveryCoordinator({ financial, reads, store, committee, network: config.network }) : null;
  // On reopen the persisted head may already be at the amendment boundary.
  // Resume its fence before making fresh admission available.
  await refresh();
  return { intake, settings, refresh, recoverReceipts, financial, mints, links, financialActions, custody, recovery };
}
