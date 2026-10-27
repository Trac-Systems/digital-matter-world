import { createBitcoin, BitcoinViews } from '../prod/bitcoin.mjs';
import { ordContent } from '../prod/tap.mjs';
import { installMintPayments } from '../src/mint-payments.mjs';
import { ethereumPayments } from '../src/ethereum.mjs';
import { verifyDeployment } from '../src/deployments.mjs';
import { winningMint, admittedMint } from '../src/mint-evidence.mjs';
import { auditedFind } from '../src/find-evidence.mjs';
import { Bindings } from '../src/bindings.mjs';
import { removeFile } from '../src/retention.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir, opendir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { installLocalFetch } from '../src/http-client.mjs';
import { createEscrowReader } from '../../committee/signer/escrow-reader.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';
import { verifyMintCertificate } from '../../committee/signer/certificate.mjs';
import { rpcClient } from '../src/rpc.mjs';
import { rules } from '../src/rules.mjs';
import { verifyPayer } from '../src/mints.mjs';
import { check, hash, heightKey } from '../src/util.mjs';
import { tracClient } from './trac.mjs';
import { FeeQuotes, validateFeePolicy, mintFeeScope } from '../src/fees.mjs';
import { calldata } from '../../committee/signer/escrow.mjs';
import { walletBitmaps } from './bitmaps.mjs';
const { secp256k1 } = createRequire(new URL('../../local/package.json', import.meta.url))('@noble/curves/secp256k1');
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
export class ReadStore {
  constructor(directory) { this.directory = directory; }
  database() { if (!this.db) { this.db = new DatabaseSync(join(this.directory, 'index.sqlite'), { readOnly: true }); this.db.exec('PRAGMA cache_size=-4096'); } return this.db; }
  get(space, id) { const row = this.database().prepare('SELECT value FROM records WHERE space=? AND id=?').get(space, String(id)); return row ? JSON.parse(row.value) : null; }
  list(space, { after = '', limit = 1000 } = {}) { return this.database().prepare('SELECT id,value FROM records WHERE space=? AND id>? ORDER BY id LIMIT ?').all(space, after, limit).map(r => ({ id: r.id, value: JSON.parse(r.value) })); }
  close() { this.db?.close(); }
}
export { BitcoinViews };
function recovered(digest, signature) {
  const compact = ['r', 's'].map(k => BigInt(signature[k]).toString(16).padStart(64, '0')).join('');
  return secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(signature.v)).recoverPublicKey(digest).toHex(true);
}
export async function localReads(config, suppliedStore, { gateway } = {}) {
  installLocalFetch();
  const registry = async () => { const data = JSON.parse(await readFile(config.local.registry, 'utf8')); validateFeePolicy(data); return data; };
  await registry();

  const manifest = JSON.parse(await readFile(config.local.manifest, 'utf8'));
  const client = await createBitcoin({ kind: 'ord', urlFile: config.local.tapSourceFile }, { requestsPerSecond: 100 }, { network: 'regtest' });
  manifest.bitcoin = client; manifest.ordSource = client.source;
  const viewDirectory = config.local.contexts ?? config.data ?? dirname(config.local.manifest); await mkdir(viewDirectory, { recursive: true, mode: 0o700 });
  const store = suppliedStore ?? new ReadStore(config.data), trac = tracClient(config.endpoints.trac, config.local.tracToken), views = new BitcoinViews(client, join(viewDirectory, `bitcoin-ord-${suppliedStore ? 'gateway' : (config.local.readerId ?? process.pid)}.sqlite`));
  const ethRPC = rpcClient(config.endpoints.ethereum), escrow = createEscrowReader({ rpc: ethRPC, ...config.local.escrow });
  const quotedTerms = async (kind, row) => {
    const data = await registry(), configured = data[kind]; check(configured, kind + '_unconfigured');
    const { payer, hash, feeAuthorization, ...policy } = row.terms;
    const fee = await reads.feeQuotes.accepted(feeAuthorization, `${kind}/${row.id}`, row.id, row.request.until);
    check(same(policy, { ...configured, baseFee: fee.baseFee }), kind + '_policy');
    return row.terms;
  };
  const tap = async path => { const value = await client.source.request('/r/tap/' + path); check(value && Object.hasOwn(value, 'result'), 'tap_response'); return value.result; };
  const content = async id => {
    check(/^[0-9a-f]{64}i[0-9]+$/.test(id), 'inscription_id');
    return ordContent(await client.source.request('/content/' + id, { format: 'rawText', maxBytes: 200000 }));
  };
  const request = id => {
    const row = store.get('mints', id); check(row && verifyPayer(config.network, { request: row.request, receiver: row.receiver, payer: row.payer, kind: row.kind, feeQuote: row.requestedFeeQuote, authorization: row.authorization }), 'payer_authorization');
    check(rules.verifyRequest('rq', config.network, row.request, row.signature, row.request.until) && rules.pendingId(config.network, row.request) === id, 'owner_signature'); return row;
  };
  const chainView = async view => {
    if (view) return view;
    const head = await trac('head');
    check(await client.blockHash(head.tip.height) === head.tip.hash, 'bitcoin_beacon_disagreement');
    return { tip: head.tip.height, tipHash: head.tip.hash, height: head.counted };
  };
  const included = async (id, view) => {
    const at = await chainView(view), history = await views.view(at.tip, at.tipHash);
    return client.included(id, at, history);
  };
  const auditCache = new Map();
  const audits = async n => {
    const root = await trac('root', [n]); check(root, 'accepted_batch_missing');
    if (auditCache.get(n)?.root === root) return auditCache.get(n).files;
    const batch = store.get('batches', heightKey(n)); check(batch?.batch.root === root, 'accepted_batch_binding');
    const bytes = await Promise.all(batch.publications.map(p => readFile(join(config.data, 'static', p.audit.path.slice(1)))));
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
    const inscription = id.split(':')[0], payload = await content(inscription), inclusion = await included(inscription, view); check(inclusion, 'payment_unconfirmed');
    check(payload.redeem?.data === binding.requestId && lock.owner === binding.payer, 'payment_binding');
    const consumed = await tap('getLockConsume/' + id), consumption = consumed ? await included(consumed.ins, view) : null;
    return { id, requestId: binding.requestId, kind: 'tap', payer: lock.owner, total: lock.total ?? lock.amt, consumed: !!consumption, confirmations: inclusion.confirmations,
      tick: lock.tick, lockKind: lock.kind, conditionType: lock.condition.type, hash: lock.condition.hash, refund: lock.refund, claim: lock.claim, base: lock.amt,
      allocations: lock.al ?? [], refundAfter: Number(lock.refund_after) };
  };
  const bindings = new Bindings({ store, network: config.network, bitcoinNetwork: 'regtest', rosterHistory: config.rosterHistory, members: config.committee?.map(s => s.peer) });
  const reads = {
    bindings,
    feeQuotes: new FeeQuotes({ network: config.network, gateway, registry }),
    validateFeeTerms: quotedTerms,
    preflight: async (batch, at) => preflightBatch(batch, at, { read: key => trac('read', [key, at]), deployment: await trac('deployment') }),
    receiptObservation: async (tip, tipHash) => {
      const r = store.get('receiptObservations', `${tip}/${tipHash}`); check(r, 'receipt_observation_missing');
      if (!r.archive) return r;
      const bytes = await readFile(join(config.data, 'static', r.archive.path.slice(1))); check(hash(bytes) === r.archive.hash, 'receipt_archive_binding');
      return { seal: r.seal, receipts: rules.decodeBinary(bytes).receipts };
    },
    receiptCertificate: async (tip, hash) => store.get('receiptCertificates', `${tip}/${hash}`),
    tip: async () => { const info = await client.tip(), tip = info.height; await views.view(tip, info.hash); return { tip, tipHash: info.hash, highestTip: Math.max(tip, store.get('meta', 'head')?.highestTip ?? 0) }; },
    mintCertificate: async id => store.get('ceremonies', 'mint/' + id)?.result.certificate,
    manifest, client, store, trac, views, tap, content, included, registry, ethRPC, escrow,
    head: () => trac('head'), assetSupply: () => trac('assetSupply'),
    bitmaps: owner => walletBitmaps({ reads, store, manifest }, owner),
    async publicEscrow(payer, id) {
      const state = await escrow.deposit(payer, id), payerTopic = '0x' + payer.slice(2).toLowerCase().padStart(64, '0');
      const logs = await ethRPC('eth_getLogs', [{ address: state.address, fromBlock: '0x0', toBlock: state.blockNumber, topics: [null, '0x' + id, payerTopic] }]);
      check(Array.isArray(logs) && logs.length <= 3, 'escrow_event_count', 503);
      const transactions = [];
      for (const log of logs) {
        check(log.removed === false && log.address.toLowerCase() === state.address && log.topics[1]?.toLowerCase() === '0x' + id && log.topics[2]?.toLowerCase() === payerTopic, 'escrow_event_binding', 503);
        check((await ethRPC('eth_getBlockByNumber', [log.blockNumber, false]))?.hash === log.blockHash, 'escrow_event_reorg', 503);
        transactions.push({ txid: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.logIndex, topic: log.topics[0] });
      }
      return { ...state, transactions };
    },
    async publicTransactions(after, limit) {
      check(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 200, 'transaction_page');
      const at = await trac('stamp'), total = await trac('read', ['txl', at]) ?? 0, rows = [];
      check(Number.isSafeInteger(total) && total >= after, 'transaction_index_changed', 503);
      const next = Math.min(total, after + limit);
      for (let index = after; index < next; index++) {
        const row = await trac('read', [`txi/${index}`, at]); check(row, 'transaction_index_missing', 503);
        rows.push({ index, tx: row.tx, ipk: row.ipk, val: row.val, err: row.err });
      }
      return { rows, total, next };
    },
    async publicTreasury() {
      const data = await registry();
      const bitcoinAddresses = [...new Set([data.link?.treasury, ...Object.values(data.assets).map(a => a.tap?.treasury)].filter(Boolean))];
      const ethereumAddresses = [...new Set(Object.values(data.assets).map(a => a.ethereum?.treasury).filter(Boolean))];
      const tapAccounts = await Promise.all(bitcoinAddresses.map(async address => ({ address, balance: await tap('getBalance/' + address + '/tap') })));
      const ethAccounts = await Promise.all(ethereumAddresses.map(async address => ({ address, balance: BigInt(await ethRPC('eth_call', [{ to: config.local.escrow.token, data: calldata('balanceOf(address)', [['address', address]]) }, 'latest'])).toString() })));
      return { treasury: { bitcoin: bitcoinAddresses[0] ?? null, ethereum: ethereumAddresses[0] ?? null,
        tap: tapAccounts.reduce((n, r) => n + BigInt(r.balance), 0n).toString(), erc20: ethAccounts.reduce((n, r) => n + BigInt(r.balance), 0n).toString(),
        tapAccounts, ethereumAccounts: ethAccounts }, outstandingSupply: { ethereum: BigInt(await ethRPC('eth_call', [{ to: config.local.escrow.token, data: calldata('totalSupply()', []) }, 'latest'])).toString() } };
    },
    authority: () => trac('authority'), counted: async () => (await trac('head')).counted, batchLast: () => trac('batchLast'), batchRoot: n => trac('root', [n]), committeeEpoch: async () => (await trac('authority')).epoch,
    balance: (owner, asset) => trac('balance', [owner, asset]), nonceUsed: (owner, nonce) => trac('nonceUsed', [owner, nonce]), pending: id => trac('pending', [id]),
    pendingAcceptance: id => trac('acceptance', [id]), mintExit: id => trac('exit', [id]), agentAddress: id => trac('agentAddress', [id]), blockHold: (asset, block) => trac('hold', [asset, block]),
    async retireContexts(accepted) {
      for await (const entry of await opendir(config.local.contexts)) if (entry.isFile() && /^[0-9]+\.json$/.test(entry.name) && Number(entry.name.slice(0, -5)) <= accepted - 8) await removeFile(join(config.local.contexts, entry.name));
    },
    settings: () => trac('settings'), batchHeaders: async () => [], batchStamp: () => trac('stamp'),
    async batchContext(sequence) {
      const context = JSON.parse(await readFile(join(config.local.contexts, sequence + '.json'), 'utf8'));
      check(context.last.n + 1 === sequence && same(context.last, await trac('batchLast')), 'batch_sequence');
      check([config.committee.map(s => s.peer), ...(config.rosterHistory ?? []).map(r => r.members)].some(members => same(context.settings.receiptSigners, members)), 'receipt_roster_changed');
      check((context.settings.claimsPerWindow ?? rules.CLAIM_DEFAULTS.claimsPerWindow) === (config.claimsPerWindow ?? rules.CLAIM_DEFAULTS.claimsPerWindow), 'claim_budget_policy');
      const histories = []; for (const input of context.inputs) histories.push(await views.view(input.tip, input.tipHash));
      return { ...context, history: histories[0], hashAt: histories[0].hashAt, views: histories.map(history => ({ history, hashAt: history.hashAt })) };
    },
    async assetContext(asset, block, viewOrKind, payoutSnapshot, admittedId) {
      const registrations = await registry(), current = registrations.assets[asset];
      const registered = payoutSnapshot?.deploymentId ? [current, ...(registrations.generations?.[asset] ?? [])].find(e => e?.id === payoutSnapshot.deploymentId) : current; check(registered, 'asset_unregistered');
      const indexTick = registered.indexTick ?? registered.tick;
      const { deployment, authority } = await verifyDeployment(reads, registered, { view: typeof viewOrKind === 'object' ? viewOrKind : undefined });
      const auth = await content(registered.privilege), authorityHash = hash(JSON.stringify(auth.auth) + auth.salt), publicKey = recovered(authorityHash, auth.sig);
      check(auth.hash === authorityHash && publicKey === (registered.authorityKey ?? (await trac('authority')).committee), 'privilege_binding');
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
      return { deployment: { id: registered.id, generation: registered.generation ?? 1, privilege: registered.privilege, elementId: registered.elementId ?? deployment.elem ?? null, dt: registered.dt ?? deployment.dt ?? null, options: registered.options ?? {}, approval: registered.approval ?? null, kind: registered.kind, tick: registered.tick, active: true, privilegePublicKey: publicKey, decimals: deployment.dec,
        remaining: await tap('getMintTokensLeft/' + indexTick), limit: deployment.lim ?? '0' }, find: found, link, bitmapHolder: holder,
        landownerAddress, displayLabel: registered.displayLabel ?? registered.pattern?.name ?? asset, discoverer, payouts, tier: registered.pattern?.tier ?? 1, treasury: destinations.treasury,
        finderAddress: found?.finder ? address : null, firstMakerAddress: registered.kind === 'compound' ? address : null };
    },
    async bitmap(block) {
      const bitmap = await tap('getBitmap/' + block);
      check(bitmap && bitmap.bm === block && typeof bitmap.ownr === 'string', 'bitmap_missing');
      const inscription = await client.source.request('/inscription/' + bitmap.ins);
      check(inscription.address === bitmap.ownr, 'bitmap_owner');
      const owners = bindings.owners(bitmap.ownr);
      check(owners.length === 1 && /^[0-9a-f]{64}$/.test(owners[0]), 'bitmap_agent_binding');
      return { agent: owners[0], address: bitmap.ownr };
    },
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
    async isMinted(deployment, tick, block, view) { const r = await tap('getDmtMintHolderByBlock/dmt-' + tick + '/' + block); return !!r && !!await included(r.ins, view); },
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
      const p = await payment(row.paymentId, { requestId: row.id, payer: row.terms.payer }, view), inclusion = await included(row.paymentId.split(':')[0], view);
      const block = await client.block(inclusion.blockHash);
      return { ...p, verifiedHeight: inclusion.height, eventIndex: block.tx.indexOf(row.paymentId.slice(0, 64)) * 100 + Number(row.paymentId.split(':')[0].split('i')[1]) };
    },
    close() { views.close(); if (!suppliedStore) store.close(); }
  };
  installMintPayments(reads, { request, network: config.network, escrow: config.local.escrow, confirmations: 1 });
  reads.paymentUsed = key => trac('paymentUsed', [key]);
  reads.bitcoinTransaction = id => client.transaction(id);
  const mintEth = ethereumPayments({ rpc: ethRPC, escrow: config.local.escrow });
  reads.escrowSettled = (payer, id) => mintEth.settled('ethereum', id, payer);
  reads.inscription = id => client.source.request('/inscription/' + id);
  return reads;
}
export async function createReads({ config: filename, readerId, gateway }) {
  const config = JSON.parse(await readFile(filename, 'utf8'));
  if (readerId !== undefined) { check(/^[a-zA-Z0-9_-]{1,64}$/.test(readerId) && readerId !== 'gateway', 'reader_id'); config.local.readerId = readerId; }
  return localReads(config, undefined, { gateway });
}
