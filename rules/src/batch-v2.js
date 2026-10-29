import { assert, hex, integer, stableJSON, utf8 } from './core.js';
import { parseHeader } from './headers.js';
import { checkMove } from './moves.js';
import { verifyReceipt, verifyReceiptRoot, verifyRootAttestations, claimWindow } from './receipts.js';
import { receiptSegmentHash } from './receipt-segments.js';
import { recordGet, recordSet, recordChanges } from './record-index.js';
import { encodeBinary, summaryBytes } from './binary.js';
import { merkleRoot } from './merkle.js';
import { validateOp, notaryOp, batchDigest } from './operations.js';
import { batchSettings, batchActivation } from './batch-settings.js';
import { aggregateCredits } from './batch.js';
import { claimRound, enterClaims, freezeClaimWindow, CreditBudget, takeSettlementPage, queueHeaderFind, namedPattern } from './claims-paged.js';
import { hashObject } from './core.js';
import { decimalV2, compareUint, nextUint, ordinalCodec } from './integers-v2.js';
import { NamedStorage } from './named-storage.js';
import { emptyNamedDiscovery } from './named-discovery.js';
import { replayNamedEntries, namedStateRoot } from './named-execution.js';
import { namedGet } from './named-index.js';
import { recordClaimOccurrences } from './claim-occurrences.js';
import { validateSettingsDocument, settingsEffective } from './settings-v2.js';
import { verifyCreditOperations, accountOperationsRoot } from './account-batch.js';
import { ClaimStorage, claimEvidenceReader, CLAIM_MAPS } from './claim-state.js';
import { decodeNodeHints } from './node-evidence.js';
import { financialBatchOperations } from './financial-execution.js';
import { freezeLegacyClaimWindow } from './legacy-claims.js';
import { verifyRenewalSegments, validateRenewalSlice } from './receipt-renewal.js';
import { advanceClaimWindow, ClosureBudget } from './claim-closure.js';
import { claimsNeverCloseActive } from './public-mint.js';
import { publicMintEvidenceReader, applyPublicClaimScan } from './public-claims.js';

