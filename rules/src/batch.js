import { paymentProgress } from './mint-payments.js';
import { assert, integer, hex, utf8, stableJSON, networkId, findId, compare } from './core.js';
import { validateOp, creditOp, aggregateCreditOp, signedOp, discoveryOps, notaryOp, bitmapLinkOp, batchDigest, verifyRequest, pendingId } from './operations.js';
import { checkMove } from './moves.js';
import { parseHeader } from './headers.js';
import { slotsFor, settleClaims, patternAsset } from './claims.js';
import { queueDiscovery, advanceDiscovery } from './discovery.js';
import { recordGet, recordSet } from './record-index.js';
import { compound, patternProperties } from './compounds.js';
import { merkleRoot } from './merkle.js';
import { encodeBinary, summaryBytes } from './binary.js';
import { verifyReceipt, verifyReceiptRoot, verifyRootAttestations, claimWindow } from './receipts.js';
import { applyMintInput, MINT_BATCH_DEFAULTS } from './mint-batch.js';
import { verifyLinkInput } from './link-payments.js';
import { processBlockV2, buildBatchV2 } from './batch-v2.js';
export const MAX_BATCH_HORIZON = 36;
export function batchDeadline(executionHeight, horizon = 6) {
  assert(integer(executionHeight) && integer(horizon, MAX_BATCH_HORIZON) && integer(executionHeight + horizon), 'batch_deadline');
  return executionHeight + horizon;
}
// Merge consecutive credits by owner/asset, preserving all debit and reservation
// barriers. The notary never receives one operation or one record per find.
export function aggregateCredits(operations) {
  const result = [], pending = new Map();
  const flush = () => {
    for (const [to, balances] of [...pending].sort(([a], [b]) => compare(a, b))) {
      const assets = [...balances].sort(([a], [b]) => compare(a, b)).map(([asset, n]) => [asset, n.toString()]);
      for (let i = 0; i < assets.length; i += 16) result.push(aggregateCreditOp(to, assets.slice(i, i + 16)));
    }
    pending.clear();
  };
  for (const op of operations) {
    if (!['mk', 'ac'].includes(op.op)) { flush(); result.push(op); continue; }
    const balances = pending.get(op.to) ?? new Map();
    for (const [asset, amount] of op.op === 'mk' ? [[op.asset, op.amount]] : op.assets)
      balances.set(asset, (balances.get(asset) ?? 0n) + BigInt(amount));
    pending.set(op.to, balances);
  }
  flush(); return result;
}
export const budgetOperations = files => aggregateCredits(files.flatMap(f => f.ops).filter(op => op.op !== 'kv' || !op.key.startsWith('receipt/')));
export const findsCommitment = files => merkleRoot(files.map(f => encodeBinary({ observation: f.observation, height: f.height, settlements: f.settlements })));
export function batchOperations(files, sequence) {
  assert(Array.isArray(files) && files.length > 0 && files.every(f => f?.v === 4), 'batch_file_version');
  return [...budgetOperations(files),
    notaryOp(`finds/batch/${sequence.toString(36)}`, findsCommitment(files)),
    notaryOp(`receipt/batch/${sequence.toString(36)}`, merkleRoot(files.map(f => encodeBinary({ observation: f.observation, tip: f.tip, hash: f.tipHash, seal: f.receiptRoot }))))];
}
export function buildBatch(input) {
  if (input.files?.[0]?.v === 5) return buildBatchV2(input);
  return buildLegacyBatch(input);
}
export function buildLegacyBatch({ network, epoch, sequence, lastTo, files, executionHeight, deadline = batchDeadline(executionHeight), operations, headers = [], maxBytes = 98304, maxOps = 512, maxAssets = 4096, maxKv = 16,
  maxMintOps = MINT_BATCH_DEFAULTS.maxMintOps, maxObservations = 512, maxAuditBytes = 1500000 }) {
  networkId(network);
  assert(integer(epoch), 'batch_epoch');
  assert(integer(executionHeight) && integer(deadline) && deadline >= executionHeight && deadline - executionHeight <= MAX_BATCH_HORIZON, 'batch_deadline');
  assert(integer(sequence) && sequence > 0 && integer(lastTo) && Array.isArray(files) && files.length > 0, 'batch_input');
  assert(integer(maxObservations, 512) && maxObservations > 0 && files.length <= maxObservations, 'batch_observations');
  assert(files.every(f => f?.v === 4), 'batch_file_version');
  assert(files.every((f, i) => integer(f.height) && integer(f.observation) && f.observation > 0 &&
    f.previousHeight === (i ? files[i - 1].height : lastTo) && f.height >= f.previousHeight &&
    (!i || f.observation === files[i - 1].observation + 1)), 'batch_continuity');
  assert(files.at(-1).height > lastTo, 'batch_no_progress');
  // Requests execute at the contract's current clock, not their historical
  // observation height. Recovery puts all mint actions in its final file.
  assert(files.slice(0, -1).every(f => !f.mintOperations.length), 'mint_execution_height');
  const expected = batchOperations(files, sequence); operations ??= expected;
  assert(operations.length <= maxOps, 'batch_ops'); operations.forEach(validateOp);
  assert(stableJSON(operations) === stableJSON(expected), 'batch_file_ops');
  assert(integer(maxMintOps, 32) && operations.filter(op => ['rq', 'mp', 'mc', 'rx'].includes(op.op)).length <= maxMintOps, 'batch_mint_ops');
  for (const op of operations) if (op.op === 'xc' || op.op === 'rq') assert(verifyRequest(op.op, network, op.request, op.sig, files.at(-1).height), 'batch_request_expired');
  let items = 0, kv = 0;
  for (const op of operations) {
    if (op.op === 'ac') items += op.assets.length;
    else if (op.op === 'mk') items++;
    else if (op.op === 'xc') items += op.request.in.length + op.request.out.length;
    else if (op.op === 'rq') items++;
    else if (op.op === 'kv') kv++;
  }
  assert(items <= maxAssets && kv <= maxKv, 'batch_record_budget');
  assert(Array.isArray(headers) && headers.length <= 20 && headers.every(h => hex(h, 80)), 'batch_headers');
  const fileBytes = files.map(encodeBinary);
  assert(fileBytes.every(b => b.length <= 1500000) && integer(maxAuditBytes, 1800000) && fileBytes.reduce((n, b) => n + b.length, 0) <= maxAuditBytes, 'batch_audit_budget');
  const batch = { v: 1, epoch, n: sequence, from: lastTo + 1, to: files.at(-1).height, deadline, root: merkleRoot(fileBytes), ops: operations, ...(headers.length ? { hx: headers } : {}) };
  assert(utf8(stableJSON({ ...batch, sig: '0'.repeat(128) })).length <= maxBytes, 'batch_bytes');
  return { batch, fileBytes, signingBytes: utf8(`dmw-batch-v1|${network}|${stableJSON(batch)}`), signingDigest: batchDigest(network, batch) };
}
function balance(state, owner, asset, delta) {
  const account = { ...(recordGet(state.balances, owner) ?? {}) }, next = BigInt(account[asset] ?? '0') + delta;
  assert(next >= 0n, 'balance'); account[asset] = next.toString(); state.balances = recordSet(state.balances, owner, account);
}
// One call observes a new raw tip, collects that tip's sealed receipts, then
// settles eligible events against the counted chain. The two clocks differ.
export function processBlock(input) {
  if (input.settings?.batchVersion === 2) return processBlockV2(input);
  assert(input.settings?.batchVersion === undefined || input.settings.batchVersion === 1, 'batch_version');
  return processLegacyBlock(input);
}
export function processLegacyBlock({ height, blockHash, tip, tipHash, network, gateway, history, patterns, entries, receiptRoot, rootAttestations = [],
  state, hashAt, executionHeight = height, priorOperations = [], confirmed = Math.min(height, tip), linkOperations = [], mintOperations = [], settings = {} }) {
  assert(integer(height) && integer(tip) && hex(tipHash, 32) && integer(confirmed) && confirmed <= height && confirmed <= tip && (hex(blockHash, 32) || (blockHash === null && height > tip)) && hashAt(height) === blockHash && hashAt(tip) === tipHash, 'block_clock');
  assert(integer(executionHeight) && executionHeight >= height, 'execution_height');
  assert(height >= (state.counted ?? 0), 'counted_retreat');
  const maxMintOps = settings.maxMintOps ?? MINT_BATCH_DEFAULTS.maxMintOps;
  assert(integer(maxMintOps, 32) && Array.isArray(mintOperations) && mintOperations.length <= maxMintOps, 'batch_mint_ops');
  assert(Array.isArray(linkOperations) && linkOperations.length <= 4, 'link_budget');
  const next = { ...state, balances: state.balances ?? {}, finds: state.finds ?? {},
    types: state.types ?? {}, usedNonces: state.usedNonces ?? {}, linkPayments: state.linkPayments ?? {},
    rounds: (state.rounds ?? []).map(r => ({ ...r, slots: [...r.slots], claims: [...r.claims], headerSenders: [...r.headerSenders] })), counted: height,
    observation: (state.observation ?? 0) + 1 };
  const table = [...patterns], operations = [], outcomes = [], discoveries = [], crafts = [], settlements = [];
  const withinBudget = extra => {
    const ops = aggregateCredits([...priorOperations, ...operations, ...extra]); let assets = 0;
    for (const op of ops) assets += op.op === 'ac' ? op.assets.length : op.op === 'xc' ? op.request.in.length + op.request.out.length : ['mk', 'rq'].includes(op.op) ? 1 : 0;
    return utf8(stableJSON(ops)).length <= (settings.maxBatchBytes ?? 98304) - 4096 && ops.length + 3 <= (settings.maxOps ?? 512) && assets <= (settings.maxAssets ?? 4096) && ops.filter(o => o.op === 'kv').length + 3 <= (settings.maxKv ?? 16);
  };
  const linkOutcomes = [];
  for (const input of linkOperations) {
    const { bitmap, previous, ...paid } = input, verified = verifyLinkInput(paid, network, height, { executionHeight, document: settings.document });
    assert(bitmap?.agent === paid.request.owner && previous === null && !recordGet(next.links, paid.request.height), 'link_owner');
    assert(!recordGet(next.linkPayments, verified.paymentKey), 'link_payment');
    if (!withinBudget([bitmapLinkOp(paid.request.height, executionHeight)])) { linkOutcomes.push({ reason: 'operation_budget' }); continue; }
    next.links = recordSet(next.links, paid.request.height, { block: paid.request.height, linkHeight: executionHeight });
    next.linkPayments = recordSet(next.linkPayments, verified.paymentKey, true);
    operations.push(bitmapLinkOp(paid.request.height, executionHeight)); linkOutcomes.push({ reason: 'accepted' });
  }
  const previousTip = state.lastTip ?? tip - 1, isNewTip = tip > previousTip;
  assert(tip <= previousTip + 1, 'tip_gap');
  next.lastTip = Math.max(previousTip, tip);
  next.highestTip = Math.max(state.highestTip ?? previousTip, tip);
  for (const r of next.rounds) {
    if (next.highestTip >= r.window + 2) r.closed = true;
    if (tip === r.window + 2 && !r.seedHash) r.seedHash = tipHash;
  }
  const round = { window: tip, windowHash: tipHash, claimableHeight: Math.min(height, tip),
    slots: slotsFor(history.get(tip), table), claims: [], headerSenders: [], seedHash: null, closed: false };
  if (isNewTip) next.rounds.push(round);
  const acceptHeader = (event, header, agent) => {
    assert(event && !event.closed && claimWindow(event.window, tip), 'header_window');
    assert(header.height === event.window && parseHeader(header.raw).hash === history.get(header.height).hash, 'header_mismatch');
    if (!event.headerSenders.some(s => s.agent === agent)) event.headerSenders.push({ block: header.height, agent });
  };
  const receipts = entries.map(e => e.receipt);
  assert(verifyReceiptRoot(receiptRoot, receipts, { network, gateway, tip, hash: tipHash }), 'receipt_root');
  const receiptKey = `${tip}/${tipHash}`, priorRoot = recordGet(state.receiptSeals, receiptKey) ?? null;
  assert(!rootAttestations.length || !priorRoot || priorRoot === receiptRoot.root, 'receipt_root_conflict');
  if (rootAttestations.length) next.receiptSeals = recordSet(state.receiptSeals, receiptKey, receiptRoot.root);
  const receiptReference = !entries.length && !rootAttestations.length ? priorRoot : null;
  assert(!entries.length && !rootAttestations.length || verifyRootAttestations(receiptRoot, rootAttestations, settings.receiptSigners), 'receipt_attestations');
  let lastSequence = state.lastSequence ?? -1;
  const seen = new Set();
  for (const { move, receipt } of [...entries].sort((a, b) => a.receipt.sequence - b.receipt.sequence)) {
    assert(receipt.tip === tip && verifyReceipt(receipt, move, { network, gateway, hashAt }) && receipt.sequence > lastSequence, 'receipt_invalid');
    lastSequence = receipt.sequence;
    let reason = checkMove(move, { network, tip, hashAt, puzzleBits: settings.puzzleBits ?? 12, freshness: settings.freshness ?? 2 });
    if (!reason && seen.has(receipt.move)) reason = 'duplicate'; seen.add(receipt.move);
    if (!reason) {
      try {
        const p = move.p;
        if (move.t === 'claim') {
          assert(claimWindow(p.window, tip), 'claim_window');
          const event = next.rounds.find(r => r.window === p.window); assert(event, 'event_missing'); assert(!event.closed, 'claim_window');
          assert(p.plots.every(q => q.block <= event.claimableHeight || q.block === event.window), 'not_counted');
          assert(p.plots.every(q => q.patterns.every(n => !recordGet(next.finds, findId(q.block, n)))), 'already_found');
          const candidates = p.plots.flatMap(q => slotsFor(history.get(q.block), table.filter(p => q.patterns.includes(p.number))));
          if (p.header) acceptHeader(event, p.header, move.a);
          for (const q of p.plots) event.claims.push({ agent: move.a, window: p.window, ...q });
          const known = new Set(event.slots.map(s => s.id));
          for (const slot of candidates) if (!known.has(slot.id)) { event.slots.push(slot); known.add(slot.id); }
        } else if (move.t === 'header') {
          acceptHeader(next.rounds.find(r => r.window === p.height), p, move.a);
        } else if (['discovery-commit', 'discovery-reveal'].includes(move.t)) {
          queueDiscovery(next, move, tip, height, table, blockHash);
        } else if (move.t === 'craft') {
          const r = p.request, key = `${move.a}:${r.nonce}`;
          assert(r.until >= executionHeight, 'request_expired');
          assert(withinBudget([{ op: 'xc', request: r, sig: p.sig }]), 'operation_budget');
          assert(r.owner === move.a && verifyRequest('xc', network, r, p.sig, height), 'craft_signature'); assert(!recordGet(next.usedNonces, key), 'request_replay');
          const inputs = r.in.map(([asset, amount]) => {
            const p = table.find(p => patternAsset(p) === asset), properties = p ? patternProperties(p) : recordGet(next.types, asset)?.properties;
            assert(properties && BigInt(recordGet(next.balances, move.a)?.[asset] ?? '0') >= BigInt(amount), 'craft_inputs'); return { asset, amount, properties };
          });
          const output = compound(p.recipe, inputs, height + 1);
          assert(r.out.length === 1 && r.out[0][0] === output.id && r.out[0][1] === output.amount, 'craft_output');
          assert(!recordGet(next.types, output.id) || recordGet(next.types, output.id).commitment === output.commitment, 'compound_collision');
          const op = signedOp('xc', r, p.sig, network, height);
          for (const [asset, n] of r.in) balance(next, move.a, asset, -BigInt(n)); balance(next, move.a, output.id, BigInt(output.amount));
          if (!recordGet(next.types, output.id)) next.types = recordSet(next.types, output.id, { ...output, amount: '1', firstMaker: move.a, created: height });
          next.usedNonces = recordSet(next.usedNonces, key, true); crafts.push({ ...output, firstMaker: recordGet(next.types, output.id).firstMaker }); operations.push(op);
        }
      } catch (e) { reason = e.message; }
    }
    outcomes.push({ move, reason: reason ?? 'accepted' });
  }
  next.lastSequence = lastSequence;
  const discovery = advanceDiscovery(next, table, history, height, withinBudget(Array.from({ length: 3 }, () => ({ op: 'kv', key: 'pattern/zzzzzzz/proof', value: '0'.repeat(256) }))) ? 1 : 0);
  discoveries.push(...discovery.accepted);
  for (const d of discoveries) operations.push(...discoveryOps(d.record));
  const pending = [];
  let settlementBlocked = false;
  for (const event of next.rounds) {
    // Finish an earlier window before considering a later window's overlapping
    // claims. A transport limit defers winners; it never discards a find.
    if (settlementBlocked || height < event.window + 2 || confirmed < event.window + 2) { pending.push(event); continue; }
    assert(event.seedHash, 'seed_missing');
    if (!event.settlement && (hashAt(event.window) !== event.windowHash || hashAt(event.window + 2) !== event.seedHash)) {
      settlements.push({ window: event.window, void: true, reason: 'chain_mismatch', winners: [] }); continue;
    }
    const result = event.settlement ? null : settleClaims({ ...event, counted: height, decidingHash: event.seedHash, finds: next.finds, settings });
    const settlement = event.settlement ?? { winners: result.winners.map(({ claimers, ...w }) => ({ ...w, tickets: claimers.length })),
      claims: result.claims, rejected: result.claims.filter(c => c.reason !== 'entered').length };
    const { winners } = settlement, from = event.credited ?? 0, credits = [];
    for (const w of winners.slice(from)) {
      const op = creditOp(w.winner, w.asset, String(w.count));
      if (!withinBudget([...credits, op])) break;
      credits.push(op);
    }
    if (from < winners.length && !credits.length) { pending.push(event); settlementBlocked = true; continue; }
    const credited = from + credits.length, complete = credited === winners.length;
    for (const w of winners.slice(from, credited)) {
      assert(!recordGet(next.finds, w.id), 'duplicate_find');
      balance(next, w.winner, w.asset, BigInt(w.count));
      next.finds = recordSet(next.finds, w.id, { block: w.block, pattern: w.pattern, asset: w.asset, count: w.count,
        finder: w.winner, findHeight: height, window: event.window, source: w.source });
    }
    operations.push(...aggregateCredits(credits));
    settlements.push({ ...settlement, window: event.window, void: false, seed: event.seedHash,
      winners: winners.slice(from, credited), complete, credited, total: winners.length,
      headerFinds: winners.filter(w => w.source === 'header').length });
    if (!complete) { event.settlement = settlement; event.credited = credited; pending.push(event); settlementBlocked = true; }
  }
  next.rounds = pending;
  const mintOutcomes = [];
  let mintBudgetFull = false;
  for (const input of mintOperations) {
    if (input.op === 'rq' && input.request?.until < executionHeight) { mintOutcomes.push({ reason: 'request_expired' }); continue; }
    const operation = input.op === 'rq' ? { op: input.op, request: input.request, sig: input.sig } :
      { op: input.op, id: pendingId(network, input.request), ...(input.op === 'mc' ? { permitHash: input.evidence.authorization.permit.hash, payments: paymentProgress(input.evidence.payment.fees, input.evidence.payment.receipts, { confirmations: input.evidence.payment.requiredConfirmations ?? 1 }).allocations } : {}) };
    if (mintBudgetFull || !withinBudget([operation])) { mintBudgetFull = true; mintOutcomes.push({ reason: 'operation_budget' }); continue; }
    operations.push(applyMintInput({ input, network, counted: executionHeight, tip, hashAt, state: next, settings })); mintOutcomes.push({ reason: 'accepted' });
  }
  operations.push(notaryOp(`receipt/${tip.toString(36)}`, receiptRoot.root));
  const file = { v: 4, observation: next.observation, previousHeight: state.counted ?? height - 1, height, hash: blockHash, tip, tipHash, confirmed,
    mintOperations, mintOutcomes, linkOperations, linkOutcomes,
    commissions: [],
    receipts, receiptRoot, rootAttestations, receiptReference, moves: outcomes, settlements, discovery: { work: discovery.work, queued: discovery.queued, rejected: discovery.rejected }, discoveries: discoveries.map(d => ({ record: d.record })), crafts, ops: aggregateCredits(operations) };
  const auditBytes = encodeBinary(file), viewerBytes = summaryBytes(file);
  assert(auditBytes.length <= Math.min(settings.auditMaxBytes ?? 1500000, 1500000), 'audit_budget');
  assert(viewerBytes.length <= Math.min(settings.summaryMaxBytes ?? 1000000, 1000000), 'summary_budget');
  return { state: next, patterns: table, file, operations: file.ops, auditBytes, viewerBytes };
}
