import { installMintPayments } from '../src/mint-payments.mjs';
import { ethereumPayments } from '../src/ethereum.mjs';
import { EvidenceStore } from './evidence.mjs';
import { verifyDeployment } from '../src/deployments.mjs';
import { winningMint, admittedMint } from '../src/mint-evidence.mjs';
import { auditedFind } from '../src/find-evidence.mjs';
import { Bindings } from '../src/bindings.mjs';
import { removeFile } from '../src/retention.mjs';
import { open, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createBitcoin, BitcoinViews } from './bitcoin.mjs';
import { createTap } from './tap.mjs';
import { createEthereum } from './ethereum.mjs';
import { configuredTrac } from './trac.mjs';
import { validateConfig, loadConfig, readSecret, readPrivateJSON } from './config.mjs';
import { Store } from '../src/store.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';
import { verifyMintCertificate } from '../../committee/signer/certificate.mjs';
import { rules } from '../src/rules.mjs';
import { verifyPayer } from '../src/mints.mjs';
import { check, hash, heightKey, serial } from '../src/util.mjs';
import { AcceptedAssetSupply } from './asset-supply.mjs';
import { installNamedReads } from './named-reads.mjs';
import { actionScope } from './source-cache.mjs';
import { withPaidReads, withClockReads } from './http.mjs';
import { BitmapCache } from './bitmap-cache.mjs';
import { publicTreasury, publicEscrow, bitmapOwner } from './public-reads.mjs';

