import { gatewayRowsRoot, iterableArrayRoot, migrationGatewayRows, pendingRows } from './migration-pages.mjs';
import { rules as r } from './rules.mjs';
import { check } from './util.mjs';
import { carryPendingReceipts } from './pending-receipts.mjs';
import { pendingInventory, requireSupportedInventory } from './pending-inventory.mjs';
import { verifyPendingArtifacts } from './pending-artifacts.mjs';

const same = (a, b) => r.stableJSON(a) === r.stableJSON(b);
const rowHash = rows => gatewayRowsRoot(rows);

// This enumerating operation runs only on an offline snapshot. The original
// rows remain in place, including receipts, quotes, financial jobs and their
// exact signed packets. No runtime request invokes the snapshot walk.
export function legacyGatewayRows(store) {
  return [...store.db.prepare('SELECT space,id,value FROM records ORDER BY space,id').iterate()]
    .map(({ space, id, value }) => [space, id, JSON.parse(value)]);
}

// Retaining records is not a financial execution adapter. Until the legacy
// fee/payment/permit paths are connected to v2, do not install a plan that
// would leave these obligations outside the runtime's work queues.
export function pendingFinancialWork(rows) {
  rows = pendingRows(rows);
  const statuses = new Map(rows.filter(([space]) => space === 'linkStatus').map(([, id, value]) => [id, value]));
  return rows.filter(([space, id, value]) =>
    /^(?:activeMints|expiredMints|issuedMints|mintInputs|mintDeferred|mintCredits|creditClaims|activeLinks|linkRecovery)$/.test(space) ||
    space === 'mints' && value.state !== 'minted' ||
    space === 'linkObligations' && value.state !== 'completed' ||
    /^(?:linkIntents|linkRequests)$/.test(space) && !['accepted', 'expired'].includes(statuses.get(id)?.state));
}

