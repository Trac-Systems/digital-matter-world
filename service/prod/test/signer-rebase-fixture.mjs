import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ed25519 } from '../../../contract/node_modules/@noble/curves/ed25519.js';
import { AccountExecution } from '../../src/account-batch.mjs';
import { financialMintDigest, financialMintId } from '../../../rules/src/financial-mint.js';
import { reserveNonceDigest } from '../../../contract/root-accounts.js';
import { payerDigest } from '../../src/mints.mjs';
import { secp256k1 } from '../../../contract/node_modules/@noble/curves/secp256k1.js';
import { rules as r } from '../../src/rules.mjs';
import { Store } from '../../src/store.mjs';
import { temp } from '../../test/helpers.mjs';
import { hash, heightKey, edPublic } from '../../src/util.mjs';
import { buildFinancialExecution } from '../../src/financial-execution.mjs';
import { installFinancialSources } from '../../src/financial-sources.mjs';
import { financialGenerationId } from '../../src/financial-capacity-sources.mjs';
import { installFinancialChain } from '../../src/financial-chain.mjs';
import { createFinancialRebaseVerifier } from '../../src/financial-chain-provenance.mjs';
import { createAcceptedAudits } from '../../src/accepted-audits.mjs';
import { deploymentPayload } from '../../src/deployments.mjs';
import { replayFixture, first, previous } from '../../../rules/test/claims-never-close-fixture.mjs';
import { witnesses, attest } from '../../../rules/test/witness-fixture.mjs';
import { EvidenceStore, evidencePublisher } from '../evidence.mjs';
import { HttpSource } from '../http.mjs';
import { BitcoinSource } from '../bitcoin.mjs';
import { TapReader } from '../tap.mjs';
import { batchReadStamp } from '../reads.mjs';
import { readerSettings } from '../reader-settings.mjs';
import { createSigner } from '../../../committee/signer/service.mjs';
import { withLifecycle } from '../../src/lifecycle.mjs';
import { closureTimeouts } from '../../../rules/src/closure-timeouts.js';

const blockFixture = JSON.parse(await readFile(new URL('./fixtures/ord-regtest.json', import.meta.url)));
const rounded = n => Math.round(n * 10) / 10;