import { FeeQuotes, validateFeePolicy, mintFeeScope, currentFee, feeSettingsField, validateQuotedTerms } from '../src/fees.mjs';
const { secp256k1 } = createRequire(new URL('../../local/package.json', import.meta.url))('@noble/curves/secp256k1');
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
function recovered(digest, signature) {
  const compact = ['r', 's'].map(k => BigInt(signature[k]).toString(16).padStart(64, '0')).join('');
  return secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(signature.v)).recoverPublicKey(digest).toHex(true);
}
export async function productionReads(config, suppliedStore, { runtime, gateway, identity, committee = !suppliedStore } = {}) {
  await validateConfig(config, { committee });
  const registry = async () => { const data = await readPrivateJSON(config.prod.registry, { maxBytes: 2000000 }); validateFeePolicy(data); return data; };
  await registry();

  const state = suppliedStore ?? await Store.open(config.prod.readerData);
  let trac, views, store, closed = false;
  try {
  const client = await createBitcoin(config.prod.bitcoin, config.prod.http, { readsPolicy: config.prod.sourceReads });
  trac = await configuredTrac(config, state, runtime);
  const indexer = await createTap(config.prod.tap, client, config.prod.http, config.prod.sourceReads);
  const ethereum = await createEthereum(config.prod.ethereum, config.prod.http);
  const manifest = { bitcoin: client };
  store = suppliedStore ?? await EvidenceStore.open({ config: config.prod.evidence, identity, gateway, clock: async () => { return reads.tip(); }, stamp: () => trac('stamp') });
  const clockGate = serial();
  views = new BitcoinViews(client, join(config.prod.readerData, 'bitcoin.sqlite'), { maxHeadersPerView: config.prod.maxHeadersPerView });
  indexer.history = (height, hash) => views.view(height, hash);
  if (config.prod.headersFile) await views.seed(config.prod.headersFile);
  const ethRPC = ethereum.rpc, escrow = ethereum.escrow;
  const quotedTerms = (kind, row) => validateQuotedTerms(reads, kind, row);
  const tap = path => indexer.tap(path);
  const content = id => indexer.content(id);
  const request = id => {
    const row = store.get('mints', id); check(row && verifyPayer(config.network, { request: row.request, receiver: row.receiver, payer: row.payer, kind: row.kind, feeQuote: row.requestedFeeQuote, authorization: row.authorization }), 'payer_authorization');
    check(rules.verifyRequest('rq', config.network, row.request, row.signature, row.request.until) && rules.pendingId(config.network, row.request) === id, 'owner_signature'); return row;
  };
  const chainView = async view => {
    const scope = indexer.scope?.();
    if (scope) {
      check(!view || view.tip === scope.stamp.height && view.tipHash === scope.stamp.hash, 'tap_historical_snapshot_unavailable');
      return { tip: scope.stamp.height, tipHash: scope.stamp.hash };
    }
    if (view) return view;
    const head = await trac('head');
    check(await client.blockHash(head.tip.height) === head.tip.hash, 'bitcoin_beacon_disagreement');
    return { tip: head.tip.height, tipHash: head.tip.hash, height: head.counted };
  };
  const included = async (id, view) => {
    const at = await chainView(view), history = await views.view(at.tip, at.tipHash), result = await client.included(id, at, history);
    return result && history.hashAt(result.height) === result.blockHash ? result : null;
  };
  const archive = async path => {
    if (store instanceof EvidenceStore) return store.archive(path);
    const root = resolve(config.data, 'static');
    check(typeof path === 'string' && path.startsWith('/blocks/') && !path.includes('..'), 'audit_path');
    const filename = resolve(root, path.slice(1)); check(filename.startsWith(root + '/'), 'audit_path');
    const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const st = await fd.stat(); check(st.isFile() && st.size <= 1500000, 'audit_size'); const bytes = Buffer.alloc(1500001); const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0); check(bytesRead <= 1500000, 'audit_size'); return bytes.subarray(0, bytesRead); }
    finally { await fd.close(); }
  };
  const auditCache = new Map();
  const audits = async n => {
    const root = await trac('root', [n]); check(root, 'accepted_batch_missing');
    if (auditCache.get(n)?.root === root) return auditCache.get(n).files;
    const batch = store.get('batches', heightKey(n)); check(batch?.batch.root === root, 'accepted_batch_binding');
    check(Array.isArray(batch.publications) && batch.publications.length <= 512, 'audit_count');
    const bytes = []; let total = 0; for (const p of batch.publications) { const value = await archive(p.audit.path); total += value.length; check(total <= 1800000, 'audit_total_size'); bytes.push(value); }
    check(rules.merkleRoot(bytes) === root, 'accepted_audit_root'); const files = bytes.map(b => rules.decodeBinary(b)); check(files.every(f => f.v === 4), 'audit_version');
    if (auditCache.size >= 16) auditCache.delete(auditCache.keys().next().value); auditCache.set(n, { root, files }); return files;
  };
  const find = async (asset, block, pattern, view) => {
    const id = rules.findId(block, pattern.number), hint = store.get('finds', id);
    if (!hint) return null;
    const batch = store.get('findProvenance', id); check(batch, 'find_provenance_missing');
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
  const bindings = new Bindings({ store, network: config.network, bitcoinNetwork: 'mainnet', rosterHistory: config.rosterHistory, members: config.committee?.map(s => s.peer) });
  const supply = new AcceptedAssetSupply({ store, state, trac });
  const bitmaps = new BitmapCache({ indexer, bindings, store, policy: config.prod.bitmapCache });
  const reads = {
    bindings,
    withSnapshot: (view, read) => indexer.at(view, read),
    withAction: read => withPaidReads(() => actionScope.run({ reader: client, started: Date.now() }, read)),
    refreshEvidence: store instanceof EvidenceStore ? () => { auditCache.clear(); return store.refresh(); } : undefined,
    feeQuotes: new FeeQuotes({ network: config.network, gateway, registry }),
    validateFeeTerms: quotedTerms,
    preflight: async (batch, at) => preflightBatch(batch, at, { read: key => trac('read', [key, at]), deployment: await trac('deployment') }),
    receiptObservation: async (tip, tipHash) => {
      const r = store.get('receiptObservations', `${tip}/${tipHash}`); check(r, 'receipt_observation_missing');
      if (!r.archive) return r;
      const bytes = await archive(r.archive.path); check(hash(bytes) === r.archive.hash, 'receipt_archive_binding');
      return { seal: r.seal, receipts: rules.decodeBinary(bytes).receipts };
    },
    receiptCertificate: async (tip, hash) => store.get('receiptCertificates', `${tip}/${hash}`),
    tip: () => {
      const action = actionScope.getStore();
      if (action?.reader === client && action.clock) { check(Date.now() - action.started <= (indexer.policy?.maxScopeMs ?? 120000), 'clock_scope_expired'); return action.clock; }
      const result = withClockReads(() => clockGate(async () => {
      const chain = await client.tip(); await views.view(chain.height, chain.hash);
      const tip = chain.height, previous = state.get('prodBitcoin', 'highestTip'), highestTip = Math.max(tip, previous ?? 0);
      if (highestTip !== previous) await state.put('prodBitcoin', 'highestTip', highestTip);
      return { tip, tipHash: chain.hash, highestTip };
      }));
      if (action?.reader === client) action.clock = result;
      return result;
    },
    mintCertificate: async id => store.get('ceremonies', 'mint/' + id)?.result.certificate,
    manifest, store, trac, views, tap, content, included, registry, ethRPC, escrow, indexer, client,
    head: () => trac('head'), assetSupply: () => supply.read(),
    bitmaps: async owner => (await bitmaps.snapshot(owner)).bitmaps,
    bitmapSnapshot: owner => bitmaps.snapshot(owner),
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
    authority: () => trac('authority'), counted: async () => (await trac('head')).counted, batchLast: () => trac('batchLast'), batchRoot: n => trac('root', [n]), committeeEpoch: async () => (await trac('authority')).epoch,
    balance: (owner, asset, at) => trac('balance', [owner, asset, at]), nonceUsed: (owner, nonce, at) => trac('nonceUsed', [owner, nonce, at]), pending: (id, at) => trac('pending', [id, at]),
    pendingAcceptance: id => trac('acceptance', [id]), mintExit: id => trac('exit', [id]), agentAddress: id => trac('agentAddress', [id]), blockHold: (asset, block, at) => trac('hold', [asset, block, at]),
    async retireContexts(accepted) {
      for await (const entry of await opendir(config.prod.contexts)) if (entry.isFile() && /^[0-9]+\.json$/.test(entry.name) && Number(entry.name.slice(0, -5)) <= accepted - 8) await removeFile(join(config.prod.contexts, entry.name));
    },
    settings: () => trac('settings'), batchHeaders: async () => [], batchStamp: async () => { const before = await trac('stamp'), tap = await indexer.stamp(); check(tap.height === before.tip && tap.hash === before.tipHash && same(before, await trac('stamp')), 'read_snapshot_changed'); return { ...before, tap }; },
    async batchContext(sequence) {
      check(Number.isSafeInteger(sequence) && sequence > 0, 'batch_sequence');
      const context = store instanceof EvidenceStore ? store.context(sequence) : await readPrivateJSON(join(config.prod.contexts, sequence + '.json'), { maxBytes: 8000000 });
      check(context.last.n + 1 === sequence && same(context.last, await trac('batchLast')), 'batch_sequence');
      check([config.committee.map(s => s.peer), ...(config.rosterHistory ?? []).map(r => r.members)].some(members => same(context.settings.receiptSigners, members)), 'receipt_roster_changed');
      check((context.settings.claimsPerWindow ?? rules.CLAIM_DEFAULTS.claimsPerWindow) === (config.claimsPerWindow ?? rules.CLAIM_DEFAULTS.claimsPerWindow), 'claim_budget_policy');
      const histories = []; for (const input of context.inputs) histories.push(await views.view(input.tip, input.tipHash));
      return { ...context, history: histories[0], hashAt: histories[0].hashAt, views: histories.map(history => ({ history, hashAt: history.hashAt })) };
    },
    async assetContext(asset, block, viewOrKind, payoutSnapshot, admittedId, sourceLocators) {
      const registrations = await registry(), current = registrations.assets[asset];
      const registered = payoutSnapshot?.deploymentId ? [current, ...(registrations.generations?.[asset] ?? [])].find(e => e?.id === payoutSnapshot.deploymentId) : current; check(registered, 'asset_unregistered');
      const indexTick = registered.indexTick ?? registered.tick;
      const { deployment, authorityKey: publicKey } = await verifyDeployment(reads, { ...registered, sourceLocators: sourceLocators ?? registered.sourceLocators ?? payoutSnapshot?.sourceLocators }, { view: typeof viewOrKind === 'object' ? viewOrKind : undefined });
      const found = registered.kind === 'dmt' ? await find(asset, block, registered.pattern, typeof viewOrKind === 'object' ? viewOrKind : undefined) : null;
      const live = store.list('activeMints', { limit: 256 }).map(r => store.get('mints', r.id)).filter(r => r.request.asset === asset && r.request.block === block);
      const kinds = new Set(live.map(r => r.kind));
      const kind = payoutSnapshot ? JSON.parse(payoutSnapshot.scope)[3] : typeof viewOrKind === 'string' ? viewOrKind : kinds.size === 1 ? [...kinds][0] : registered.defaultPayKind ?? 'tap';
      check(payoutSnapshot || kinds.size <= 1 || typeof viewOrKind === 'string', 'ambiguous_payment_context');
      const destinations = registered[kind]; check(destinations, 'payment_destinations');
      const pattern = (store.get('meta', 'patterns') ?? []).find(p => rules.patternAsset(p) === asset);
      const payouts = { finder: null, firstMaker: null, discoverer: null, landowner: null };
      const payout = (agent, role) => { const proof = bindings.resolve(agent, kind, payoutSnapshot, role); payouts[role] = proof?.id ?? null; return proof?.request.address ?? null; };
      let discoverer = null;
      if (pattern?.discoverer) {
        const provenance = store.get('patternProvenance', asset); check(provenance, 'pattern_provenance_missing');
        const accepted = (await audits(provenance)).flatMap(f => f.discoveries).find(d => d.record.number === pattern.number)?.record;
        check(accepted?.discoverer === pattern.discoverer, 'discoverer_binding');
        discoverer = payout(pattern.discoverer, 'discoverer');
      }
      let maker = found?.finder;
      if (registered.kind === 'compound') {
        const type = store.get('types', asset), provenance = store.get('typeProvenance', asset);
        check(type?.firstMaker && provenance, 'first_maker_provenance_missing');
        const accepted = (await audits(provenance)).flatMap(f => f.crafts).find(c => c.id === asset);
        check(accepted?.firstMaker === type.firstMaker, 'first_maker_binding'); maker = type.firstMaker;
      }
      const address = payout(maker, registered.kind === 'dmt' ? 'finder' : 'firstMaker');
      const admission = admittedId ? await admittedMint({ store, reads, audits, network: config.network, id: admittedId }) : null;
      if (admission) check(admission.context.deployment.id === registered.id, 'mint_admission_deployment');
      const link = admission ? admission.context.link : block === undefined ? null : await reads.link(block);
      const holder = link ? admission ? admission.bitmap : await reads.bitmap(block) : null;
      if (payoutSnapshot?.mintOwnershipHash) check(payoutSnapshot.mintOwnershipHash === hash(rules.stableJSON({ bitmap: holder, link })), 'quote_recipient_changed');
      const landownerAddress = holder ? kind === 'ethereum' ? payout(holder.agent, 'landowner') : holder.address : null;
      return { sourceLocators: sourceLocators ?? registered.sourceLocators ?? payoutSnapshot?.sourceLocators, ...feeSettingsField(payoutSnapshot ? payoutSnapshot.feeSettings : currentFee(registrations).feeSettings), deployment: { id: registered.id, generation: registered.generation ?? 1, privilege: registered.privilege, elementId: registered.elementId ?? deployment.elem ?? null, dt: registered.dt ?? deployment.dt ?? null, options: registered.options ?? {}, approval: registered.approval ?? null, kind: registered.kind, tick: registered.tick, active: true, privilegePublicKey: publicKey, decimals: deployment.dec,
        remaining: await tap('getMintTokensLeft/' + indexTick), limit: deployment.lim ?? '0' }, find: found, link, bitmapHolder: holder,
        landownerAddress, displayLabel: registered.displayLabel ?? registered.pattern?.name ?? asset, discoverer, payouts, tier: registered.pattern?.tier ?? 1, treasury: destinations.treasury,
        finderAddress: found?.finder ? address : null, firstMakerAddress: registered.kind === 'compound' ? address : null };
    },
    bitmap: block => bitmapOwner({ tap, indexer, bindings }, block),
    async link(block) {
      const value = await trac('record', ['link/' + block.toString(36)]);
      if (value === null) return null;
      const row = typeof value === 'string' ? JSON.parse(value) : value;
      check(row.block === block && Number.isSafeInteger(row.linkHeight), 'link_record'); return row;
    },
    async linkTerms(id, signed) {
      const row = store.get('linkRequests', id); check(row && same(row.request, signed) && rules.linkId(config.network, signed) === id, 'link_binding');
      return quotedTerms('link', row);
    },
    async linkPayment(id, view) { const row = store.get('linkRequests', id); check(row, 'link_binding'); return reads.linkPaymentFor(row, view); },
    async linkPaymentFor(row, view) {
      const p = await reads.linkLockPayment(row, view), consumed = await tap('getLockConsume/' + row.paymentId);
      if (!consumed) return p;
      const inclusion = await included(consumed.ins, view);
      if (consumed.action === 'claim') check(consumed.lock === row.paymentId && consumed.owner === p.payer && consumed.target === p.claim && consumed.tick === p.tick && consumed.kind === p.lockKind && consumed.amt === p.base && (consumed.total ?? consumed.amt) === p.total && same(consumed.al ?? [], p.allocations), 'link_release_allocations');
      return { ...p, settlement: { accepted: consumed.action === 'claim' && !!inclusion, refund: consumed.action === 'refund', paymentId: row.paymentId,
        txid: consumed.ins.slice(0, 64), confirmations: inclusion?.confirmations ?? 0 } };
    },
    async isMinted(deployment, tick, block, view) {
      const d = await reads.indexedDeployment('dmt-' + tick); check(d?.ins === deployment, 'deployment_binding');
      const r = await tap('getDmtMintHolderByBlock/' + encodeURIComponent('dmt-' + tick) + '/' + block);
      if (!r) return false; check(await included(r.ins, view), 'indexed_mint_unconfirmed'); return true;
    },
    payer: async id => request(id).payer,
    mintPayoutSnapshot: async id => (await reads.mintFeeTerms(id)).payoutSnapshot,
    async mintFeeTerms(id) {
      const row = request(id), data = await registry(), registered = data.assets[row.request.asset]; check(registered, 'asset_unregistered');
      const terms = await reads.feeQuotes.accepted(row.feeAuthorization, mintFeeScope(row.request.asset, row.request.block, row.kind), id, row.request.expires);
      check(!row.requestedFeeQuote || same(row.requestedFeeQuote, row.quote.feeQuote), 'payer_quote_binding');
      check(row.quote.baseFee === terms.baseFee && same(row.quote.feeQuote, row.feeAuthorization.quote), 'mint_fee_quote'); check(row.quote.feeQuote.payouts, 'binding_snapshot_missing'); return { ...terms, payoutSnapshot: row.quote.feeQuote };
    },
    tapPayment: payment,
    escrowDeposit: (payer, id) => escrow.deposit(payer, id),
    async mint(id, view) {
      const row = request(id), entry = row.mintInscription ? { id: row.mintInscription } : null;
      return winningMint(reads, row, entry, recovered, view);
    },
    async mintAuthorization(id) {
      const r = store.get('ceremonies', 'mint/' + id); check(r?.stage === 'complete' && r.result.certificate, 'mint_authorization_missing');
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
    async close() { if (closed) return; closed = true; try { views.close(); } finally { try { if (!suppliedStore) { store.close(); await state.close(); } } finally { await trac.close(); } } }
  };
  // REST exposes current ownership and lock state. Historical financial reads
  // fail closed unless the indexed snapshot is precisely the requested branch.
  for (const name of ['bitmap', 'isMinted', 'mint', 'assetContext', 'linkPayment', 'linkLockPayment']) {
    const original = reads[name];
    const atIndex = { bitmap: 1, isMinted: 3, mint: 1, cancellation: 1, assetContext: 2, linkPayment: 1, linkLockPayment: 1 }[name];
    reads[name] = (...args) => indexer.at(typeof args[atIndex] === 'object' ? args[atIndex] : undefined, () => original(...args));
  }
  reads.tapPayment = (id, binding, at) => indexer.at(at, () => payment(id, binding, at));
  const originalPreflight = reads.preflight;
  reads.preflight = async (...args) => { const before = await trac('stamp'), result = await originalPreflight(...args); check(same(before, await trac('stamp')), 'trac_snapshot_changed'); return result; };
  installMintPayments(reads, { request, network: config.network, escrow: config.prod.ethereum, confirmations: config.prod.ethereum.confirmations });
  const originalMintPayment = reads.mintPayment;
  reads.mintPayment = (...args) => indexer.at(undefined, () => originalMintPayment(...args));
  installNamedReads(reads, indexer);
  reads.paymentUsed = key => trac('paymentUsed', [key]);
  reads.bitcoinTransaction = id => client.transaction(id);
  const mintEth = ethereumPayments({ rpc: ethRPC, escrow: config.prod.ethereum });
  reads.escrowSettled = (payer, id) => mintEth.settled('ethereum', id, payer);
  reads.inscription = id => indexer.inscription(id);
  return reads;
  } catch (error) { views?.close(); if (!suppliedStore) { store?.close(); await state.close(); } await trac?.close(); throw error; }
}
export async function createReads({ config: filename, readerId, gateway, identity }) {
  const config = await loadConfig(filename, { committee: true });
  if (readerId !== undefined) check(/^[a-zA-Z0-9_-]{1,64}$/.test(readerId) && readerId !== 'gateway', 'reader_id');
  return productionReads(config, undefined, { gateway, identity });
}