export function processBlockV2(input, readers = {}) {
  const settings = batchSettings(input.settings);
  let deliveryRows = input.deliveryRows ?? settings.settlementPageRows * settings.settlementPagesPerObservation;
  assert(Number.isSafeInteger(deliveryRows) && (deliveryRows > 0 || deliveryRows === 0 && input.entries.some(e => ['craft-v2', 'transfer-v2'].includes(e.move.t))) && deliveryRows <= settings.settlementPageRows * settings.settlementPagesPerObservation, 'settlement_delivery_budget');
  for (;;) {
    try { return processBlockV2Attempt(input, deliveryRows, readers); }
    catch (error) {
      if (error.message !== 'audit_budget' || deliveryRows === 0 || deliveryRows === 1 && !input.entries.some(e => ['craft-v2', 'transfer-v2'].includes(e.move.t))) throw error;
      deliveryRows = deliveryRows === 1 ? 0 : Math.max(1, Math.floor(deliveryRows / 2));
    }
  }
}
function processBlockV2Attempt(input, deliveryRows, readers) {
  const { blockHash, tipHash, network, gateway, history, hashAt, entries, receiptRoot, rootAttestations = [] } = input;
  let state = input.state;
  const height = input.settings?.document ? decimalV2(input.height) : input.height, tip = input.settings?.document ? decimalV2(input.tip) : input.tip;
  const clock = ordinalCodec(!!input.settings?.document);
  let patterns = input.patterns;
  const s = batchSettings(input.settings), ruleset = s.ruleset, settingsRevision = s.settingsRevision;
  const publicClaims = claimsNeverCloseActive(s, input.executionHeight ?? height) &&
    publicMintEvidenceReader(input.publicMintEvidence, readers.publicMintGet, s.document.values.proofBytes);
  const claims = s.document && new ClaimStorage({ get: claimEvidenceReader(input.claimEvidence ?? { nodes: [] }, s.document, readers.claimNodeGet), cacheSize: s.document.values.proofDepth });
  if (claims) state = claims.load(state, { decimal: true });
  assert(typeof ruleset === 'string' && (s.document ? settingsRevision === s.document.revision : hex(settingsRevision, 32)), 'batch_rules_revision');
  const receiptDocument = s.document && [s.document, ...(input.settingsDocuments ?? [])].find(d => hashObject(d) === receiptRoot?.settingsHash);
  if (s.document) assert(receiptDocument && input.batchSequence && receiptDocument.network === network &&
    settingsEffective(receiptDocument, decimalV2(input.batchSequence), decimalV2(tip)), 'batch_settings');
  if (receiptDocument) assert(entries.length <= receiptDocument.values.receiptSegmentEntries, 'receipt_segment_capacity');
  assert(clock.valid(height) && clock.valid(tip) && hashAt(height) === blockHash && hashAt(tip) === tipHash && clock.compare(height, state.counted ?? 0) >= 0, 'block_clock');
  assert(clock.compare(tip, clock.add(state.lastTip ?? clock.add(tip, -1))) <= 0, 'tip_gap');
  const inWindow = (window, at) => clock.compare(at, window) >= 0 && clock.compare(at, clock.add(window, s.claimWindowBlocks)) < 0;
  assert(receiptRoot?.v === 2 && receiptRoot.ruleset === ruleset && receiptRoot.settingsRevision === (receiptDocument?.revision ?? settingsRevision), 'receipt_segment_version');
  assert(verifyReceiptRoot(receiptRoot, entries.map(e => e.receipt), { network, gateway, tip, hash: tipHash }), 'receipt_root');
  assert(verifyRootAttestations(receiptRoot, rootAttestations, s.receiptSigners), 'receipt_attestations');
  const key = `${tip}/${tipHash}`, prior = recordGet(state.receiptSegments, key);
  assert(decimalV2(receiptRoot.segment) === (prior ? nextUint(decimalV2(prior.segment)) : '0') && receiptRoot.previous === (prior?.hash ?? null), 'receipt_segment_predecessor');
  const next = { ...state, batchVersion: 2, counted: height, lastTip: clock.max(state.lastTip ?? clock.add(tip, -1), tip), highestTip: clock.max(state.highestTip ?? tip, tip), observation: clock.add(state.observation ?? 0),
    rounds: (state.rounds ?? []).map(r => ({ ...r })) };
  if (publicClaims) next.publicMintGet = publicClaims.get;
  assert(clock.compare(clock.add(tip, s.claimWindowBlocks), state.highestTip ?? tip) > 0, 'receipt_window_closed');
  next.receiptSegments = recordSet(next.receiptSegments, key, { segment: receiptRoot.segment, hash: receiptSegmentHash(receiptRoot), last: receiptRoot.last ?? prior?.last ?? null });
  const outcomes = [], occurrences = [], settlements = [], closures = [], closureProgress = [], discoveries = [], crafts = [], transfers = [], refinements = [], budget = new CreditBudget(s, input.priorOperations);
  const closureSettings = s.closureWorkBudget && { ...s, ...Object.fromEntries(['closureWorkBudget', 'closureReadBudget', 'closureByteBudget']
    .map(k => [k, Math.floor(s[k] / s.observationsPerBatch)])) };
  const closureBudget = closureSettings && new ClosureBudget(closureSettings, claims?.storage);
  const nodes = new Map(input.namedEvidence?.nodes ?? []), persistence = s.document ? new NamedStorage({ get: (id, ancestors) => {
    try { return nodes.get(id) ?? readers.namedNodeGet?.(id, ancestors); }
    catch { throw Error('named_storage_read'); }
  }, cacheSize: s.document.values.proofDepth }) : null;
  if (s.document) assert(nodes.size === (input.namedEvidence?.nodes ?? []).length, 'named_storage_duplicate');
  if (s.document) {
    const hints = input.namedEvidence?.hints, rows = input.namedEvidence?.nodes ?? [];
    assert(utf8(stableJSON(hints === undefined ? rows : { nodes: rows, hints })).length <= s.document.values.proofBytes, 'named_proof_budget');
    decodeNodeHints(hints, 'named_proof_hints');
  }
  let named = s.document ? (state.namedSnapshot ? persistence.load(state.namedSnapshot) : emptyNamedDiscovery()) : null;
  const craftCatalog = named;
  if (s.document) {
    assert(namedStateRoot(named) === state.catalogRoot, 'named_predecessor');
    patterns = { get(number) { const key = namedGet(named.records, `number/${number}`), record = key && namedGet(named.records, `pattern/${key}`); return record && record; } };
  }
  if (clock.compare(tip, state.lastTip ?? clock.add(tip, -1)) > 0) next.rounds.push({ ...claimRound(tip, tipHash, clock.min(height, tip), {
    root: state.catalogRoot ?? merkleRoot([]), nextNumber: named?.nextPattern ?? state.nextPatternNumber ?? (Array.isArray(patterns) ? patterns.length : 0),
    revision: named?.catalogRevision ?? state.catalogRevision ?? 0,
  }), ...(receiptDocument ? { policy: { settingsHash: hashObject(receiptDocument), claimsPerWindow: receiptDocument.values.claimsPerWindow,
    claimWindowBlocks: receiptDocument.values.claimWindowTips, finderWindow: receiptDocument.values.finderWindow } } : {}) });
  const settingsHistory = { get(hash) {
    const d = [s.document, ...(input.settingsDocuments ?? [])].find(d => hashObject(d) === hash);
    assert(d && d.network === network, 'settings_unknown'); return validateSettingsDocument(d);
  } };
  for (const event of next.rounds) if (!event.closed && inWindow(event.window, tip)) event.receiptChains = { ...event.receiptChains, [key]: receiptSegmentHash(receiptRoot) };
  const header = (event, value, agent, target = next) => {
    assert(event && !event.closed && inWindow(event.window, tip), 'header_window');
    assert(value.height === event.window && parseHeader(value.raw).hash === history.get(value.height).hash, 'header_mismatch');
    const ticket = `${event.window}/${agent}`;
    if (!recordGet(target.headerTickets, ticket)) {
      target.headerTickets = recordSet(target.headerTickets, ticket, true);
      const position = event.headerCount ?? clock.zero; event.headerCount = clock.add(position);
      target.headerInputs = recordSet(target.headerInputs, `${event.window}/${position}`, agent);
      if (s.closureWorkBudget) {
        event.closurePairs = String(BigInt(event.closurePairs ?? 0) + 1n);
        event.closureBytes = String(BigInt(event.closureBytes ?? 0) + BigInt(agent.length));
      }
    }
  };
  // Older windows are already closed to this receipt segment. Freeze them
  // before new claims so a just-determined header award cannot be missed.
  for (const event of next.rounds) {
    if (event.closed || clock.compare(tip, clock.add(event.window, event.policy?.claimWindowBlocks ?? s.claimWindowBlocks)) < 0 || clock.compare(height, clock.add(event.window, event.policy?.claimWindowBlocks ?? s.claimWindowBlocks)) < 0) continue;
    const seed = hashAt(clock.add(event.window, event.policy?.claimWindowBlocks ?? s.claimWindowBlocks));
    const voided = !event.closing && (hashAt(event.window) !== event.windowHash || !seed);
    if ((!closureBudget || event.legacy) && voided) {
      event.void = true;
      const inputRoot = merkleRoot(Object.entries(event.receiptChains ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(stableJSON));
      let claims = clock.zero; for (let page = clock.zero; clock.compare(page, event.inputPages) < 0; page = clock.add(page)) claims = clock.add(claims, recordGet(next.claimInputs, `${event.window}/${page}`)?.claims.length ?? 0);
      closures.push({ window: event.window, root: merkleRoot([]), inputRoot, pages: clock.zero, claims, winners: clock.zero, void: true, reason: 'chain_mismatch', draw: { window: event.window, void: true, reason: 'chain_mismatch' } });
      continue;
    }
    if (event.legacy) closures.push(freezeLegacyClaimWindow({ state: next, event, decidingHash: seed, counted: height, settings: s }));
    else if (closureBudget) {
      const chunk = advanceClaimWindow({ state: next, event, decidingHash: event.closing?.seed ?? seed, counted: height, settings: closureSettings, budget: closureBudget, voided });
      closureProgress.push(chunk.progress); if (chunk.completed) closures.push(chunk.completed);
      // Older reservations and header draws must be final before evaluating
      // the eligibility of a later window. The next observation resumes here.
      if (!event.closed || closureBudget.work >= closureSettings.closureWorkBudget) break;
    } else closures.push(freezeClaimWindow({ state: next, event, decidingHash: seed, counted: height, settings: s }));
  }
  let sequence = state.lastSequence ?? -1, namedSequence = decimalV2(state.namedSequence ?? '0');
  if (s.document) assert(entries.reduce((n, e) => n + (e.move.p.matches?.length ?? 0), 0) <= receiptDocument.values.namedPairBudget &&
    entries.filter(e => e.move.t === 'discovery-reveal-v2').length <= receiptDocument.values.revealBudget, 'named_work_budget');
  if (s.document) assert(entries.reduce((n, e) => n + (e.move.t === 'compound-refine-v2' ? e.move.p.steps : 0), 0) <= receiptDocument.values.compoundWorkBudget, 'compound_work_budget');
  for (const entry of [...entries].sort((a, b) => compareUint(decimalV2(a.receipt.sequence), decimalV2(b.receipt.sequence)))) {
    const { receipt } = entry; let move = entry.move; const originalMove = move; let verified = false;
    if (move.v === 2) {
      assert(s.document, 'batch_settings');
      const replayed = replayNamedEntries(named, { entries: [{ move, receipt }], settings: receiptDocument, settingsHistory,
        batch: decimalV2(input.batchSequence), gateway, history, hashAt, counted: decimalV2(height), executionHeight: decimalV2(input.executionHeight ?? height), lastSequence: namedSequence, craftCatalog, renewal: input.renewal,
        claimSettings: s.document });
      named = replayed.state; namedSequence = replayed.lastSequence; next.namedSequence = namedSequence;
      const result = replayed.outcomes[0];
      if (result.transfers) transfers.push(...result.transfers.map(t => ({ ...t, move: receipt.move })));
      if (result.craft) crafts.push({ ...result.craft, move: receipt.move, agent: move.a });
      if (result.progress) refinements.push({ asset: move.p.asset, progress: result.progress, move: receipt.move });
      if (!['header-v2', 'claim-v2'].includes(move.t) || result.reason !== 'accepted') outcomes.push({ move, reason: result.reason });
      if (result.record) {
        discoveries.push({ record: result.record, move: receipt.move });
        for (const match of move.p.matches ?? []) occurrences.push({ block: match.height, pattern: result.record.number,
          asset: `p2:${result.record.number}`, count: match.count, hash: match.hash, agent: move.a });
      }
      if (!['header-v2', 'claim-v2'].includes(move.t) || result.reason !== 'accepted') continue;
      verified = true;
      move = { ...move, t: move.t === 'header-v2' ? 'header' : 'claim' };
    }
    assert(verified || !s.document, 'upgrade_required');
    if (!verified) { assert(receipt.sequence > sequence && verifyReceipt(receipt, move, { network, gateway, hashAt }), 'receipt_invalid'); sequence = receipt.sequence; }
    let reason = verified ? null : checkMove(move, { network, tip, hashAt, puzzleBits: s.puzzleBits ?? 12, freshness: s.freshness ?? 2 });
    if (!reason) try {
      if (move.t === 'claim') {
        const event = next.rounds.find(r => r.window === move.p.window);
        assert(event && !event.closed && inWindow(event.window, tip), 'claim_window');
        const working = { ...next }, copy = { ...event };
        if (move.p.header) header(copy, move.p.header, move.a, working);
        const accepted = enterClaims({ state: working, event: copy, agent: move.a, plots: move.p.plots, patterns, history,
          settings: publicClaims ? s : receiptDocument ? { ...s, document: receiptDocument } : s, height: tip });
        for (const slot of accepted.slots) {
          const oldDraw = recordGet(working.headerAwards, slot.block);
          assert(!oldDraw || oldDraw.windowHash === history.get(slot.block).hash, 'header_draw_reorg');
        }
        Object.assign(next, working); Object.assign(event, copy);
        if (s.document) {
          const updated = recordClaimOccurrences(named, { slots: accepted.slots, agent: move.a, height, history, hashAt, settings: s.document });
          named = updated.state; discoveries.push(...updated.records.map(record => ({ record, move: receipt.move })));
        }
        for (const slot of accepted.slots) {
          occurrences.push({ ...slot, hash: history.get(slot.block).hash, agent: move.a });
          queueHeaderFind({ state: next, slot, pattern: namedPattern(patterns, slot.pattern), height, settings: s });
        }
      } else if (move.t === 'header') header(next.rounds.find(r => r.window === move.p.height), move.p, move.a);
      // The independently owned discovery/craft/mint engines join this dispatch
      // during integration. Unsupported transitions always fail closed.
      else assert(false, 'rules_transition_unavailable');
    } catch (error) {
      // Proof unavailability/corruption must not turn an otherwise valid
      // acknowledged move into a replayable rejection.
      if (/^(named_storage_|claim_state_|claim_proof_|claim_node_|public_mint_evidence)/.test(error.message)) throw error;
      reason = error.message;
    }
    outcomes.push({ move: originalMove, reason: reason ?? 'accepted' });
  }
  next.lastSequence = s.document ? namedSequence : sequence;
  const savedNamed = named && persistence.save(named);
  if (savedNamed) { next.namedSnapshot = savedNamed.snapshot; next.catalogRoot = namedStateRoot(named); next.catalogRevision = named.catalogRevision; next.nextPatternNumber = named.nextPattern; }
  let examined = 0, pages = 0, cursor = clock.value(state.settlementRoundCursor ?? 0);
  while (next.rounds.length && examined < next.rounds.length && pages < s.settlementPagesPerObservation && deliveryRows > 0) {
    const event = next.rounds[Number(BigInt(cursor) % BigInt(next.rounds.length))]; cursor = clock.add(cursor); examined++;
    if (!event.closed || event.void) continue;
    const page = takeSettlementPage({ state: next, event, height, budget, maxRows: Math.min(s.settlementPageRows, deliveryRows) });
    if (page) { settlements.push({ ...page, window: event.originalWindow ?? page.window }); deliveryRows -= page.to - page.from; pages++; examined = 0; }
  }
  next.settlementRoundCursor = cursor;
  next.rounds = next.rounds.filter(r => !r.void && (!r.closed || clock.compare(r.cursor, r.pages) < 0));
  delete next.publicMintGet;
  const file = { v: 5, ruleset, settingsRevision, observation: next.observation, previousHeight: clock.value(state.counted ?? clock.add(height, -1)), height, hash: blockHash, tip, previousTip: clock.value(state.lastTip ?? clock.add(tip, -1)), tipHash, confirmed: clock.min(height, tip),
    receipts: entries.map(e => e.receipt), receiptRoot, rootAttestations, receiptReference: null, moves: outcomes, settlements, closures, occurrences,
    ...(closureProgress.length ? { closureProgress } : {}),
    ...(publicClaims ? { publicMintEvidence: publicClaims.rows() } : {}),
    discovery: { work: [], queued: 0, rejected: [] }, discoveries, crafts, ...(transfers.length ? { transfers } : {}), ...(refinements.length ? { refinements } : {}), commissions: [], mintOperations: [], mintOutcomes: [], linkOperations: [], linkOutcomes: [], ops: budget.operations(),
    ...(s.document ? { settingsHash: s.settingsHash, batchSequence: decimalV2(input.batchSequence), catalogRoot: next.catalogRoot } : {}),
    ...(input.renewal ? { renewal: input.renewal.id, renewalCursor: input.renewal.cursor } : {}) };
  const savedClaims = claims?.save(next);
  if (savedClaims) { file.claimPrevious = state.claimRoot; file.claimRoot = savedClaims.state.claimRoot; }
  return finalizeBlockV2Accounts({ state: savedClaims?.state ?? next, patterns: input.patterns, file,
    ...(savedClaims ? { claimWrites: savedClaims.writes } : {}), ...(savedNamed ? { namedWrites: savedNamed.writes } : {}) }, input, readers);
}

// Financial planning can attach scans after the free transition. Reopen only
// the touched authenticated paths and extend the same claim checkpoint. This
// is also used by full signer replay, which independently checks every decision.
export function publicClaimProjection(output, input, readers = {}) {
  const s = batchSettings(input.settings), height = input.executionHeight ?? input.height;
  assert(claimsNeverCloseActive(s, height), 'claims_never_close_inactive');
  const nodes = new Map((output.claimWrites ?? []).map(row => [row.id, row.value]));
  const storage = new ClaimStorage({ get: claimEvidenceReader(input.claimEvidence ?? { nodes: [] }, s.document,
    (id, ancestors) => nodes.get(id) ?? readers.claimNodeGet?.(id, ancestors)), cacheSize: s.document.values.proofDepth });
  const state = storage.load(output.state, { decimal: true });
  const namedNodes = new Map([...(input.namedEvidence?.nodes ?? []), ...(output.namedWrites ?? []).map(row => [row.id, row.value])]);
  const namedStorage = new NamedStorage({ get: (id, ancestors) => namedNodes.get(id) ?? readers.namedNodeGet?.(id, ancestors), cacheSize: s.document.values.proofDepth });
  const named = namedStorage.load(state.namedSnapshot);
  const patterns = { get(number) { const key = namedGet(named.records, `number/${number}`); return key && namedGet(named.records, `pattern/${key}`); } };
  const evidence = publicMintEvidenceReader(input.publicMintEvidence, readers.publicMintGet, s.document.values.proofBytes);
  state.publicMintGet = evidence.get;
  return { state, patterns, evidence, storage, settings: s, height };
}
export function finalizePublicClaims(output, input, readers = {}) {
  const s = batchSettings(input.settings), height = input.executionHeight ?? input.height;
  if (!claimsNeverCloseActive(s, height)) return output;
  const operations = (input.financialOperations ?? []).flatMap(i => i.operations).filter(op => op.op === 'fp' && op.type === 'public-scan');
  if (!operations.length) return output;
  const { state, patterns, evidence, storage } = publicClaimProjection(output, input, readers);
  // Receipt moves, completed reservations and header draws precede these
  // scans. Scan order is the containing financial-operation order.
  for (const operation of operations) applyPublicClaimScan({ state, patterns, operation, settings: s, height });
  delete state.publicMintGet;
  const saved = storage.save(state), writes = new Map([...(output.claimWrites ?? []), ...saved.writes].map(row => [row.id, row]));
  // Preserve this observation's earlier projection deltas as well as the new
  // public reservation; the checkpoint itself already contains both.
  for (const field of CLAIM_MAPS) saved.state[field] = Object.entries(recordChanges(saved.state[field]))
    .reduce((index, [key, value]) => recordSet(index, key, value), output.state[field]);
  const used = new Map([...(output.file.publicMintEvidence ?? []), ...evidence.rows()].map(row => [`${row.asset}/${row.block}`, row]));
  return { ...output, state: saved.state, claimWrites: [...writes.values()], file: { ...output.file, claimRoot: saved.state.claimRoot,
    publicMintEvidence: [...used].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row) } };
}