// All transports terminate in fixture functions except the disposable loopback
// sidecar. The signer still runs its real service, replay worker and policy.
export async function signerRebaseFixture(t, { inputs = 44, mixed = false, blockDelayMs = 0, sourceRps = 100, evidenceRps = 100 } = {}) {
  const root = await temp('signer-rebase-'), store = await Store.open(join(root, 'gateway'));
  let signer, reader, publisher, sidecar;
  t.after(async () => {
    await signer?.close(); await reader?.close(); publisher?.close();
    if (sidecar) { sidecar.closeAllConnections(); await new Promise(resolve => sidecar.close(resolve)); }
    await store.close();
  });
  const network = first.network, committeeSecret = new Uint8Array(32).fill(11), publicKey = r.bytesToHex(secp256k1.getPublicKey(committeeSecret));
  const gatewaySecret = r.hashBytes('permanent-gateway'), gateway = edPublic(gatewaySecret), identity = Buffer.from(witnesses[0].secret);
  const document = r.settingsRevision({ network, previous, effectiveBatch: '3', effectiveBitcoinWindow: '1200',
    values: { ...previous.values, claimsNeverCloseHeight: '1200', mintOperationBudget: 64 } });
  const budget = closureTimeouts(document, r.RESOURCE_PROFILE);
  const input = replayFixture(document).input, history = { ...input.history, length: 1201 };
  const baseHash = input.hashAt, hashAt = h => String(h) === String(blockFixture.height) ? blockFixture.hash : baseHash(h);
  history.hashAt = hashAt;
  const losing = { bitcoin: { height: '1199', hash: r.hash('losing-anchor') }, ethereum: null };
  const fork = { height: '1198', hash: hashAt('1198') }, at = { counted: '1200', tip: '1200', tipHash: hashAt('1200'), last: { n: '431', to: '1199' }, revision: '1' };
  const requests = new Map(), roots = new Map(), records = new Map([['fp/chain', { bitcoin: fork, ethereum: null }]]), entries = {}, payloads = {}, deploys = {};
  const txid = Object.keys(blockFixture.transactions)[1];
  const auth = { auth: { p: 'tap', op: 'token-auth', tick: 'fixture' }, salt: r.hash('privilege-salt') };
  auth.hash = hash(JSON.stringify(auth.auth) + auth.salt);
  const sig = secp256k1.sign(auth.hash, committeeSecret, { prehash: false });
  auth.sig = { r: String(sig.r), s: String(sig.s), v: String(sig.recovery) };
  const privilege = r.hash('fixture-privilege') + 'i0'; payloads[privilege] = auth;
  const transitions = [];
  for (let i = 0; i <= inputs - Number(mixed); i++) {
    const asset = 'c' + (i + 1), id = txid + 'i' + i, tick = 'fixture' + i;
    const entry = entries[asset] = { id, asset, kind: 'compound', tick, privilege, authorityKey: publicKey, options: { max: '100', dec: '0' } };
    payloads[id] = deploymentPayload(entry);
    deploys[tick] = { ins: id, tick, prv: privilege, max: '100', lim: '0', dec: '0' };
    const generation = financialGenerationId(network, asset, id);
    transitions.push({ type: 'lifecycle', id: generation, action: { type: 'deployment-open', id: generation, asset, deployment: id,
      generation: '0', previous: null, maximum: '100', limit: '0' } });
  }
  const phases = new Map(); let stats = {}, measured = false;
  const count = (key, amount = 1) => { if (measured) stats[key] = (stats[key] ?? 0) + amount; };
  const sourceFor = (kind, rate, respond) => {
    const queued = new Map();
    const transport = new HttpSource({ url: 'http://fixture.invalid', requestsPerSecond: rate, maxBytes: 16000000,
      retries: 0, timeoutMs: 15000, fetchImpl: async (url, options) => {
        const path = new URL(url).pathname, key = kind === 'evidence' ? JSON.parse(options.body).query.op : path;
        const started = queued.get(path)?.shift();
        if (started !== undefined) count(kind + 'QueueMs', performance.now() - started);
        count(kind + 'Requests'); count(kind + ':' + (kind === 'evidence' ? key : path.startsWith('/r/tap/') ? path.split('/')[3] : path.split('/').slice(0, path.startsWith('/r/') ? 3 : 2).join('/')));
        const start = performance.now(), result = await respond(path, options);
        const bytes = JSON.stringify(result); count(kind + 'Bytes', Buffer.byteLength(bytes)); count(kind + 'ResponseMs', performance.now() - start);
        return new Response(bytes, { headers: { 'content-type': 'application/json' } });
      } });
    const request = transport.request.bind(transport);
    transport.request = (path, options) => {
      if (!queued.has(path)) queued.set(path, []); queued.get(path).push(performance.now());
      return request(path, options);
    };
    return transport;
  };
  const newSources = () => {
    const source = sourceFor('indexer', sourceRps, async path => {
      if (path.startsWith('/r/blockhash/')) return hashAt(path.slice('/r/blockhash/'.length));
      if (path === '/r/blockinfo/' + blockFixture.hash) return blockFixture.info;
      if (path === '/block/' + blockFixture.hash) { if (measured && blockDelayMs) await delay(blockDelayMs); return blockFixture.block; }
      if (path.startsWith('/r/tx/')) { assert.ok(blockFixture.transactions[path.slice(6)]); return blockFixture.transactions[path.slice(6)]; }
      if (path.startsWith('/inscription/')) return { id: path.slice(13), height: blockFixture.height };
      if (path.startsWith('/content/')) { assert.ok(payloads[path.slice(9)]); return payloads[path.slice(9)]; }
      if (path === '/r/tap/getCurrentBlock') return { result: '1200' };
      if (path.startsWith('/r/tap/getDeployment/')) return { result: deploys[path.slice('/r/tap/getDeployment/'.length)] };
      if (path.startsWith('/r/tap/getPrivilegeAuthCancelled/')) return { result: false };
      if (path.startsWith('/r/tap/getMintTokensLeft/')) return { result: '100' };
      throw Error('unexpected_fixture_route:' + path);
    });
    const bitcoin = new BitcoinSource({ source, network: 'regtest' });
    const tap = new TapReader({ sources: [source], bitcoin, agreement: 1 });
    return { bitcoin, tap };
  };
  const configureReads = ({ bitcoin, tap }, evidence, context) => {
    const trac = async method => { count('notary:' + method); assert.equal(method, 'stamp'); return structuredClone(at); };
    const reads = { authority: async () => ({ network, committee: publicKey, epoch: '0' }), counted: async () => at.counted,
      batchStamp: () => batchReadStamp(trac, tap), registry: async () => ({ assets: entries }), feeQuotes: {},
      tap: path => tap.tap(path), content: id => tap.content(id), included: (id, view) => bitcoin.included(id, view, history),
      withTapSnapshot: (view, read) => tap.at(view, read), privilegeAuthority: async id => ({ ins: id }),
      batchRoot: async n => roots.get(String(n)), settingsByHash: async digest => [first, previous, document].find(d => r.hashObject(d) === digest),
      rulesContext: async () => ({ ready: true, ruleset: 'dmw-v2', manifest: context?.activation.manifest, manifestHash: context?.activation.manifestHash,
        settings: document, settingsHash: r.hashObject(document), last: at.last, catalogRoot: context?.state.catalogRoot,
        accountsRoot: context?.state.accountRoot, claimsRoot: context?.state.claimRoot }),
      preflight: async batch => ({ ok: true, counted: at.counted, last: at.last, digest: r.bytesToHex(r.batchDigest(network, batch)) }) };
    installFinancialSources(reads, { network, bitcoinNetwork: 'regtest', document, request: id => evidence ? evidence.get('mints', id) : requests.get(id),
      reservation: async () => assert.fail('unexpected reservation'), record: async key => structuredClone(records.get(key) ?? null) });
    const audits = createAcceptedAudits({ store: evidence ?? store, root: async n => { count('acceptedRootReads'); return roots.get(String(n)); },
      archive: (path, digest) => evidence ? evidence.archive(path, digest) : readFile(join(root, 'static', path.slice(1))), limits: readerSettings() });
    const bitcoinHash = async h => hashAt(h), canonicalBitcoinHash = h => bitcoin.blockHash(h);
    const verify = createFinancialRebaseVerifier({ store: evidence ?? store, audits, bitcoinHash, canonicalBitcoinHash,
      deploymentIncluded: reads.included });
    installFinancialChain(reads, { bitcoinHash, canonicalBitcoinHash, bitcoinHeader: async id => id === losing.bitcoin.hash ? { ...losing.bitcoin, parent: fork.hash } : null,
      rebaseSafe: async args => { count('rebaseCalls'); const start = performance.now(); try { return await verify(args); } finally { count('rebaseMs', performance.now() - start); } } });
    if (evidence) {
      reads.refreshEvidence = () => evidence.refresh();
      reads.batchContext = async n => ({ ...await evidence.context(n), history, hashAt });
      reads.receiptCertificate = (tip, hash, segment) => evidence.get('receiptCertificates', `${tip}/${hash}/${segment}`);
      reads.claimNode = (...args) => evidence.claimNode(...args); reads.namedNode = (...args) => evidence.namedNode(...args);
      reads.replayNodes = (...args) => evidence.replayNodes(...args);
    }
    return reads;
  };
  await mkdir(join(root, 'static', 'blocks', 'v2'), { recursive: true });
  // Authenticate the origin through the same checkpoint and operations format
  // used by the gap verifier. Later accepted credits have distinct file roots.
  const origin = transitions.shift(), originEvidence = { requestId: origin.id, state: 'deployed', confirmations: 1,
    deployment: Object.fromEntries(Object.entries(origin.action).filter(([key]) => !['type', 'id'].includes(key))), minted: '0', outstanding: '0', remaining: '100' };
  const originBuilt = await buildFinancialExecution({ store, document, height: at.counted, at, transitions: [origin],
    reads: { financialRecord: async key => records.get(key) ?? null, financialEvidence: async () => originEvidence,
      financialChainAnchor: async () => losing } });
  for (const w of originBuilt.writes) if (w.space === 'accountRecords') records.set(w.id, w.value);
  await store.transact(originBuilt.writes);
  let reservationBuilt;
  if (mixed) {
    const secret = r.hashBytes('expiring-reservation-owner'), owner = edPublic(secret), asset = 'c999', receiver = 'fixture-receiver';
    const request = { v: 2, owner, asset, amount: '3', receive: r.hash(receiver), nonce: r.hash('expired-request'),
      until: '1110', expires: '1150', settingsHash: r.hashObject(first) };
    const id = financialMintId(network, request), feeQuote = { settingsHash: request.settingsHash };
    const row = { id, request, signature: r.bytesToHex(ed25519.sign(financialMintDigest(network, request), secret)), receiver,
      payer: 'fixture-payer', kind: 'tap', requestedFeeQuote: feeQuote, quote: { feeQuote } };
    row.authorization = r.bytesToHex(ed25519.sign(payerDigest(network, { ...row, feeQuote }), secret));
    requests.set(id, row);
    const evidence = { requestId: id, owner, asset, amount: '3', request, receiver, payer: row.payer, rail: 'tap', quote: feeQuote,
      expiry: request.expires, settingsHash: request.settingsHash, fees: [{ key: r.hash('reservation-fee'), amount: '1' }] };
    const seed = new AccountExecution({ store, document, height: '1100' });
    await seed.accounts([{ type: 'credit', owner, asset, amount: '3' }]);
    for (const w of seed.result().writes) if (w.space === 'accountRecords') records.set(w.id, w.value);
    await store.transact(seed.result().writes);
    const action = { type: 'reserve-n', id, owner, asset, amount: '3', terms: r.hashObject(evidence), nonce: r.hash('reservation-nonce'), until: '1120' };
    action.sig = r.bytesToHex(ed25519.sign(reserveNonceDigest(network, action), secret));
    reservationBuilt = await buildFinancialExecution({ store, document, height: '1100', at,
      transitions: [{ type: 'reserve', id, action, fees: evidence.fees }],
      reads: { financialRecord: async key => records.get(key) ?? null, financialEvidence: async () => evidence, financialChainAnchor: async () => losing } });
    for (const w of reservationBuilt.writes) if (w.space === 'accountRecords') records.set(w.id, w.value);
    records.set('fi/source/' + id, evidence);
    await store.transact([...reservationBuilt.writes, { space: 'mints', id, value: row }, { space: 'accountRecords', id: 'fi/source/' + id, value: evidence }]);
    transitions.push({ type: 'refund', id, reason: 'credit' });
  }
  const rows = [{ space: 'financialRecordProvenance', id: 'fp/chain', value: { n: '1', file: 0, index: 0 } }];
  for (let n = 1; n <= 431; n++) {
    const file = n === 1 ? { v: 5, ops: originBuilt.inputs[0].operations, financialOperations: originBuilt.inputs } : n === 2 && reservationBuilt ?
      { v: 5, ops: reservationBuilt.operations, financialOperations: reservationBuilt.inputs } : { v: 5, observation: String(n), ops: [{ op: 'ar', v: 2, actions: [{ type: 'credits', owner: r.hash('credit-owner'), assets: [['p2:7', '1']] }] }] };
    const bytes = r.encodeBinary(file), digest = hash(bytes), path = `/blocks/v2/${n}.bin`, rootHash = r.merkleRoot([bytes]);
    await writeFile(join(root, 'static', path.slice(1)), bytes); roots.set(String(n), rootHash);
    rows.push({ space: 'batches', id: heightKey(n), value: { batch: { n: String(n), root: rootHash }, publications: [{ audit: { path, hash: digest } }] } });
  }
  await store.transact(rows);
  const gatewayReads = configureReads(newSources());
  const financial = await buildFinancialExecution({ store, reads: gatewayReads, document, height: at.counted, at, transitions });
  input.financialPlanning = false; input.accountOperations = []; input.financialOperations = financial.inputs; input.batchSequence = '432';
  input.state.accountRoot = r.hash('accepted-accounts'); input.history = history; input.hashAt = hashAt;
  input.rootAttestations = attest(input.receiptRoot);
  const output = r.processBlockV2(input);
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '1', previousBatchRoot: r.hash('initial-root'),
    bitcoinAnchor: { height: '0', hash: hashAt('0') }, settingsHash: r.hashObject(first), catalogRoot: input.state.catalogRoot,
    accountsRoot: input.state.accountRoot, receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const activation = { sequence: '1', previousRoot: manifest.previousBatchRoot, height: '0', hash: hashAt('0'), ruleset: 'dmw-v2', settingsRevision: '0',
    settingsHash: manifest.settingsHash, manifest, manifestHash: r.hashObject(manifest) };
  const built = r.buildBatchV2({ network, epoch: '0', sequence: '432', lastTo: at.last.to, previousRoot: roots.get('431'), files: [output.file],
    executionHeight: at.counted, executionHash: at.tipHash, settings: input.settings, activation, catalogRoot: output.state.catalogRoot, accountRoot: output.state.accountRoot });
  const proposal = { network, kind: 'batch', batch: built.batch, files: built.fileBytes.map(r.bytesToHex) };
  const { state, settings, history: _history, hashAt: _hashAt, ...wire } = input;
  const context = { state, settings, gateway, patterns: {}, inputs: [wire], counted: at.counted, last: at.last, previousRoot: roots.get('431'), activation };
  const contextBytes = Buffer.from(JSON.stringify(context)), contextHash = hash(contextBytes);
  await writeFile(join(root, contextHash + '.json'), contextBytes);
  await store.transact([{ space: 'evidenceContexts', id: '432', value: { path: contextHash + '.json', hash: contextHash } },
    { space: 'receiptCertificates', id: `${at.tip}/${at.tipHash}/0`, value: { seal: input.receiptRoot, attestations: input.rootAttestations } }]);
  const evidenceSettings = { maxAgeMs: budget.evidenceMs, requestsPerSecond: evidenceRps };
  publisher = evidencePublisher({ config: { network, epoch: 0, data: root, committee: [{ id: witnesses[0].id, peer: { identity: edPublic(identity) } }],
    prod: { contexts: root, evidenceSettings } }, store, reads: { trac: async () => at }, secret: gatewaySecret });
  sidecar = createServer(async (req, res) => { for await (const _ of req) {} res.end(JSON.stringify({ public: publicKey, epoch: 0, retired: false })); });
  await new Promise(resolve => sidecar.listen(0, '127.0.0.1', resolve));
  const openSigner = async () => {
    reader = await EvidenceStore.open({ config: { directory: join(root, 'reader'), network, epoch: 0, member: witnesses[0].id, settings: evidenceSettings },
      identity: Buffer.from(identity), gateway, clock: async () => at, stamp: async () => at,
      source: sourceFor('evidence', evidenceRps, (_path, options) => publisher(JSON.parse(options.body))) });
    const reads = configureReads(newSources(), reader, context);
    signer = await withLifecycle({ onPhase: ({ phase, ms }) => { if (measured) phases.set(phase, (phases.get(phase) ?? 0) + ms); } }, () =>
      createSigner({ directory: join(root, 'signer'), network, id: witnesses[0].id, epoch: 0, members: witnesses.map(({ id, identity }) => ({ id, identity })), gateway,
        resources: { values: r.RESOURCE_PROFILE },
        sidecar: `http://127.0.0.1:${sidecar.address().port}` }, { identity: identity.toString('hex'), journalKey: 'disposable-fixture-journal', sidecarToken: 'disposable-fixture-token' }, reads));
  };
  await openSigner();
  let attempt = 0;
  return { proposal, financial, budget, async prepare() {
    stats = {}; phases.clear(); at.revision = String(BigInt(at.revision) + 1n); measured = true; const start = performance.now(), id = r.hash('attempt/' + ++attempt); let prepared = false;
    try {
      const result = await signer.handle('/prepare', { proposal, ceremony: { id, epoch: 0,
        peers: witnesses.slice(0, 3).map(({ id, identity }) => ({ id, identity })) } });
      prepared = true; assert.equal(result.digest, r.bytesToHex(built.signingDigest));
      return { ms: rounded(performance.now() - start), phases: Object.fromEntries([...phases].map(([k, v]) => [k, rounded(v)])),
        counts: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, rounded(v)])), digest: result.digest, proposalHash: r.hashObject(proposal) };
    } finally { measured = false; if (prepared) await signer.handle('/abort', { id }); }
  }, async restart() { await signer.close(); await reader.close(); await openSigner(); } };
}
