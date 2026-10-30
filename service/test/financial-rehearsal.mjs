import { DecimalBitcoinViews } from '../prod/bitcoin-decimal.mjs';
// Shared real paid rehearsal for the standalone runner and LT1 load harness.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import { bitcoin, rpc as chainRPC, mine, receiveAddress, sleep } from '../../local/common.mjs';
import { inscribe, sendInscription } from '../../local/inscriber.mjs';
import { authority, redeem, testKey } from '../../local/protocol.mjs';
import { createGroup, startSidecar, stopChild, ceremony, descriptor, randomHex } from '../../committee/tss.mjs';
import { createSigner } from '../../committee/signer/service.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';
import { REGTEST_PARAMS, parseHeader, workFor } from '../../contract/beacon/bitcoin.js';
import { harness, alice } from '../../contract/tests/helpers/harness.mjs';
import { batchDigest } from '../../contract/signing.js';
import { rules as r, initialState } from '../src/rules.mjs';
import { hash, edPublic, heightKey } from '../src/util.mjs';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Committee } from '../src/committee.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Outbox } from '../src/transport.mjs';
import { createV2Runtime, installGatewayActivation } from '../src/v2-runtime.mjs';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
import { createBitcoin } from '../prod/bitcoin.mjs';
import { initializeHeaderReader } from '../prod/header-bootstrap.mjs';
import { TapReader } from '../prod/tap.mjs';
import { TapLookupIndex, installTapLookups } from '../prod/tap-index.mjs';
import { installFinancialSources, acceptedFinancialReservation } from '../src/financial-sources.mjs';
import { installFinancialChain } from '../src/financial-chain.mjs';
import { verifyDeployment, deploymentPayload } from '../src/deployments.mjs';
import { FeeQuotes, createFeePolicy } from '../src/fees.mjs';
import { winningMint } from '../src/mint-evidence.mjs';
import { serve } from '../src/http.mjs';
import { Agent } from '../../kit/lib/agent.mjs';
import { Journal } from '../../kit/lib/journal.mjs';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { Feeds } from '../src/feeds.mjs';

export async function probeLegacyLink({ service, store, network, request, secret, payer }) {
  const sig = r.signLink(network, request, secret), before = store.sequence;
  assert.ok(ed25519.verify(r.hexToBytes(sig), r.paymentDigest(network, request), r.hexToBytes(request.owner)));
  await assert.rejects(service.request('/link/request', { value: { request, sig, payer, paymentHash: r.hash('lt1-link-payment') } }),
    error => error.status === 400 && error.code === 'financial_link_signature');
  assert.equal(store.sequence, before, 'legacy_link_refusal_wrote_state');
  return { status: 400, code: 'financial_link_signature', writes: 0, scope: 'new legacy-format packet refused after v2 activation; retained pre-activation jobs are tested separately' };
}

