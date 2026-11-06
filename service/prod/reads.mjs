import { officialName } from '../src/official-ticker-names.mjs';
import { selectedDeployment } from '../src/registry.mjs';
import { phase, lifecycleSignal } from '../src/lifecycle.mjs';
import { acceptedAssetProvenance } from '../src/asset-provenance.mjs';
import { PublicScanIndex } from './public-scan-index.mjs';
import { patternCatalogId } from '../src/mint-assets.mjs';
import { lookupMaintenance } from './lookup-maintenance.mjs';
import { installFinancialSources, acceptedFinancialReservation } from '../src/financial-sources.mjs';
import { installFinancialChain } from '../src/financial-chain.mjs';
import { createFinancialRebaseVerifier } from '../src/financial-chain-provenance.mjs';
import { createAcceptedAudits } from '../src/accepted-audits.mjs';
import { acceptedFinancialRecord } from '../src/financial-inventory.mjs';
import { financialMintId, verifyFinancialMintRequest } from '../../rules/src/financial-mint.js';
import { BitmapIndex } from './bitmap-index.mjs';
import { SubmittedBitmaps } from '../src/submitted-bitmaps.mjs';
import { TapLookupIndex, installTapLookups } from './tap-index.mjs';
import { readerSettings } from './reader-settings.mjs';
import { configuredResources } from '../src/r3-settings.mjs';
import { readRegistry, KeyedRegistry } from '../src/registry.mjs';
import { installMintPayments } from '../src/mint-payments.mjs';
import { ethereumPayments } from '../src/ethereum.mjs';
import { EvidenceStore } from './evidence.mjs';
import { closureTimeouts } from '../../rules/src/closure-timeouts.js';
import { collectMigrationEvidence } from './migration-export.mjs';
import { verifyDeployment } from '../src/deployments.mjs';
import { winningMint, admittedMint, acceptedPublicMintRow } from '../src/mint-evidence.mjs';
import { auditedFind } from '../src/find-evidence.mjs';
import { EvidenceBindings } from './evidence-bindings.mjs';
import { Bindings } from '../src/bindings.mjs';
import { removeFile } from '../src/retention.mjs';
import { open, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createBitcoin, BitcoinViews } from './bitcoin.mjs';
import { initializeHeaderReader } from './header-bootstrap.mjs';
import { createTap } from './tap.mjs';
import { createEthereum } from './ethereum.mjs';
import { configuredTrac } from './trac.mjs';
import { validateConfig, loadConfig, readSecret, readPrivateJSON } from './config.mjs';
import { Store } from '../src/store.mjs';
import { timeStep, addStep } from '../src/read-timing.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';
import { verifyMintCertificate } from '../../committee/signer/certificate.mjs';
import { rules } from '../src/rules.mjs';
import { verifyPayer } from '../src/mints.mjs';
import { check, hash, serial } from '../src/util.mjs';
import { AcceptedAssetSupply } from './asset-supply.mjs';
import { walletBitmaps } from '../src/bitmaps.mjs';
import { publicTreasury, publicEscrow, bitmapOwner, deploymentHolders } from './public-reads.mjs';
import { installPublicSummarySources } from './public-summary-sources.mjs';
import { snapshotMemo } from '../src/snapshot-memo.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