export function preparePendingWork({ store, network, document, anchor, lastTo, legacySettings = {}, gateway, history, hashAt, financialMigration, signatureReconciliation, artifactInventory = [], gatewayRows }) {
  check(document.network === network, 'pending_network');
  r.validateSettingsDocument(document);
  let original = store.get('meta', 'ruleState');
  check(original && (original.batchVersion ?? 1) === 1 && !store.get('meta', 'v2Activation'), 'pending_legacy_state');
  // A signed but unaccepted batch cannot be imported as accepted work. Its
  // exact original session must first be reconciled by the recovery path.
  check((!store.get('meta', 'draft') && !store.hasRows('supersededDrafts') || signatureReconciliation) && !store.get('meta', 'namedReservedBatch'), 'pending_signed_draft_reconciliation');
  check(!store.hasRows('outbox') || signatureReconciliation, 'pending_signed_transport_reconciliation');
  const allRows = gatewayRows ?? migrationGatewayRows(store), sourceRoot = rowHash(allRows), rows = pendingRows(allRows);
  const artifactsRoot = verifyPendingArtifacts(rows, artifactInventory);
  const inventory = pendingInventory(allRows, new Map((financialMigration?.covered ?? []).map(id => ['m/' + id, true])));
  // Preserve existing category codes while naming each unsupported item.
  // An absent-kind assumption is never a substitute for checking the rows.
  try { requireSupportedInventory(inventory); }
  catch (error) { throw Error((inventory.unsupported.craftReceipts ? 'pending_receipt_drain_required: ' : 'pending_financial_adapter_required: ') + error.message); }
  if (signatureReconciliation) check(signatureReconciliation.commitment.sourceRoot === sourceRoot &&
    signatureReconciliation.root === r.hashObject(['dmw-signature-reconciliation-v1', signatureReconciliation.commitment]), 'pending_signature_reconciliation');
  check(!pendingFinancialWork(rows).length || financialMigration?.sourceRoot === sourceRoot && financialMigration.network === network &&
    financialMigration.settingsHash === r.hashObject(document), 'pending_financial_adapter_required');
  const patterns = store.get('meta', 'patterns') ?? [];
  const receiptCarry = carryPendingReceipts({ store, rows, original, patterns, network, gateway, history, hashAt, anchor, legacySettings });
  original = receiptCarry.state;
  let named = r.importLegacyDiscoveries({ commitments: original.discoveryCommits ?? [], queued: original.discoveryQueue ?? [],
    settings: document, receiptPosition: '0', lifetime: r.legacyRules.DISCOVERY_LIMITS.lifetime, minDelay: 2 });
  // Preserve historical pattern economics verbatim. The v2 occurrence count
  // starts empty; a legacy full-history count is not a submitted witness set.
  for (const p of patterns) {
    const key = r.definitionKey({ name: p.name, pat: p.pat, fld: p.fld, dt: p.dt }, document), number = String(p.number), asset = r.legacyRules.patternAsset(p);
    check(!r.namedGet(named.records, `number/${number}`) && !r.namedGet(named.records, `pattern/${key}`) &&
      !r.namedGet(named.records, `name/${p.name}`), 'pending_catalog_collision');
    const record = { ...p, key, number, legacy: { asset, record: p }, knownMatchCount: '0', knownOccurrenceTotal: '0',
      evidenceRoot: r.namedRoot(null), catalogRevision: '0', settingsHash: r.hashObject(document), definitionSettingsHash: r.hashObject(document),
      anchor: { height: String(p.historyHeight), hash: p.historyHash }, attributionProvisional: false };
    for (const [id, value] of [[`number/${number}`, key], [`name/${p.name}`, key], [`pattern/${key}`, record], [`revision/${key}/0`, record]])
      named.records = r.namedSet(named.records, id, value);
    if (BigInt(named.nextPattern) <= BigInt(number)) named.nextPattern = r.nextUint(number);
  }
  const manifestStub = { bitcoinAnchor: anchor }, snapshot = r.initialClaimSnapshot(manifestStub, lastTo);
  const claims = new r.ClaimStorage({ get: () => null, cacheSize: document.values.proofDepth });
  let state = claims.load({ ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot) });
  state.lastTip = r.decimalV2(original.lastTip ?? Number(anchor.height) - 1);
  state.highestTip = r.decimalV2(original.highestTip ?? state.lastTip);
  const settings = r.batchSettings({ document, batchVersion: 2 });
  const put = (field, key, value) => { state[field] = r.recordSet(state[field], key, value); };
  const knownFinds = new Map(rows.filter(([space]) => space === 'finds').map(([, id, value]) => [id, value]));
  for (const [id, value] of Object.entries(r.recordObject(original.finds))) knownFinds.set(id, value);
  for (const value of knownFinds.values()) put('finds', r.findIdV2(String(value.block), String(value.pattern)), { ...value, block: String(value.block), pattern: String(value.pattern) });
  for (const old of original.rounds ?? []) {
    const window = String(old.window), originalHash = r.hashObject(old);
    const event = { ...r.claimRound(window, old.windowHash, String(old.claimableHeight ?? old.window),
      { root: r.namedStateRoot(named), nextNumber: named.nextPattern, revision: named.catalogRevision }), headerCount: String(old.headerSenders.length),
      legacy: { version: 1, commitment: originalHash, claimsPerWindow: legacySettings.claimsPerWindow ?? r.legacyRules.CLAIM_DEFAULTS.claimsPerWindow,
        tipSlots: old.slots.filter(s => s.block === old.window).map(s => r.findIdV2(String(s.block), String(s.pattern))) },
      policy: { settingsHash: r.hashObject(document), claimWindowBlocks: 2, claimsPerWindow: legacySettings.claimsPerWindow ?? r.legacyRules.CLAIM_DEFAULTS.claimsPerWindow,
        finderWindow: legacySettings.finderWindow ?? r.legacyRules.MINT_DEFAULTS.finderWindow } };
    for (const s of old.slots) put('claimSlots', `${window}/${r.findIdV2(String(s.block), String(s.pattern))}`,
      { ...s, id: r.findIdV2(String(s.block), String(s.pattern)), block: String(s.block), pattern: String(s.pattern) });
    const selections = new Map();
    const converted = old.claims.map(c => ({ ...c, window: String(c.window), block: String(c.block), patterns: c.patterns.map(String) }));
    for (const c of converted) {
      const pairs = selections.get(c.agent) ?? new Set(); for (const n of c.patterns) pairs.add(r.findIdV2(c.block, n)); selections.set(c.agent, pairs);
    }
    for (const [agent, pairs] of selections) put('claimAgents', `${window}/${agent}`, { pairs: [...pairs].sort(), exceeded: pairs.size > event.policy.claimsPerWindow });
    const pages = r.boundedPages(converted, 'claims', settings);
    for (let i = 0; i < pages.length; i++) put('claimInputs', `${window}/${i}`, pages[i]);
    event.inputPages = String(pages.length);
    old.headerSenders.forEach((sender, i) => { put('headerInputs', `${window}/${i}`, sender.agent); put('headerTickets', `${window}/${sender.agent}`, true); });
    if (old.settlement) {
      check(old.seedHash && Number.isSafeInteger(old.credited) && old.credited >= 0 && old.credited <= old.settlement.winners.length, 'pending_settlement_cursor');
      const winners = old.settlement.winners.slice(old.credited).map(w => ({ ...w, legacyId: w.id,
        id: r.findIdV2(String(w.block), String(w.pattern)), block: String(w.block), pattern: String(w.pattern) }));
      const delivery = r.boundedPages(winners, 'winners', settings);
      delivery.forEach((page, i) => put('settlementPages', `${window}/${i}`, page));
      for (const w of winners) put('claimReservations', w.id, { window, winner: w.winner });
      Object.assign(event, { closed: true, pages: String(delivery.length), total: String(winners.length), seed: old.seedHash,
        root: r.merkleRoot(delivery.map(r.encodeBinary)), inputRoot: originalHash });
    }
    state.rounds.push(event);
  }
  const saved = claims.save(state), namedSaved = new r.NamedStorage({ get: () => null, cacheSize: document.values.proofDepth }).save(named);
  let retainedCount = 0;
  function* retained() {
    for (const row of rows) if (/^(?:mints|activeMints|expiredMints|issuedMints|mintInputs|mintDeferred|mintCredits|creditClaims|linkIntents|linkRequests|linkObligations|linkRecovery|activeLinks|payoutBindings|payoutCurrent|payoutRequests|payoutAttempts|payoutTransitions|payoutHistory|bindingIntents|bindingHistory|bindings|ceremonies|outbox)(?:\/|$)/.test(row[0])) {
      retainedCount++; yield row;
    }
  }
  const retainedRoot = iterableArrayRoot(retained());
  const commitment = { version: 1, network, sourceRoot, anchor, counted: r.decimalV2(lastTo), settingsHash: r.hashObject(document),
    catalogRoot: r.namedStateRoot(named), claimSnapshot: saved.state.claimSnapshot, claimsRoot: saved.state.claimRoot,
    retainedRoot, retainedCount,
    discoveryCommits: (original.discoveryCommits ?? []).length, discoveryReveals: (original.discoveryQueue ?? []).length,
    claimWindows: (original.rounds ?? []).length, receiptsRoot: r.hashObject(receiptCarry.receipts), receipts: receiptCarry.receipts.length,
    ...(receiptCarry.receipts.length ? { gateway, legacySettingsHash: r.hashObject(legacySettings) } : {}),
    ...(financialMigration ? { financialMigrationRoot: financialMigration.root } : {}),
    ...(signatureReconciliation ? { signatureRoot: signatureReconciliation.root } : {}),
    ...(artifactInventory.length ? { artifactsRoot } : {}) };
  return { commitment, root: r.hashObject(['dmw-pending-work-v1', commitment]), named,
    writes: [...saved.writes, ...namedSaved.writes, ...receiptCarry.writes], sourceRoot,
    ...(financialMigration ? { financialMigration } : {}), ...(signatureReconciliation ? { signatureReconciliation } : {}),
    ...(artifactInventory.length ? { artifactInventory } : {}) };
}

export function verifyPendingWork({ store, pending, network, document, anchor, lastTo, legacySettings, gateway, history, hashAt, gatewayRows }) {
  const expected = preparePendingWork({ store, network, document, anchor, lastTo, legacySettings, gateway, history, hashAt,
    gatewayRows, financialMigration: pending?.financialMigration, signatureReconciliation: pending?.signatureReconciliation, artifactInventory: pending?.artifactInventory });
  check(pending?.root === expected.root && same(pending.commitment, expected.commitment), 'pending_reconciliation_mismatch');
  return expected;
}