export async function financialRehearsal({ stack, directory, tssPort, checkpoint = async () => {}, recordPID = () => {}, checkLegacyLink = fn => fn(),
  createContract = deployment => harness(deployment), paidBatches = false }) {
assert.equal(stack.bitcoin.network, 'regtest');
assert.equal(await chainRPC(stack.ethereum.rpc, 'eth_chainId'), '0x7a69');
const network = 'dmw-regtest', epoch = 1, secret = Buffer.alloc(32, 93), gateway = edPublic(secret);
await mkdir(directory, { recursive: true, mode: 0o700 });
const sourceFile = join(directory, 'source.url'); await writeFile(sourceFile, stack.ord.url, { mode: 0o600 });
const children = [], services = [], readers = []; let store, pipeline, http, journal, contract;
const recorded = { readerBootstrap: [], signers: 5, readerClients: 0, rail: 'tap', notary: 'actual StateTransition with disposable legacy compound bootstrap', checks: [] };
const pass = s => { recorded.checks.push(s); console.log('PASS', s); };
try {
  const group = await createGroup(join(directory, 'committee'), { port: tssPort, network, epoch });
  for (const member of group) children.push(await startSidecar(member, async pid => { recordPID(pid); }));
  const { publicKey } = await ceremony(group, 'keygen', { network, epoch });
  pass('five independent threshold shares generated');
  const sign = digest => ceremony(group.slice(0, 3), 'sign', { network, epoch, digest });
  const payer = await receiveAddress(stack), treasury = await receiveAddress(stack), maker = await receiveAddress(stack), receiver = await receiveAddress(stack);
  const inscription = async (text, address = payer) => {
    const result = await inscribe(stack, [{ text, receiver: address }]); await mine(stack); return result.inscriptions[0].id;
  };
  const privilege = { p: 'tap', op: 'privilege-auth', auth: { name: 'dmw-mg3' }, salt: randomHex() };
  privilege.hash = hash(JSON.stringify(privilege.auth) + privilege.salt);
  const signature = await sign(privilege.hash); privilege.sig = { r: signature.r, s: signature.s, v: String(signature.v) };
  const privilegeId = await inscription(privilege); await sendInscription(stack, privilegeId, payer); await mine(stack);
  const entry = { asset: 'c1', kind: 'compound', tick: 'dmwmg' + Date.now().toString(36), privilege: privilegeId, authorityKey: publicKey, options: { max: '100', dec: '0' } };
  entry.id = await inscription(deploymentPayload(entry));
  await inscription({ p: 'tap', op: 'token-deploy', tick: 'tap', max: '1000000', dec: '18' });
  await inscription({ p: 'tap', op: 'token-mint', tick: 'tap', amt: '1000' });
  const payerKey = testKey(), authId = await inscription(authority(payerKey)); await sendInscription(stack, authId, payer); await mine(stack);
  const bitmapBlock = String((await bitcoin(stack, 'getblockcount')) - 1), bitmapId = await inscription(bitmapBlock + '.bitmap');
  pass('real TAP fee supply, Bitmap and threshold-authorized compound deployment indexed');
  const raw = [], headers = [];
  const updateHeaders = async () => {
    const tip = await bitcoin(stack, 'getblockcount');
    for (let h = raw.length; h <= tip; h++) { raw.push(await bitcoin(stack, 'getblockheader', [await bitcoin(stack, 'getblockhash', [h]), false])); headers.push(r.parseHeader(raw[h], h)); }
    return tip;
  };
  const height = await updateHeaders(), genesis = parseHeader(raw[0]);
  const headerSeed = join(directory, 'headers.bin'), headerBytes = Buffer.from(raw.join(''), 'hex');
  await writeFile(headerSeed, headerBytes, { mode: 0o600 });
  recorded.headerSeed = { headers: raw.length, sha256: hash(headerBytes), independentlyVerifiedReaders: 0 };
  const options = { network, committee: publicKey, admin: alice.address,
    beacon: { params: REGTEST_PARAMS, checkpoint: { height: 0, hash: genesis.hash, bits: genesis.bits, time: genesis.time, chainwork: workFor(genesis.bits).toString() } } };
  const history = { get length() { return raw.length; }, raw: h => raw[h], get: h => headers[h], hashAt: h => headers[h]?.hash ?? null,
    field: (h, f, dt = 'n') => (f === 4 ? h : f === 10 ? headers[h].nonce : headers[h].bits).toString(dt === 'h' ? 16 : 10) };
  const legacy = harness(options);
  for (let h = 1; h <= height; h += 20) assert.equal(await legacy.run('hd', { headers: raw.slice(h, h + 20) }), null);
  const initial = { v: 1, epoch: 0, n: 1, from: 1, to: height, deadline: height + 6, root: hash('legacy-bootstrap'), ops: [{ op: 'mk', to: alice.address, asset: 'c1', amount: '100' }] };
  initial.sig = (await sign(Buffer.from(batchDigest(network, initial)).toString('hex'))).compact;
  assert.equal(await legacy.run('bt', initial), null);
  const imported = prepareTerminalImport({ records: legacy.db, height });
  const registry = { feePolicy: createFeePolicy('1000000000000000000'), assets: { c1: entry }, link: { treasury } };
  const document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: String(height), values: { ...r.SETTINGS_PROFILE, puzzleBits: 0, feePolicyRevision: registry.feePolicy.current, linkMultiplier: r.FEE_DEFAULTS.link } });
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2', previousBatchRoot: initial.root,
    bitcoinAnchor: { height: String(height), hash: history.hashAt(height) }, settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(r.emptyNamedDiscovery()),
    accountsRoot: imported.financialRoot, receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const manifestHash = r.hashObject(manifest);
  contract = await createContract({ ...options, v2: { manifest, manifestHash, document, importRoot: imported.importRoot, importRows: imported.importRows } });
  for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
  if (contract.begin) await contract.begin();
  store = await Store.open(join(directory, 'gateway'));
  await store.put('meta', 'ruleState', initialState(height, history.hashAt(height), height));
  await installGatewayActivation({ store, manifest, manifestHash, document, imported, named: r.emptyNamedDiscovery() });
  const stamp = async () => { const h = await contract.state().head(); return { counted: h.counted, revision: h.revision, tip: h.tip.height, tipHash: h.tip.hash, last: await contract.state().batchLast() }; };
  const rulesContext = async () => ({ ready: true, ruleset: 'dmw-v2', manifest, manifestHash, settings: document, settingsHash: manifest.settingsHash,
    last: await contract.state().batchLast(), catalogRoot: contract.db.get('v2/catalog'), accountsRoot: contract.db.get('v2/accounts'), claimsRoot: contract.db.get('v2/claims') });
  const makeReads = async label => {
    const client = await createBitcoin({ kind: 'ord', urlFile: sourceFile }, { requestsPerSecond: 100 }, { network: 'regtest' });
    const views = new DecimalBitcoinViews(client, join(directory, label + '-headers.sqlite'));
    // Bootstrap each independent source before accepting player HTTP requests.
    // The load stack already has >1,000 blocks; cold verification belongs here,
    // not inside a quote with the kit's ordinary request deadline.
    readers.push({ close: () => views.close() });
    const started = performance.now(); await checkpoint();
    await views.seed(headerSeed, { sha256: recorded.headerSeed.sha256 });
    const indexer = new TapReader({ sources: [client.source], agreement: 1, bitcoin: client });
    const bootstrap = await initializeHeaderReader({ client, indexer, views });
    recorded.headerSeed.independentlyVerifiedReaders++;
    recorded.readerBootstrap.push({ reader: label, ...bootstrap, height: bootstrap.bitcoin.height, ms: performance.now() - started });
    const lookup = new TapLookupIndex({ indexer, filename: join(directory, label + '-lookups.sqlite') });
    readers.push({ close: () => lookup.close() });
    await lookup.advance(lookup.watch('privilege')); // Explicit bootstrap, before admitting player work.
    const reads = installTapLookups({ registry: async () => registry, counted: async () => (await stamp()).counted, batchStamp: stamp, rulesContext,
      authority: async () => ({ network, committee: publicKey, epoch: 0 }), committeeEpoch: async () => 0,
      tip: async () => { const s = await stamp(); return { tip: s.tip, highestTip: s.tip }; }, batchLast: async () => (await stamp()).last,
      bitmap: async block => { const bitmap = await indexer.tap('getBitmap/' + block); assert.equal(String(bitmap.bm), block); assert.equal(bitmap.ins, bitmapId);
        const indexed = await indexer.inscription(bitmap.ins); assert.equal(indexed.address, bitmap.ownr); assert.equal(bitmap.ownr, payer); return { agent: alice.address, address: payer }; },
      link: async block => { const value = contract.db.get('k/link/' + BigInt(block).toString(36)); return value ? JSON.parse(value) : null; },
      settingsByHash: async hash => contract.db.get('v2/settings/' + hash),
      batchRoot: async n => contract.db.get('bt/' + n) ?? null, tap: p => indexer.tap(p), content: id => indexer.content(id),
      included: async (id, at) => { at ??= await stamp(); return client.included(id, at, await views.view(at.tip, at.tipHash)); },
      receiptObservation: async (tip, h, segment) => store.get('receiptObservations', `${tip}/${h}/${segment}`),
      receiptCertificate: async (tip, h, segment) => store.get('receiptCertificates', `${tip}/${h}/${segment}`),
      batchContext: async () => { const draft = await pipeline.loadDraft(); return { authority: { epoch: 0 }, counted: draft.execution, gateway, state: draft.startState,
        patterns: draft.startPatterns, inputs: draft.items.map(i => i.input), history, hashAt: history.hashAt, settings: draft.settings, limits: draft.limits,
        last: draft.last, activation: draft.activation, previousRoot: draft.previousRoot }; },
      preflight: (batch, at) => preflightBatch(batch, at, { read: key => contract.db.get(key), deployment: contract.options }),
      feeQuotes: new FeeQuotes({ network, gateway, ...(label === 'gateway' ? { secret } : {}), registry: async () => registry }) }, lookup);
    reads.assetContext = async (_asset, _block, at) => {
      const { deployment } = await verifyDeployment(reads, entry, { view: typeof at === 'object' ? at : undefined });
      return { deployment: { ...entry, active: true, privilegePublicKey: publicKey, decimals: Number(deployment.dec), remaining: await reads.tap('getMintTokensLeft/' + entry.tick), limit: '0' },
        tier: 1, treasury, firstMakerAddress: maker, payouts: { firstMaker: null }, find: null, link: null };
    };
    const audits = async n => {
      const row = store.get('batches', heightKey(n)); assert.equal(row.batch.root, contract.db.get('bt/' + n));
      const bytes = await Promise.all(row.publications.map(p => readFile(join(store.directory, 'static', p.audit.path.slice(1)))));
      assert.equal(r.merkleRoot(bytes), row.batch.root); return bytes.map(b => r.decodeBinary(b));
    };
    installFinancialSources(reads, { network, document, bitcoinNetwork: 'regtest', recoveryVersion: 2, request: id => store.get('financialLinks', id) ?? store.get('mints', id),
      reservation: id => acceptedFinancialReservation({ store, audits, id }), record: key => contract.db.get(key) });
    installFinancialChain(reads, { bitcoinHash: async (height, at) => (await views.view(at.tip, at.tipHash)).hashAt(height),
      canonicalBitcoinHash: height => client.blockHash(height) });
    reads.mint = async (id, at) => { const row = store.get('mints', id); return winningMint(reads, row, { id: row.mintInscription }, (digest, sig) => {
      return secp256k1.Signature.fromCompact(['r', 's'].map(k => BigInt(sig[k]).toString(16).padStart(64, '0')).join('')).addRecoveryBit(Number(sig.v)).recoverPublicKey(digest).toHex(true);
    }, at); };
    recorded.readerClients++; return reads;
  };
  const clients = [], configurations = [];
  for (const member of group) {
    const base = JSON.parse(await readFile(join(member.directory, 'credentials.json')));
    const secrets = { identity: base.identity, encryption: base.encryption, apiToken: randomHex(), sidecarToken: member.token, passphrase: randomHex(), journalKey: randomHex() };
    const config = { id: member.id, network, epoch, gateway, publicKey, directory: member.directory, sidecar: member.url, members: group.map(descriptor), assetRecoveryVersion: 2, resources: r.resourceRevision({ operator: 'mg8-rehearsal', values: { ...r.RESOURCE_PROFILE } }) };
    const reads = await makeReads(member.id);
    configurations.push({ config, secrets, reads });
    const service = await createSigner(config, secrets, reads);
    const server = createServer(async (req, res) => { try {
      assert.equal(req.headers.authorization, 'Bearer ' + secrets.apiToken); const chunks = []; for await (const chunk of req) chunks.push(chunk);
      res.end(JSON.stringify(await service.handle(req.url, JSON.parse(Buffer.concat(chunks)))));
    } catch (e) { res.writeHead(409); res.end(JSON.stringify({ error: e.message })); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    clients.push({ id: member.id, url: 'http://127.0.0.1:' + server.address().port, token: secrets.apiToken, peer: descriptor(member) });
    services.push({ service, server });
  }
  const reads = await makeReads('gateway'), committee = new Committee({ store, network, signers: clients, epoch, assetRecoveryVersion: 2 });
  const config = { mode: 'regtest', network, committee: clients, assetRecoveryVersion: 2, assetResources: {}, v2: { manifest, manifestHash, document, resources: r.resourceRevision({ operator: 'mg3-local', values: { ...r.RESOURCE_PROFILE } }) } };
  const runtime = await createV2Runtime({ config, store, secret, history, reads, committee });
  const files = new Files(join(store.directory, 'static'));
  pipeline = new Pipeline({ store, files, history, intake: runtime.intake, reads, committee, financial: runtime.financial, settings: runtime.settings,
    outbox: new Outbox({ store, fallbackMs: contract.transport ? (paidBatches ? 0 : 5000) : 100000, retryMs: contract.transport ? 1000 : 0, transport: contract.transport ?? { prepareMessage: async (op, value) => ({ op, value }),
      sendMessage: async m => { assert.equal(await contract.run(m.op, m.value), null); },
      status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) } }) });
  const observe = async () => { const s = await stamp(); await runtime.intake.observe({ tip: s.tip, hash: s.tipHash, counted: s.counted, confirmed: s.counted, revision: s.revision }); };
  await observe(); http = await serve({ intake: runtime.intake, files, mints: runtime.mints, links: runtime.links, web: { handle: async () => false } });
  journal = await Journal.open(join(directory, 'kit'), network, { intervalMs: 0 });
  const service = new ServiceClient({ origin: http.url, network, gateway, receiptSigners: group.map(descriptor) });
  const agent = new Agent({ wallet: { publicKey: alice.address, sign: bytes => ed25519.sign(bytes, alice.secret) }, network, service, journal, dryRun: false, bitcoinNetwork: 'regtest',
    trac: { network, settings: async () => ({ ruleset: 'dmw-v2' }), rulesContext, settingsByHash: reads.settingsByHash, head: () => contract.state().head() } });
  recorded.legacyLinkAdmission = await checkLegacyLink(() => probeLegacyLink({ service, store, network,
    request: { owner: alice.address, height: 1, nonce: r.hash('lt1-link'), until: height + 100 }, secret: alice.secret, payer }));
  pass('legacy link packet refused by the enabled v2 route with financial_link_signature and no writes');
  const requestMint = service.requestMint.bind(service); let loseResponse = true;
  service.requestMint = async body => { const result = await requestMint(body); if (body.reserve && loseResponse) { loseResponse = false; throw Error('simulated_response_loss'); } return result; };
  const mintIntent = { actionId: 'paid-regtest', asset: 'c1', amount: '3', receiver, payer, kind: 'tap', compound: true };
  let id;
  const progress = async until => {
    for (let i = 0; i < 600; i++) {
      await checkpoint();
      // Production schedules deployment registration separately from mint work.
      await runtime.mints.deploymentTick();
      await pipeline.tick(); if (await until()) return;
      await runtime.mints.tick(); await runtime.links.tick(); if (await until()) return;
      await sleep(100);
    }
    throw Error('financial_progress_timeout:' + store.get('mints', id)?.lastError + ':' + JSON.stringify(store.list('financialDeferred', { limit: 10 })));
  };
  const pendingDeployment = await agent.makeReal(mintIntent);
  assert.equal(pendingDeployment.state, 'deployment_pending');
  assert.equal(pendingDeployment.signed, false);
  assert.equal(pendingDeployment.payable, false);
  assert.deepEqual(pendingDeployment.blocked, ['financial_deployment_pending']);
  assert.equal(journal.get('mint/' + mintIntent.actionId), null);
  assert.deepEqual(pendingDeployment.next, [{ tool: 'mint_on_chain', arguments: mintIntent }]);
  await progress(() => !!store.get('accountRecords', 'fd/asset/c1')); pass('threshold batch registers independently verified pristine deployment generation');
  await assert.rejects(agent.makeReal(mintIntent), /simulated_response_loss/);
  journal.close(); journal = agent.journal = await Journal.open(join(directory, 'kit'), network, { intervalMs: 0 });
  const accepted = await agent.makeReal(mintIntent);
  id = accepted.request.requestId;
  await progress(() => runtime.mints.public(id).payable); pass('kit journal restart retries both original packets; threshold batch and notary accept one reservation');
  const fees = store.get('mints', id).quote.fees, result = await inscribe(stack, [{ text: redeem(authId, [], payerKey, { items: r.walletFeeItems(fees, 'regtest') }), receiver: payer }]);
  const paymentId = result.inscriptions[0].id;
  await assert.rejects(service.reportMintPayment({ id, paymentId })); pass('unconfirmed real payment refused');
  await mine(stack); const tip = await updateHeaders();
  assert.equal(await contract.run('hd', { headers: raw.slice(height + 1, tip + 1) }), null); await observe();
  await service.reportMintPayment({ id, paymentId });
  await progress(() => contract.db.get('fp/' + id)?.state === 'consumed');
  pass('canonical one-confirmation TAP pages funded and account units consumed');
  // Persist the signer's completed result, then simulate a gateway crash before
  // its result checkpoint or player delivery. Restart every policy service.
  let signed;
  for (let i = 0; i < 200 && !signed; i++) { signed = await committee.signature('mint/' + id, { network, kind: 'mint', version: 2, request: store.get('mints', id).request,
    signature: store.get('mints', id).signature, receiver }); if (!signed) await sleep(100); }
  assert.ok(signed); const session = store.get('ceremonies', 'mint/' + id);
  const { result: completed, ...running } = session; await store.put('ceremonies', 'mint/' + id, { ...running, stage: 'running' });
  for (const s of services) await s.service.close();
  for (let i = 0; i < services.length; i++) {
    const { config, secrets, reads } = configurations[i]; services[i].service = await createSigner(config, secrets, reads);
  }
  // HTTP closures above intentionally hold a mutable holder below on restart.
  // Recover through fresh HTTP endpoints, preserving the same signer IDs/keys.
  for (let i = 0; i < services.length; i++) {
    const s = services[i], { secrets } = configurations[i]; s.server.closeAllConnections(); await new Promise(resolve => s.server.close(resolve));
    s.server = createServer(async (req, res) => { try { assert.equal(req.headers.authorization, 'Bearer ' + secrets.apiToken); const chunks = []; for await (const c of req) chunks.push(c);
      res.end(JSON.stringify(await s.service.handle(req.url, JSON.parse(Buffer.concat(chunks))))); } catch (e) { res.writeHead(409); res.end(JSON.stringify({ error: e.message })); } });
    await new Promise(resolve => s.server.listen(0, '127.0.0.1', resolve)); clients[i].url = 'http://127.0.0.1:' + s.server.address().port;
  }
  runtime.mints.committee = new Committee({ store, network, signers: clients, epoch, assetRecoveryVersion: 2 });
  await runtime.mints.tick(); assert.equal(runtime.mints.public(id).state, 'permit_issued', store.get('mints', id).lastError);
  assert.deepEqual(runtime.mints.public(id).permit, signed.payload); await runtime.mints.tick(); assert.equal(store.count('financialPermitDelivery'), 1);
  pass('all five signer services restarted; original detached signature recovered and delivered once');
  const mintedId = await inscription(runtime.mints.public(id).permit, receiver), end = await updateHeaders();
  assert.equal(await contract.run('hd', { headers: raw.slice(tip + 1, end + 1) }), null);
  await observe(); await runtime.refresh();
  await service.reportMintPayment({ id, inscription: mintedId }); await progress(() => runtime.mints.public(id).state === 'minted');
  assert.equal(contract.db.get('dc/' + id).state, 'minted');
  assert.equal(contract.db.get('fd/' + contract.db.get('fd/asset/c1')).minted, '3');
  pass('real ord-TAP mint accepted; completion verified by named inscription only');
  const requestLink = service.requestLink.bind(service); let loseLinkResponse = true;
  service.requestLink = async body => { const result = await requestLink(body); if (body.reserve && loseLinkResponse) { loseLinkResponse = false; throw Error('simulated_link_response_loss'); } return result; };
  const linkIntent = { actionId: 'paid-link-regtest', height: bitmapBlock, payer };
  await assert.rejects(agent.linkBitmap(linkIntent), /simulated_link_response_loss/);
  journal.close(); journal = agent.journal = await Journal.open(join(directory, 'kit'), network, { intervalMs: 0 });
  const link = await agent.linkBitmap(linkIntent), linkId = link.request.id;
  assert.equal((await service.linkStatus(linkId)).payable, false);
  await progress(async () => (await runtime.links.public(linkId)).payable);
  const linkFees = store.get('financialLinks', linkId).quote.fees;
  const linkPayment = await inscribe(stack, [{ text: redeem(authId, [], payerKey, { items: r.walletFeeItems(linkFees, 'regtest') }), receiver: payer }]);
  const linkPaymentId = linkPayment.inscriptions[0].id;
  await assert.rejects(service.reportLinkPayment({ id: linkId, paymentId: linkPaymentId }));
  await mine(stack); const linkTip = await updateHeaders();
  assert.equal(await contract.run('hd', { headers: raw.slice(end + 1, linkTip + 1) }), null); await observe();
  await service.reportLinkPayment({ id: linkId, paymentId: linkPaymentId });
  await progress(async () => (await runtime.links.public(linkId)).state === 'accepted');
  assert.equal(contract.db.get('fl/' + linkId).state, 'complete');
  assert.equal(JSON.parse(contract.db.get('k/link/' + BigInt(bitmapBlock).toString(36))).block, bitmapBlock);
  assert.equal(store.count('financialPendingLinks'), 0);
  pass('real one-confirmation TAP paid link completes through kit, native readers, five HTTP signers/TSS and accepted notary');
  const feeds = new Feeds({ store, files, history, reads: {}, settings: { feedEventRows: 8 } });
  while (store.count('feedEvents') || store.count('feedBlockChanges')) await feeds.events();
  let publicSourceCalls = 0;
  const publicAPI = createPublicAPI({ views: { store, reads: new Proxy({}, { get() { publicSourceCalls++; throw Error('public_source_request'); } }) }, files });
  const mintPage = await publicAPI.read('/results/mints?state=minted');
  assert.equal(mintPage.mints.length, 1); assert.equal(mintPage.mints[0].inscription, mintedId);
  assert.equal((await publicAPI.read('/results/links')).links[0].block, bitmapBlock);
  const paymentPage = await publicAPI.read('/results/payments');
  assert.equal(paymentPage.payments.length, fees.length + linkFees.length);
  assert.ok(paymentPage.payments.every(row => [paymentId, linkPaymentId].includes(row.reference) && /^[1-9][0-9]*$/.test(row.block)));
  assert.equal((await publicAPI.read('/results')).burn.tap,
    [...fees, ...linkFees].filter(f => f.role === 'burn').reduce((n, f) => n + BigInt(f.amount), 0n).toString());
  assert.equal(publicSourceCalls, 0); recorded.publicPageSourceCalls = publicSourceCalls;
  pass('actual paid mint/link receipts and burn totals appear on public projection pages with zero source calls');
  recorded.acceptedV2Batches = String(BigInt((await contract.state().batchLast()).n) - 1n);
  recorded.request = id; recorded.payment = paymentId; recorded.mint = mintedId;
  recorded.link = { id: linkId, bitmap: bitmapId, block: bitmapBlock, payment: linkPaymentId };

} finally {
  if (contract?.measure) { try { recorded.physicalTrac = await contract.measure(); } catch (error) { recorded.physicalTrac = { measured: false, error: error.message }; } }
  await http?.close(); await pipeline?.close(); journal?.close();
  for (const s of services) { s.server.closeAllConnections(); await new Promise(resolve => s.server.close(resolve)); await s.service.close(); }
  for (const r of readers.toReversed()) r.close(); await store?.close();
  for (const child of children.toReversed()) await stopChild(child);
  await contract?.close?.();
  recorded.processesStopped = true; await writeFile(join(directory, 'results.json'), JSON.stringify(recorded, null, 2)); console.log('Evidence:', directory);
}
return recorded;
}