import { FeeQuotes, validateFeePolicy, mintFeeScope, currentFee, feeSettingsField, validateQuotedTerms, mintOwnershipMatches } from '../src/fees.mjs';
const { secp256k1 } = createRequire(new URL('../../local/package.json', import.meta.url))('@noble/curves/secp256k1');
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const INDEXER_MIN_RPS = 100;
export async function batchReadStamp(trac, indexer) {
  const before = await trac('stamp'), tap = await indexer.stamp();
  // ord returns safe numeric heights; activated notaries return exact decimal
  // strings. Compare their values without rounding either representation.
  check(rules.compareOrdinal(tap.height, before.tip) === 0 && tap.hash === before.tipHash
    && same(before, await trac('stamp')), 'read_snapshot_changed');
  return { ...before, tap };
}
// Admission is a gateway preview, not independent signer evidence. Active v2
// financial records change in batches; the transport revision also changes on
// unrelated appends. Keep the batch/TAP fence and off-batch authority/policy state.
// The native adapter acquires this stamp from one checkout and omits revision:
// it cannot be used as a historical checkout handle.
export async function gatewayFinancialReadStamp(trac, indexer) {
  const snapshot = () => trac('financialPreviewStamp');
  const before = await snapshot(), tap = await indexer.stamp();
  check(rules.compareOrdinal(tap.height, before.tip) === 0 && tap.hash === before.tipHash &&
    same(before, await snapshot()), 'read_snapshot_changed');
  return { ...before, tap };
}
export function checkBatchReceiptRoster(config, settings) {
  const rosters = [config.committee.map(s => s.peer), ...(config.rosterHistory ?? []).map(r => r.members)];
  check(rosters.some(members => same(settings.receiptSigners,
    settings.document ? members.map(({ id, identity }) => ({ id, identity })) : members)), 'receipt_roster_changed');
}
function recovered(digest, signature) {
  const compact = ['r', 's'].map(k => BigInt(signature[k]).toString(16).padStart(64, '0')).join('');
  return secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(signature.v)).recoverPublicKey(digest).toHex(true);
}
export async function productionReads(config, suppliedStore, { runtime, gateway, identity, committee = !suppliedStore } = {}) {
  config = configuredResources(config);
  await validateConfig(config, { committee });
  const limits = readerSettings(config.prod.readerSettings);
  const candidateScope = new AsyncLocalStorage();
  // Only bulk quote/request enter this per-reader scope. Committee readers and
  // concurrent gateway batch builders retain their complete raw revision fence.
  const gatewayPreview = config.v2 && suppliedStore && !committee ? new AsyncLocalStorage() : null;
  const previewing = () => gatewayPreview?.getStore()?.active === true;
  // Share expensive common work only for this candidate scan. This map never
  // survives a financial snapshot change, unlike TAP's independently fenced cache.
  const candidateRead = (key, fn) => {
    const scope = candidateScope.getStore();
    if (!scope?.active) return fn();
    const cache = scope.cache;
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(fn));
    return cache.get(key);
  };
  // Every plot scan of one batch verifies the same deployment at the same
  // snapshot, in the gateway and in each signer. Reuse that verification for
  // the identical snapshot; a new snapshot or a failure reads the source again.
  const snapshotRead = snapshotMemo();
  const registry = () => candidateRead('registry', async () => { const value = await readRegistry(config.prod.registry, config.prod.registrySettings); check(value instanceof KeyedRegistry, 'registry_migration_required'); return value; });
  await registry();

  const state = suppliedStore ?? await Store.open(config.prod.readerData, config.storeSettings);
  let trac, views, store, ethereum, lookups, maintenance, warmTimer, closed = false;
  try {
  // Bitcoin and TAP reads share one paced queue to our own indexer. The HTTP default (2/s) made a
  // first-mint deployment check wait behind routine refreshes for minutes; installs without an
  // explicit rate use 100/s for this queue only (the indexer answers in about 1 ms).
  // The v2 settings document still carries the launch source rate (2/s), which made every first-mint and quote
  // check wait seconds per read on our own indexer (it answers in about 1 ms). Reads from it run at least 100/s
  // until the settings amendment raises sourceRps; a higher configured rate still wins.
  const indexerHttp = { ...config.prod.http, requestsPerSecond: Math.max(config.prod.http?.requestsPerSecond ?? 0, INDEXER_MIN_RPS) };
  const client = await phase('reader.bitcoin_open', () => createBitcoin(config.prod.bitcoin, indexerHttp));
  trac = await phase('reader.trac_open', () => configuredTrac(config, state, runtime));
  const indexer = await phase('reader.tap_open', () => createTap(config.prod.tap, client, indexerHttp, config.prod.lookupSettings));
  lookups = new TapLookupIndex({ filename: join(config.prod.readerData, 'tap-lookups.sqlite'), indexer, settings: config.prod.lookupSettings });
  ethereum = await phase('reader.ethereum_open', () => createEthereum(config.prod.ethereum, config.prod.http, { filename: join(config.prod.readerData, 'ethereum-events.sqlite') }));
  const manifest = { bitcoin: client };
  const snapshotLifetimeMs = config.v2 ? async () => {
    const current = await trac('rulesContext');
    check(current?.ready && current.settings?.network === config.network && rules.hashObject(current.settings) === current.settingsHash, 'evidence_settings');
    return closureTimeouts(rules.validateSettingsDocument(current.settings), config.v2.resources)?.evidenceMs;
  } : undefined;
  store = suppliedStore ?? await EvidenceStore.open({ config: config.prod.evidence, identity, gateway, snapshotLifetimeMs, clock: async () => { const tip = await client.tip(); return { tip: tip.height, tipHash: tip.hash }; }, stamp: () => trac('stamp') });
  const clockGate = serial();
  views = new BitcoinViews(client, join(config.prod.readerData, 'bitcoin.sqlite'), { maxHeadersPerView: config.prod.maxHeadersPerView, settings: config.prod.lookupSettings, integerVersion: config.v2 ? 2 : 1 });
  if (config.prod.headerSeed) await phase('reader.header_seed', () => views.seedChunks(config.prod.headerSeed));
  else if (config.prod.headersFile) await phase('reader.header_seed', () => views.seed(config.prod.headersFile));
  const headerBootstrap = await phase('reader.header_bootstrap', () => initializeHeaderReader({ client, indexer, views }));
  const ethRPC = ethereum.rpc, escrow = ethereum.escrow;
  const quotedTerms = (kind, row) => validateQuotedTerms(reads, kind, row);
  const tap = path => indexer.tap(path);
  let content = id => indexer.content(id);
  const request = async id => {
    const row = await store.get('mints', id);
    if (row?.context?.kind === 'bulk-v1') return row;
    // A public (TAP Wallet) mint carries no agent signature. Its accepted source
    // record binds every field the mint check reads; the permit itself is bound
    // by the committee signature and the accepted permit hash.
    // Rows projected before the marker was exported lack publicMint; the accepted
    // source record decides then. Agent rows always carry a payer authorization.
    const source = row && (row.publicMint || !row.authorization) && typeof reads.financialRecord === 'function' ? await reads.financialRecord('fi/source/' + id) : null;
    if (row && (row.publicMint || source?.publicMint === true)) {
      const d = row.context?.deployment;
      check(source?.publicMint === true && source.requestId === id && same(source.request, { asset: row.request?.asset, block: row.request?.block, amount: row.request?.amount }) &&
        source.receiver === row.receiver && d && source.deployment?.id === d.id && source.deployment.tick === d.tick &&
        source.deployment.privilegePublicKey === d.privilegePublicKey, 'public_mint_source');
      return row;
    }
    check(row && verifyPayer(config.network, { request: row.request, receiver: row.receiver, payer: row.payer, kind: row.kind, feeQuote: row.requestedFeeQuote, authorization: row.authorization }), 'payer_authorization');
    check(verifyFinancialMintRequest(config.network, row.request, row.signature, row.request.until) && financialMintId(config.network, row.request) === id, 'owner_signature'); return row;
  };
  const chainView = async view => {
    if (view) return view;
    const head = await trac('head');
    check(await client.blockHash(head.tip.height) === head.tip.hash, 'bitcoin_beacon_disagreement');
    return { tip: head.tip.height, tipHash: head.tip.hash, height: head.counted };
  };
  const included = async (id, view) => {
    const at = await chainView(view), history = await views.view(at.tip, at.tipHash), result = await client.included(id, at, history);
    return result && history.hashAt(result.height) === result.blockHash ? result : null;
  };
  const archive = async (path, expectedHash) => {
    if (store instanceof EvidenceStore) return store.archive(path, expectedHash);
    const root = resolve(config.data, 'static');
    check(typeof path === 'string' && path.startsWith('/blocks/') && !path.includes('..'), 'audit_path');
    const filename = resolve(root, path.slice(1)); check(filename.startsWith(root + '/'), 'audit_path');
    const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const st = await fd.stat(); check(st.isFile() && st.size <= limits.auditFileBytes, 'audit_size'); const bytes = Buffer.alloc(limits.auditFileBytes + 1); const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0); check(bytesRead <= limits.auditFileBytes, 'audit_size'); return bytes.subarray(0, bytesRead); }
    finally { await fd.close(); }
  };
  const audits = createAcceptedAudits({ store, root: n => trac('root', [n]), archive, limits });
  const find = async (asset, block, pattern, view) => {
    const id = rules.findId(block, pattern.number), hint = await store.get('finds', id);
    if (!hint) return null;
    const batch = await store.get('findProvenance', id); check(batch, 'find_provenance_missing');
    return auditedFind({ id, asset, block, pattern, hint, batch, audits });
  };
  // ord-tap REST lock fields already contain atomic TAP; never rescale them.
  const payment = async (id, binding, view) => {
    const lock = await tap('getLock/' + id); check(lock, 'payment_lock_missing');
    check(lock.kind === 'htlc' && lock.condition?.type === 'hashlock' && Object.keys(lock.condition).every(k => ['type', 'hash'].includes(k)) && !lock.cert && !lock.control && !lock.policy && !lock.fee, 'payment_lock_policy');
    const inscription = id.split(':')[0], payload = await content(inscription), inclusion = await included(inscription, view); check(inclusion, 'payment_unconfirmed');
    check(payload.redeem?.data === binding.requestId && lock.owner === binding.payer, 'payment_binding');
    const consumed = await tap('getLockConsume/' + id);
    if (consumed) check(await included(consumed.ins, view), 'payment_consume_unconfirmed');
    return { id, requestId: binding.requestId, kind: 'tap', payer: lock.owner, total: lock.total ?? lock.amt, consumed: !!consumed, confirmations: inclusion.confirmations,
      tick: lock.tick, lockKind: lock.kind, conditionType: lock.condition.type, hash: lock.condition.hash, refund: lock.refund, claim: lock.claim, base: lock.amt,
      allocations: lock.al ?? [], refundAfter: Number(lock.refund_after) };
  };
  const bindings = new (store instanceof EvidenceStore ? EvidenceBindings : Bindings)({ store, bindingCacheEntries: config.listen?.publicReads?.bindingCacheEntries, network: config.network, bitcoinNetwork: 'mainnet', rosterHistory: config.rosterHistory, members: config.committee?.map(s => s.peer) });
  const supply = new AcceptedAssetSupply({ store, state, trac, pageBatches: limits.supplyPageBatches, pageOperations: limits.supplyPageOperations });
  // Every committee request (each agent move is acknowledged by all signers) read the Bitcoin tip,
  // the rules context and the authority afresh: seconds per request. Concurrent callers share one
  // read and a result is reused for readCacheMs, so load no longer multiplies Trac/header reads.
  const cacheMs = config.prod.readCacheMs ?? 2000;
  // Values are also refreshed in the background (warm), so a request never waits for a read;
  // fresh() bypasses the cache when a caller sees a newer clock than the cached one.
  const warm = [];
  const shared = fn => { let at = -Infinity, value, flight = null;
    const fresh = () => flight ??= Promise.resolve().then(fn).then(v => { value = v; at = Date.now(); return v; }).finally(() => { flight = null; });
    const read = () => at > -Infinity && (Date.now() - at < cacheMs || flight) ? Promise.resolve(value) : fresh();
    read.fresh = fresh; warm.push(fresh); return read; };
  if (config.prod.warmReads !== false) {
    warmTimer = setInterval(() => { if (!closed && !lifecycleSignal()?.aborted) for (const fresh of warm) fresh().catch(() => {}); }, Math.max(250, Math.floor(cacheMs / 2)));
    warmTimer.unref();
  }
  const sharedHead = shared(() => trac('head')), sharedAuthority = shared(() => trac('authority')), sharedRules = shared(() => trac('rulesContext'));
  const reads = {
    bindings,
    withGatewayFinancialPreview: gatewayPreview ? async task => {
      const scope = { active: true };
      try { return await gatewayPreview.run(scope, task); } finally { scope.active = false; }
    } : undefined,
    refreshEvidence: store instanceof EvidenceStore ? () => store.refresh() : undefined,
    feeQuotes: new FeeQuotes({ network: config.network, gateway, registry, settingsHistory: { get: hash => trac('settingsByHash', [hash]) } }),
    validateFeeTerms: quotedTerms,
    preflight: async (batch, at) => preflightBatch(batch, at, { read: key => trac('read', [key, at]), withReadSnapshot: trac.withReadSnapshot, deployment: await trac('deployment') }),
    receiptCutoffPage: (settingsHash, index) => store.get('receiptCutoffPages', `${settingsHash}/${index}`),
    receiptObservation: async (tip, tipHash, segment) => {
      const r = await store.get('receiptObservations', `${tip}/${tipHash}${segment === undefined ? '' : '/' + segment}`); check(r, 'receipt_observation_missing');
      if (!r.archive) return r;
      const bytes = await archive(r.archive.path, r.archive.hash); check(hash(bytes) === r.archive.hash, 'receipt_archive_binding');
      return { seal: r.seal, receipts: rules.decodeBinary(bytes, limits.contextBytes).receipts };
    },
    receiptCertificate: async (tip, hash, segment) => store.get('receiptCertificates', `${tip}/${hash}${segment === undefined ? '' : '/' + segment}`),
    tip: shared(() => clockGate(async () => {
      const chain = await client.tip(); await views.view(chain.height, chain.hash);
      const clock = rules.ordinalCodec(!!config.v2), tip = clock.value(chain.height), previous = state.get('prodBitcoin', 'highestTip'), highestTip = clock.max(tip, previous ?? 0);
      if (highestTip !== previous) await state.put('prodBitcoin', 'highestTip', highestTip);
      return { tip, tipHash: chain.hash, highestTip };
    })),
    mintCertificate: async id => (await store.get('ceremonies', 'mint/' + id))?.result.certificate,
    manifest, store, trac, views, tap, content, included, registry, ethRPC, escrow, indexer, client, headerBootstrap,
    head: () => trac('head'), assetSupply: () => supply.read(),
    bitmaps: owner => walletBitmaps({ reads, store }, owner),
    publicEscrow: (payer, id) => publicEscrow({ escrow, ethRPC, ethereum: config.prod.ethereum }, payer, id),
    async publicTransactions(after, limit) {
      check(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 200, 'transaction_page');
      const at = await trac('stamp'), total = await trac('read', ['txl', at]) ?? 0, rows = [];
      check(Number.isSafeInteger(total) && total >= after, 'transaction_index_changed', 503);
      const next = Math.min(total, after + limit);
      for (let index = after; index < next; index++) {
        const row = await trac('read', [`txi/${index}`, at]); check(row, 'transaction_index_missing', 503);
        rows.push({ index, tx: row.tx, ipk: row.ipk, val: row.val, err: row.err });
      }
      check(same(at, await trac('stamp')), 'trac_snapshot_changed', 503);
      return { rows, total, next };
    },
    publicTreasury: () => publicTreasury({ registry, tap, ethRPC, ethereum: config.prod.ethereum }),
    rulesContext: Object.assign(() => previewing() || candidateScope.getStore()?.active ? trac('rulesContext') : sharedRules(), { fresh: sharedRules.fresh }),
    withBulkCandidateReads: (at, fn) => indexer.bulkAt(at, async () => {
      const scope = { cache: new Map(), active: true };
      try { return await candidateScope.run(scope, fn); } finally { scope.active = false; }
    }),
    replayNodes: store instanceof EvidenceStore ? (...args) => store.replayNodes(...args) : undefined,
    claimNode: (id, ancestors) => store instanceof EvidenceStore ? store.claimNode(id, ancestors) : store.get('claimNodes', id),
    namedNode: (id, ancestors) => store instanceof EvidenceStore ? store.namedNode(id, ancestors) : store.get('namedNodes', id),
    settingsByHash: hash => trac('settingsByHash', [hash]),
    renewalSlice: n => trac('renewalSlice', [n]),
    authority: Object.assign(() => previewing() ? trac('authority') : sharedAuthority(), { fresh: sharedAuthority.fresh }),
    counted: async () => (await sharedHead()).counted, batchLast: () => trac('batchLast'), batchRoot: n => trac('root', [n]), committeeEpoch: async () => (await trac('authority')).epoch,
    balance: (owner, asset, at) => trac('balance', [owner, asset, at]), nonceUsed: (owner, nonce, at) => trac('nonceUsed', [owner, nonce, at]), pending: (id, at) => trac('pending', [id, at]),
    pendingAcceptance: id => trac('acceptance', [id]), mintExit: id => trac('exit', [id]), agentAddress: id => trac('agentAddress', [id]), blockHold: (asset, block, at) => trac('hold', [asset, block, at]),
    async retireContexts(accepted) {
      for await (const entry of await opendir(config.prod.contexts)) if (entry.isFile() && /^[0-9]+\.json$/.test(entry.name) && BigInt(entry.name.slice(0, -5)) + BigInt(limits.contextRetentionBatches) <= BigInt(accepted)) await removeFile(join(config.prod.contexts, entry.name));
    },
    settings: () => trac('settings'), batchHeaders: async () => [],
    batchStamp: () => previewing() ? gatewayFinancialReadStamp(trac, indexer) : batchReadStamp(trac, indexer),
    async batchContext(sequence) {
      const sequenceText = rules.decimalV2(sequence); check(sequenceText !== '0', 'batch_sequence');
      let context;
      if (store instanceof EvidenceStore) context = await store.context(sequence);
      else if (config.v2) {
        const descriptor = await store.get('evidenceContexts', sequenceText);
        check(descriptor && /^[0-9a-f]{64}$/.test(descriptor.hash) && descriptor.path === descriptor.hash + '.json', 'evidence_context_missing');
        const bytes = await readSecret(join(config.prod.contexts, descriptor.path), { maxBytes: limits.contextBytes });
        check(hash(bytes) === descriptor.hash, 'evidence_context_hash'); context = JSON.parse(bytes);
      } else context = await readPrivateJSON(join(config.prod.contexts, sequence + '.json'), { maxBytes: limits.contextBytes });
      check(rules.nextUint(rules.decimalV2(context.last.n)) === sequenceText && same(context.last, await trac('batchLast')), 'batch_sequence');
      checkBatchReceiptRoster(config, context.settings);
      if (!context.settings.document) check((context.settings.claimsPerWindow ?? rules.CLAIM_DEFAULTS.claimsPerWindow) === (config.claimsPerWindow ?? rules.CLAIM_DEFAULTS.claimsPerWindow), 'claim_budget_policy');
      const histories = []; for (const input of context.inputs) histories.push(await views.view(input.tip, input.tipHash));
      return { ...context, ...(context.settings.document ? { executionHash: await trac('hashAt', [context.counted]) } : {}),
        ...(histories.length ? { history: histories[0], hashAt: histories[0].hashAt } : {}), views: histories.map(history => ({ history, hashAt: history.hashAt })) };
    },
    officialName: name => officialName(reads, store, name),
    async assetContext(asset, block, viewOrKind, payoutSnapshot, admittedId, selection) {
      await timeStep('ctx.ensureRegistry', candidateRead('registry/' + asset + '/' + (payoutSnapshot?.deploymentId ?? selection ?? ''),
        () => reads.ensureRegistryAsset?.(asset, payoutSnapshot?.deploymentId ?? selection)));
      const registrations = await timeStep('ctx.registry', registry()), current = registrations.assets[asset];
      const chosen = selection || payoutSnapshot?.deploymentId;
      const registered = selectedDeployment(registrations, asset, chosen) ?? (payoutSnapshot?.deploymentId && typeof registrations.asset === 'function' ? registrations.asset(asset, payoutSnapshot.deploymentId) : payoutSnapshot?.deploymentId ? (registrations.generations?.[asset] ?? []).find(e => e.id === payoutSnapshot.deploymentId) : null);
      check(registered, 'asset_unregistered');
      if (selection || registered.officialDeployment) {
        check(rules.multiTickerActive(viewOrKind?.executionHeight ?? viewOrKind?.counted ?? await reads.counted()), 'multi_ticker_inactive');
        check(!payoutSnapshot || payoutSnapshot.deploymentId === registered.id, 'financial_deployment_binding');
        if (registered.officialDeployment) check(registered.asset === asset && registered.privilege === current?.privilege &&
          registered.kind === current.kind && (registered.elementId ?? null) === (current.elementId ?? null), 'additional_deployment_binding');
      }
      const catalogAsset = /^(p2:|c2:)/.test(asset) ? asset : config.v2 && patternCatalogId(asset);
      const named = catalogAsset?.startsWith('p2:') && !asset.startsWith('p2:') && await store.get('patternsByAsset', catalogAsset);
      const provenance = /^(p2:|c2:)/.test(asset) || named?.legacy?.asset === asset ? await timeStep('ctx.provenance', acceptedAssetProvenance({ store, reads, asset: catalogAsset, block })) : null;
      if (provenance?.pattern) check(asset === (provenance.pattern.legacy?.asset ?? catalogAsset), 'mint_asset_use_ledger');
      if (provenance?.pattern) check(registered.kind === 'dmt' && ['pat', 'fld', 'dt'].every(k => registered.pattern?.[k] === provenance.pattern[k]) &&
        (registered.pattern?.amountMode ?? 'count') === (provenance.pattern.amountMode ?? 'count'), 'asset_provenance_deployment');
      if (provenance?.compound) check(registered.kind === 'compound', 'asset_provenance_deployment');
      const indexTick = registered.indexTick ?? registered.tick;
      // The outer TAP fence has not closed yet. Keep semantic verification in
      // this scan's cache so a failed fence cannot populate the long-lived
      // deployment cache; only independently fenced source responses survive.
      const deploymentKey = rules.stableJSON(['deployment', registered, viewOrKind ?? null]), verifyRegistered =
        () => verifyDeployment(candidateScope.getStore()?.active ? Object.create(reads) : reads, registered,
          { view: typeof viewOrKind === 'object' ? viewOrKind : undefined });
      const { deployment, authority } = await timeStep('ctx.verifyDeployment', candidateScope.getStore()?.active || reads.financialSnapshot?.() || typeof viewOrKind !== 'object' || viewOrKind === null
        ? candidateRead(deploymentKey, verifyRegistered) : snapshotRead(deploymentKey, verifyRegistered));
      const publicKey = await candidateRead('privilege/' + registered.privilege + '/' + (registered.authorityKey ?? ''), async () => {
        const auth = await timeStep('ctx.privilegeContent', content(registered.privilege)), authorityHash = hash(JSON.stringify(auth.auth) + auth.salt), key = recovered(authorityHash, auth.sig);
        check(auth.hash === authorityHash && key === (registered.authorityKey ?? (await trac('authority')).committee), 'privilege_binding');
        return key;
      });
      const found = provenance ? provenance.find : registered.kind === 'dmt' ? await timeStep('ctx.find', find(asset, block, registered.pattern, typeof viewOrKind === 'object' ? viewOrKind : undefined)) : null;
      const live = viewOrKind?.bulkMint || payoutSnapshot || typeof viewOrKind === 'string' ? [] : (await Promise.all((await store.list('activeMints', { limit: limits.legacyActivePageRows })).map(r => store.get('mints', r.id)))).filter(r => r.request.asset === asset && r.request.block === block);
      const kinds = new Set(live.map(r => r.kind));
      const kind = viewOrKind?.bulkMint ? 'tap' : payoutSnapshot ? JSON.parse(payoutSnapshot.scope)[3] : typeof viewOrKind === 'string' ? viewOrKind : kinds.size === 1 ? [...kinds][0] : registered.defaultPayKind ?? 'tap';
      check(payoutSnapshot || kinds.size <= 1 || typeof viewOrKind === 'string', 'ambiguous_payment_context');
      const destinations = registered[kind]; check(destinations, 'payment_destinations');
      const pattern = provenance ? provenance.pattern : config.v2 ? registered.pattern ?? await store.get('patternsByAsset', asset) : store instanceof EvidenceStore ? await store.get('patternsByAsset', asset) : (store.get('meta', 'patterns') ?? []).find(p => rules.patternAsset(p) === asset);
      const payouts = { finder: null, firstMaker: null, discoverer: null, landowner: null };
      const payout = async (agent, role) => { const proof = await timeStep('ctx.payout', candidateRead(rules.stableJSON(['payout', agent, kind, payoutSnapshot ?? null, role]),
        () => bindings.resolve(agent, kind, payoutSnapshot, role))); payouts[role] = proof?.id ?? null; return proof?.request.address ?? null; };
      let discoverer = null;
      if (pattern?.discoverer) {
        if (!provenance) {
        const provenance = await store.get('patternProvenance', asset); check(provenance, 'pattern_provenance_missing');
        const accepted = (await timeStep('ctx.discoveryAudits', audits(provenance))).flatMap(f => f.discoveries).find(d => d.record.number === pattern.number)?.record;
        check(accepted?.discoverer === pattern.discoverer, 'discoverer_binding');
        }
        discoverer = await payout(pattern.discoverer, 'discoverer');
      }
      let maker = provenance?.maker ?? found?.finder;
      if (registered.kind === 'compound' && !provenance) {
        const type = await store.get('types', asset), provenance = await store.get('typeProvenance', asset);
        check(type?.firstMaker && provenance, 'first_maker_provenance_missing');
        const accepted = (await audits(provenance)).flatMap(f => f.crafts).find(c => c.id === asset);
        check(accepted?.firstMaker === type.firstMaker, 'first_maker_binding'); maker = type.firstMaker;
      }
      const address = maker ? await payout(maker, registered.kind === 'dmt' ? 'finder' : 'firstMaker') : null;
      const admission = admittedId ? await admittedMint({ store, reads, audits, network: config.network, id: admittedId }) : null;
      if (admission) check(admission.context.deployment.id === registered.id, 'mint_admission_deployment');
      const link = admission ? admission.context.link : block === undefined ? null : await timeStep('ctx.link', reads.link(block));
      const holder = link ? admission ? admission.bitmap : await timeStep('ctx.bitmap', reads.bitmap(block)) : null;
      if (payoutSnapshot?.mintOwnershipHash) check(mintOwnershipMatches(payoutSnapshot, { bitmap: holder, link, assetRevision: provenance?.revision }), 'quote_recipient_changed');
      const landownerAddress = holder ? kind === 'ethereum' ? await payout(holder.agent, 'landowner') : holder.address : null;
      return { ...feeSettingsField(payoutSnapshot ? payoutSnapshot.feeSettings : currentFee(registrations).feeSettings), deployment: { id: registered.id, ...(registered.officialDeployment ? { officialDeployment: registered.officialDeployment } : {}), generation: registered.generation ?? 1, privilege: registered.privilege, elementId: registered.elementId ?? deployment.elem ?? null, dt: registered.dt ?? deployment.dt ?? null, options: registered.options ?? {}, approval: registered.approval ?? null, kind: registered.kind, tick: registered.tick, active: true, privilegePublicKey: publicKey, decimals: Number(deployment.dec),
        remaining: await tap('getMintTokensLeft/' + indexTick), limit: deployment.lim ?? '0' }, find: found, link, bitmapHolder: holder,
        ...(provenance?.publicClaims ? { pattern: provenance.pattern, publicClaims: provenance.publicClaims } : {}),
        landownerAddress, displayLabel: registered.displayLabel ?? registered.pattern?.name ?? asset, discoverer, payouts, ...(provenance ? { assetRevision: provenance.revision } : {}), tier: provenance?.tier ?? registered.pattern?.tier ?? 1, treasury: destinations.treasury,
        beneficiaries: { finder: found?.finder ?? null, firstMaker: registered.kind === 'compound' ? maker : null, discoverer: pattern?.discoverer ?? null, landowner: holder?.agent ?? null },
        finderAddress: found?.finder ? address : null, firstMakerAddress: registered.kind === 'compound' ? address : null };
    },
    bitmap: block => bitmapOwner({ tap, indexer, bindings: {
      owners: address => candidateRead('owners/' + address, () => bindings.owners(address))
    } }, block),
    deploymentHolders: (ids, at) => deploymentHolders(indexer, ids, at),
    async link(block) {
      const suffix = BigInt(block).toString(36);
      const value = (config.v2 ? await trac('read', ['k/link/' + suffix]) : null) ?? await trac('record', ['link/' + suffix]);
      if (value === null) return null;
      const row = typeof value === 'string' ? JSON.parse(value) : value;
      check(rules.decimalV2(row.block) === rules.decimalV2(block) && rules.ordinalCodec(typeof row.linkHeight === 'string').valid(row.linkHeight), 'link_record'); return row;
    },
    async linkTerms(id, signed) {
      const row = await store.get('linkRequests', id); check(row && same(row.request, signed) && rules.linkId(config.network, signed) === id, 'link_binding');
      return quotedTerms('link', row);
    },
    async linkPayment(id, view) { const row = await store.get('linkRequests', id); check(row, 'link_binding'); return reads.linkPaymentFor(row, view); },
    async linkPaymentFor(row, view) {
      const p = await reads.linkLockPayment(row, view), consumed = await tap('getLockConsume/' + row.paymentId);
      if (!consumed) return p;
      const inclusion = await included(consumed.ins, view);
      if (consumed.action === 'claim') check(consumed.lock === row.paymentId && consumed.owner === p.payer && consumed.target === p.claim && consumed.tick === p.tick && consumed.kind === p.lockKind && consumed.amt === p.base && (consumed.total ?? consumed.amt) === p.total && same(consumed.al ?? [], p.allocations), 'link_release_allocations');
      return { ...p, settlement: { accepted: consumed.action === 'claim' && !!inclusion, refund: consumed.action === 'refund', paymentId: row.paymentId,
        txid: consumed.ins.slice(0, 64), confirmations: inclusion?.confirmations ?? 0 } };
    },
    async isMinted(deployment, tick, block, view) {
      const d = await tap('getDeployment/' + encodeURIComponent('dmt-' + tick)); check(d?.ins === deployment, 'deployment_binding');
      const r = await tap('getDmtMintHolderByBlock/' + encodeURIComponent('dmt-' + tick) + '/' + block);
      if (!r) return false; check(await included(r.ins, view), 'indexed_mint_unconfirmed'); return true;
    },
    localMint: async id => !!await store.get('mints', id),
    payer: async id => (await request(id)).payer,
    mintPayoutSnapshot: async id => (await reads.mintFeeTerms(id)).payoutSnapshot,
    async mintFeeTerms(id) {
      const row = await request(id);
      await reads.ensureRegistryAsset?.(row.request.asset, row.quote?.feeQuote?.deploymentId);
      check((await registry()).asset(row.request.asset, row.quote?.feeQuote?.deploymentId), 'asset_unregistered');
      const terms = await reads.feeQuotes.accepted(row.feeAuthorization, mintFeeScope(row.request.asset, row.request.block, row.kind), id, row.request.expires);
      check(!row.requestedFeeQuote || same(row.requestedFeeQuote, row.quote.feeQuote), 'payer_quote_binding');
      check(row.quote.baseFee === terms.baseFee && same(row.quote.feeQuote, row.feeAuthorization.quote), 'mint_fee_quote'); check(row.quote.feeQuote.payouts, 'binding_snapshot_missing'); return { ...terms, payoutSnapshot: row.quote.feeQuote };
    },
    tapPayment: payment,
    escrowDeposit: (payer, id, hint) => escrow.deposit(payer, id, hint),
    async mint(id, view) {
      const local = await store.get('mints', id);
      const row = !local && typeof reads.publicMintPermit === 'function' ? await acceptedPublicMintRow(reads, id, view) ?? await request(id) : await request(id);
      const entry = row.mintInscription ? { id: row.mintInscription } : null;
      return winningMint(reads, row, entry, recovered, view);
    },
    async mintAuthorization(id) {
      const r = await store.get('ceremonies', 'mint/' + id); check(r?.stage === 'complete' && r.result.certificate, 'mint_authorization_missing');
      const details = verifyMintCertificate(r.result.certificate, { network: config.network, rosterHistory: config.rosterHistory, members: config.committee.map(s => s.peer), publicKey: (await trac('authority')).committee, id });
      return rules.mintAuthorization(details);
    },
    async linkLockPayment(row, view) {
      await quotedTerms('link', row);
      const p = await payment(row.paymentId, { requestId: row.id, payer: row.terms.payer }, view), inclusion = await included(row.paymentId.split(':')[0], view);
      const block = await client.block(inclusion.blockHash);
      return { ...p, verifiedHeight: inclusion.height, eventIndex: block.tx.indexOf(row.paymentId.slice(0, 64)) * 100 + Number(row.paymentId.split(':')[0].split('i')[1]) };
    },
    escrowRotation: (...args) => escrow.rotation(...args),
    committeeRotation: async () => { const policy = config.prod.committeeRotation; return policy ? await readPrivateJSON(policy) : null; },
    async close() { if (closed) return; closed = true; clearInterval(warmTimer); try { await maintenance?.close(); views.close(); ethereum.close?.(); lookups.close(); } finally { try { if (!suppliedStore) { await store.close(); await state.close({ checkpoint: true }); } } finally { await trac.close(); } } }
  };
  // REST exposes current ownership and lock state. Historical financial reads
  // fail closed unless the indexed snapshot is precisely the requested branch.
  for (const name of ['bitmap', 'isMinted', 'mint', 'cancellation', 'assetContext', 'linkPayment']) {
    const original = reads[name];
    const atIndex = { bitmap: 1, isMinted: 3, mint: 1, cancellation: 1, assetContext: 2, linkPayment: 1 }[name];
    reads[name] = (...args) => { const queued = Date.now();
      return indexer.at(typeof args[atIndex] === 'object' ? args[atIndex] : undefined, () => { addStep('indexerWait.' + name, Date.now() - queued); return original(...args); }); };
  }
  const originalPayment = reads.payment; reads.payment = (...args) => indexer.at(undefined, () => originalPayment(...args));
  reads.tapPayment = (id, binding, at) => indexer.at(at, () => payment(id, binding, at));
  const originalPreflight = reads.preflight;
  // The raw subnet version moves on every unrelated append; a long replay must only
  // fail when the batch-relevant clock or predecessor changed.
  const batchClock = s => ({ counted: s.counted, tip: s.tip, tipHash: s.tipHash, last: s.last });
  reads.preflight = async (...args) => { const before = await trac('stamp'), result = await originalPreflight(...args); check(same(batchClock(before), batchClock(await trac('stamp'))), 'trac_snapshot_changed'); return result; };
  installTapLookups(reads, lookups);
  reads.withTapReadSnapshot = (at, task) => indexer.bulkAt(at, task);
  reads.withNotaryReadSnapshot = trac.withFinancialReadSnapshot;
  reads.bitmapInventory = new BitmapIndex({ lookups, store });
  if (suppliedStore) reads.submittedBitmaps = new SubmittedBitmaps({ store: suppliedStore, settings: config.prod.lookupSettings,
    verify: async (block, inscription) => {
      const height = rules.safeNumberV2(block), at = await chainView();
      await views.view(at.tip, at.tipHash);
      return indexer.at(at, async () => {
        const bitmap = await tap('getBitmap/' + height);
        check(bitmap && bitmap.bm === height && (!inscription || bitmap.ins === inscription), 'bitmap_binding');
        const current = await indexer.inscription(bitmap.ins);
        check(current.id === bitmap.ins && current.address === bitmap.ownr, 'bitmap_owner');
        const owners = await bindings.owners(bitmap.ownr);
        check(owners.length === 1, 'bitmap_agent_binding');
        return { block, inscription: bitmap.ins, agent: owners[0], address: bitmap.ownr, snapshot: { height: String(at.tip), hash: at.tipHash } };
      });
    } });
  installPublicSummarySources(reads, { ethereum: config.prod.ethereum });
  installMintPayments(reads, { settings: config.prod.lookupSettings, request, network: config.network, escrow: config.prod.ethereum, confirmations: config.prod.ethereum.confirmations });
  reads.paymentUsed = key => trac('paymentUsed', [key]);
  reads.bitcoinTransaction = id => client.transaction(id);
  reads.publicMintHeader = async (height, at) => {
    const snapshot = at ?? await reads.batchStamp();
    return (await views.view(snapshot.tip, snapshot.tipHash)).get(height);
  };
  reads.publicBitcoinHash = async (height, at) => {
    check(BigInt(height) <= BigInt(at.counted), 'public_scan_pending');
    const expected = (await views.view(at.tip, at.tipHash)).hashAt(height);
    check(expected && await client.blockHash(rules.safeNumberV2(height)) === expected, 'public_payment_reorg'); return expected;
  };
  reads.publicBitcoinBlock = async (height, at) => client.block(await reads.publicBitcoinHash(height, at), { withTransactions: true });
  reads.publicHeaderHash = async (height, at) => {
    check(BigInt(height) <= BigInt(at.counted), 'public_scan_pending');
    const expected = (await views.view(at.tip, at.tipHash)).hashAt(height); check(expected, 'public_payment_reorg'); return expected;
  };
  // Parsed public payment candidates by block hash, shared by every financial scope.
  reads.publicScanCache = new PublicScanIndex(join(config.prod.readerData, 'public-scan.sqlite'));
  const mintEth = ethereumPayments({ rpc: ethRPC, escrow: config.prod.ethereum });
  reads.escrowSettled = (payer, id, hint) => mintEth.settled('ethereum', id, payer, hint);
  if (config.v2) installFinancialSources(reads, { network: config.network, document: config.v2.document, recoveryVersion: config.assetRecoveryVersion,
    escrow: config.prod.ethereum, suspense: config.assetCustody, lookupSettings: config.prod.lookupSettings, request: async id => await store.get('financialLinks', id) ?? request(id),
    reservation: id => acceptedFinancialReservation({ store, audits, id }), record: (key, at) => trac('read', [key, at]),
    recordMany: (keys, at) => trac('readMany', [keys, at]),
    ethereumRPC: ethRPC, payout: id => store.get('financialCustodyPayments', id) });
  content = reads.content;
  reads.inscription = id => indexer.inscription(id);
  if (config.v2) {
    const bitcoinHash = async (height, at) => (await views.view(at.tip, at.tipHash)).hashAt(height), canonicalBitcoinHash = height => client.blockHash(height);
    const rebaseSafe = createFinancialRebaseVerifier({ store, audits, bitcoinHash, canonicalBitcoinHash, deploymentIncluded: included, settings: config.financialChain });
    installFinancialChain(reads, { bitcoinHash, canonicalBitcoinHash, bitcoinHeader: hash => views.get.get(hash), settings: config.financialChain,
      rebaseSafe, ethereumRPC: ethRPC });
    reads.financialInventoryPage = (range, at) => trac('financialPage', [range, at]);
    reads.financialRecordProvenance = (key, value) => acceptedFinancialRecord({ store, audits, key, value });
    reads.financialBeaconConfig = () => trac('deployment');
    reads.financialCanonicalBitcoinHash = height => client.blockHash(height);
    reads.financialCanonicalTip = () => client.tip();
    reads.financialRecoveryHeaders = async (from, target, limit) => {
      const headers = []; let height = rules.decimalV2(from);
      for (let n = 0; n < limit && BigInt(height) < BigInt(target.height); n++) { height = rules.nextUint(height); headers.push(await client.header(await client.blockHash(height))); }
      check(await client.blockHash(target.height) === target.hash, 'financial_recovery_target'); return headers;
    };
  }
  const v2Projection = () => suppliedStore?.get('meta', 'ruleState')?.batchVersion === 2;
  maintenance = lookupMaintenance({ lookups: { tick: () => lookups.tick({ submittedBitmapsOnly: v2Projection() }) },
    inventory: { tick: () => v2Projection() ? reads.submittedBitmaps.tick() : reads.bitmapInventory.tick() }, ethereum, interval: lookups.settings.refreshMs });
  reads.refreshLookups = () => maintenance.run(); reads.lookupStatus = () => maintenance.status();
  if (store instanceof EvidenceStore) reads.migrationEvidence = () => collectMigrationEvidence({ store,
    notarySnapshot: () => trac('migrationSnapshot'), historyFor: at => views.view(at.tip, at.tipHash) });
  if (store instanceof EvidenceStore) reads.migrationHistory = anchor => views.view(Number(anchor.height), anchor.hash);
  return reads;
  } catch (error) { clearInterval(warmTimer); views?.close(); ethereum?.close?.(); lookups?.close(); if (!suppliedStore) { await store?.close(); await state.close({ checkpoint: true }); } await trac?.close(); throw error; }
}
export async function createReads({ config: filename, readerId, gateway, identity }) {
  const config = await loadConfig(filename, { committee: true });
  if (readerId !== undefined) check(/^[a-zA-Z0-9_-]{1,64}$/.test(readerId) && readerId !== 'gateway', 'reader_id');
  return productionReads(config, undefined, { gateway, identity });
}