// Account attachment preserves the free transition; active public scans then
// reserve their slots in its claim tree. Signers execute both stages themselves.
export function finalizeBlockV2Accounts(output, input, readers = {}) {
  output = finalizePublicClaims(output, input, readers);
  const s = batchSettings(input.settings), clock = ordinalCodec(!!s.document);
  const next = { ...output.state }, file = { ...output.file }, { crafts } = file;
  const { height, tip, entries, state } = input;
  if (s.document && input.accountOperations) {
    file.ops = verifyCreditOperations(file.ops, input.accountOperations, crafts, file.transfers);
    if (input.financialOperations?.length) {
      assert(clock.compare(height, input.executionHeight) === 0, 'financial_execution_height');
      file.financialOperations = input.financialOperations;
      file.ops = [...file.ops, ...financialBatchOperations(input.financialOperations, s.document)];
    }
    next.accountRoot = accountOperationsRoot([...(input.priorOperations ?? []), ...file.ops]);
  }
  assert(!input.financialOperations?.length || s.document && input.accountOperations, 'financial_account_required');
  // A witnessed empty segment may have been sealed while financial sources
  // were ready and become unexecutable before replay. Commit its authenticated
  // receipt-chain advancement so later segments are not stranded behind it.
  if (input.receiptContinuation === true || input.renewal && !entries.length && !file.ops.length && !file.settlements.length && !file.closures.length && !file.closureProgress?.length) {
    assert(s.document && !entries.length && !file.ops.length && !file.settlements.length && !file.closures.length && !file.closureProgress?.length, 'receipt_continuation');
    file.receiptContinuation = true;
  }
  assert(!input.mintOperations?.length && !input.linkOperations?.length, 'rules_transition_unavailable');
  // Planning may calculate claim credits before adding financial proofs.
  // Final batches must change game state or advance a witnessed receipt chain.
  assert(input.financialPlanning === true || file.receiptContinuation || entries.length || file.settlements.length || file.closures.length || file.closureProgress?.length || file.financialOperations?.length || clock.compare(height, state.counted ?? -1) > 0 || clock.compare(tip, state.lastTip ?? -1) > 0, 'batch_no_progress');
  const auditBytes = encodeBinary(file), viewerBytes = summaryBytes(file);
  assert(auditBytes.length <= s.auditMaxBytes && viewerBytes.length <= s.summaryMaxBytes, 'audit_budget');
  return { ...output, state: next, file, operations: file.ops, auditBytes, viewerBytes };
}

export function buildBatchV2(input) {
  const { network, previousRoot, files, activation, headers = [] } = input;
  const s = batchSettings(input.settings ?? input), clock = ordinalCodec(!!s.document);
  const epoch = clock.value(input.epoch), sequence = clock.value(input.sequence), lastTo = clock.value(input.lastTo), executionHeight = clock.value(input.executionHeight);
  assert(Array.isArray(files) && files.length > 0 && files.length <= s.maxObservations && files.every(f => f?.v === 5), 'batch_files');
  if (input.renewal) {
    assert(s.settingsHash === input.renewal.cutoff.settingsHash && previousRoot === input.renewal.predecessor.root &&
      files.every(f => f.renewal === input.renewal.id && !f.financialOperations?.length) &&
      files[0].claimPrevious === input.renewal.predecessor.claims, 'renewal_binding');
    validateRenewalSlice(input.renewal, input.renewalSlice, s.document);
    verifyRenewalSegments(input.renewal, files.map(f => ({ seal: f.receiptRoot, receipts: f.receipts })), sequence, input.renewalSlice);
  } else assert(files.every(f => !f.renewal), 'renewal_binding');
  const deadline = clock.value(input.deadline ?? clock.add(executionHeight, s.batchDeadlineBlocks));
  assert(clock.valid(epoch) && clock.valid(sequence) && clock.compare(sequence, 0) > 0 && hex(previousRoot, 32) && clock.valid(lastTo), 'batch_input');
  // Renewals may carry several certified segments with no closure work.
  // Bound their actual combined closure cost, including every window chunk,
  // rather than treating each empty receipt continuation as a full budget.
  if (s.closureWorkBudget) for (const [metric, limit] of [['work', 'closureWorkBudget'], ['reads', 'closureReadBudget'], ['bytes', 'closureByteBudget']]) {
    let total = 0n;
    for (const file of files) for (const progress of file.closureProgress ?? []) {
      assert(Number.isSafeInteger(progress[metric]) && progress[metric] >= 0, 'batch_closure_budget');
      total += BigInt(progress[metric]);
    }
    assert(total <= BigInt(s[limit]), 'batch_closure_budget');
  }
  const pin = batchActivation({ sequence, previousRoot, height: executionHeight, hash: input.executionHash, activation, document: s.document });
  assert(files.every((f, i) => f.ruleset === pin.ruleset && f.settingsRevision === pin.settingsRevision && (!s.document || f.settingsHash === pin.settingsHash && f.batchSequence === String(sequence)) && clock.compare(f.previousHeight, i ? files[i - 1].height : lastTo) === 0 && clock.compare(f.height, f.previousHeight) >= 0 && (!i || clock.compare(f.observation, clock.add(files[i - 1].observation)) === 0)), 'batch_continuity');
  if (s.document) assert(files.every((f, i) => hex(f.claimRoot, 32) && hex(f.claimPrevious, 32) && (!i || f.claimPrevious === files[i - 1].claimRoot)), 'batch_claim_continuity');
  assert(clock.valid(deadline) && clock.compare(deadline, executionHeight) >= 0 && clock.compare(deadline, clock.add(executionHeight, s.batchDeadlineMaxBlocks)) <= 0 && clock.compare(files.at(-1).height, executionHeight) <= 0, 'batch_deadline');
  assert(files.some(f => f.receiptContinuation || f.closureProgress?.length || f.financialOperations?.length || f.moves.length || f.settlements.length || f.closures.length || clock.compare(f.height, f.previousHeight) > 0 || clock.compare(f.tip, f.previousTip) > 0), 'batch_no_progress');
  const fileBytes = files.map(encodeBinary);
  assert(fileBytes.every(b => b.length <= s.auditMaxBytes) && fileBytes.reduce((n, b) => n + b.length, 0) <= s.auditMaxBytes, 'batch_audit_budget');
  const finds = merkleRoot(files.map(f => encodeBinary({ settlements: f.settlements, closures: f.closures }))), receipts = merkleRoot(files.map(f => encodeBinary(f.receiptRoot)));
  const financial = files.flatMap(f => f.ops);
  if (s.document) assert(financial.every(o => ['ar', 'fp', 'kv'].includes(o.op)), 'account_v2_required');
  if (s.document) assert(input.accountRoot === accountOperationsRoot(financial), 'batch_account_commitment');
  if (s.document) assert(files.reduce((n, f) => n + (f.financialOperations?.length ?? 0), 0) <= s.document.values.mintOperationBudget, 'financial_batch_budget');
  const ops = [...(s.document ? financial : aggregateCredits(financial)), notaryOp(s.document ? 'finds/current' : `finds/batch/${sequence.toString(36)}`, finds), notaryOp(s.document ? 'receipt/current' : `receipt/batch/${sequence.toString(36)}`, receipts)];
  ops.filter(o => !s.document || !['ar', 'fp'].includes(o.op)).forEach(validateOp);
  assert(ops.length <= s.maxOps && ops.filter(o => o.op === 'kv').length <= s.maxKv && ops.reduce((n, o) => n + (o.assets?.length ?? 0), 0) <= s.maxAssets, 'batch_record_budget');
  assert(headers.length <= s.maxHeaders && headers.every(h => hex(h, 80)), 'batch_headers');
  const batch = { v: 2, epoch, n: sequence, from: lastTo, to: files.at(-1).height, deadline, previous: previousRoot,
    ...pin, execution: { height: executionHeight, hash: input.executionHash }, observation: files.at(-1).observation,
    root: merkleRoot(fileBytes), receipts, finds, catalog: input.catalogRoot ?? merkleRoot([]), accounts: input.accountRoot ?? merkleRoot([]),
    ...(s.document ? { previousClaims: files[0].claimPrevious, claims: files.at(-1).claimRoot } : {}), ops, ...(headers.length ? { hx: headers } : {}),
    ...(input.renewal ? { renewal: { kind: 'execute', id: input.renewal.id, slice: input.renewalSlice } } : {}) };
  assert(hex(batch.execution.hash, 32) && utf8(stableJSON({ ...batch, sig: '0'.repeat(128) })).length <= s.maxBatchBytes, 'batch_bytes');
  return { batch, fileBytes, signingBytes: utf8(`dmw-batch-v2|${network}|${stableJSON(batch)}`), signingDigest: batchDigest(network, batch) };
}
