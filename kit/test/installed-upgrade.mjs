// Run explicitly with DMW_INSTALLED_KIT pointing to an unmodified public
// bafea17 archive and DMW_UPGRADE_OUTPUT to a new disposable directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as r from '../../rules/src/index.js';
import { KIT_UPGRADE_CODE, KIT_VERSION } from '../../rules/src/kit-release.js';
import { harness, deployment, committeeSecret } from '../../contract/tests/helpers/harness.mjs';
import { chain, parseHeader } from '../../contract/tests/helpers/chain.mjs';
import { REGTEST_PARAMS, workFor } from '../../contract/beacon/bitcoin.js';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import { Agent } from '../lib/agent.mjs';
import { upgradeConfig } from '../lib/upgrade.mjs';
import { TracClient } from '../lib/trac.mjs';
import { Journal } from '../lib/journal.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { unlock, wipeWallet, publicKey } from '../lib/keyring.mjs';
import { loadRegtestHistory } from '../lib/headers.mjs';
import { Store } from '../../service/src/store.mjs';
import { Files } from '../../service/src/files.mjs';
import { Intake } from '../../service/src/intake.mjs';
import { Links } from '../../service/src/links.mjs';
import { WebCheckout, linkWalletMessage } from '../../service/src/web-checkout.mjs';
import { createWeb } from '../../service/src/web.mjs';
import { serve } from '../../service/src/http.mjs';
import { initialState } from '../../service/src/rules.mjs';
import { prepareFinancialMigration } from '../../service/src/pending-financial.mjs';
import { preparePendingWork, legacyGatewayRows } from '../../service/src/pending-work.mjs';
import { prepareTerminalImport } from '../../service/src/terminal-import.mjs';
import { installGatewayActivation, createV2Runtime } from '../../service/src/v2-runtime.mjs';
import { installFinancialSources } from '../../service/src/financial-sources.mjs';
import { Pipeline } from '../../service/src/pipeline.mjs';
import { Outbox } from '../../service/src/transport.mjs';
import { FeeQuotes, createFeePolicy } from '../../service/src/fees.mjs';
import { bindingFixture } from '../../service/test/bindings-fixture.mjs';
import { signTestPayout, testPayoutAddress } from '../../service/test/payout-wallets.mjs';
import { rebuildBatch } from '../../committee/signer/adapter.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { Journal as SignerJournal } from '../../committee/signer/journal.mjs';
import { ReceiptFences } from '../../committee/signer/receipt-fences.mjs';
import { hash, edPublic } from '../../service/src/util.mjs';

const baseline = 'bafea1723fb1d5bd7a0526344d56cd8e6ca0b3bd';
test('unmodified installed kit refuses v2; the same wallet, journal, cache and paid intent resume without a wipe', { timeout: 180000 }, async t => {
  const installed = resolve(process.env.DMW_INSTALLED_KIT), directory = resolve(process.env.DMW_UPGRADE_OUTPUT);
  await mkdir(directory, { mode: 0o700 });
  const git = promisify(execFile), source = process.env.DMW_LEGACY_REPOSITORY;
  const { stdout } = await git('git', ['-C', source, 'ls-tree', '-rz', baseline], { maxBuffer: 8 * 1024 ** 2 });
  const entries = stdout.split('\0').filter(Boolean).map(line => { const [mode, type, oid, ...names] = line.replace('\t', ' ').split(' '); return { mode, type, oid, name: names.join(' ') }; });
  const verifyInstalled = async () => {
    for (const e of entries) {
      assert.equal(e.type, 'blob'); const bytes = await readFile(join(installed, e.name));
      assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), e.oid, `unmodified ${e.name}`);
    }
  };
  await verifyInstalled();
  const old = async file => import(pathToFileURL(join(installed, 'kit/lib', file)));
  const [{ Agent: OldAgent }, { Journal: OldJournal }, { ServiceClient: OldClient }, oldKeys, oldHeaders, { setup: oldSetup }] = await Promise.all(
    ['agent.mjs', 'journal.mjs', 'service-client.mjs', 'keyring.mjs', 'headers.mjs', 'setup.mjs'].map(old));
  const network = 'dmw-regtest', secret = r.hashBytes('installed-upgrade-gateway'), home = join(directory, 'player');
  const genesis = '01000000' + '00'.repeat(32) + '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' + 'dae5494dffff7f2002000000';
  const g = parseHeader(genesis), raw = [genesis, ...chain(80, g)], headerFile = join(home, 'headers.bin');
  let store = await Store.open(join(directory, 'gateway')), http, pipeline, journal, wallet;
  const witnessJournals = [], receiptFences = [];
  t.after(async () => { journal?.close(); wipeWallet(wallet); await http?.close(); await pipeline?.close(); for (const witness of witnessJournals) await witness.close(); await store.close(); });
  const files = new Files(join(store.directory, 'static')), bindings = bindingFixture(store, { network });
  const profile = { localOnly: true, mode: 'regtest', network, gateway: 'http://127.0.0.1:1', gatewayKey: edPublic(secret),
    receiptSigners: bindings.members, puzzleBits: 0, powLimitBits: 0x207fffff, adapter: resolve('kit/test/fixtures/once-adapter.mjs') };
  const profileFile = join(directory, 'network.json'); await writeFile(profileFile, JSON.stringify(profile));
  const password = 'disposable upgrade test password';
  await oldSetup({ network: 'regtest', networkFile: profileFile, directory: home, password });
  wallet = await oldKeys.unlock({ directory: home, password }); const owner = publicKey(wallet);
  const walletBytes = await readFile(join(home, 'keystore.json')), configBytes = await readFile(join(home, 'regtest.json'));
  const scope = `${network}/${owner}`; journal = await OldJournal.open(home, scope, { intervalMs: 0, perTip: 100 });
  let tip = 63, activated = false;
  await writeFile(headerFile, Buffer.from(raw.slice(0, tip + 1).join(''), 'hex'));
  const cacheBytes = await readFile(headerFile), legacyHistory = await oldHeaders.loadRegtestHistory(headerFile);
  const fullFile = join(directory, 'all-headers.bin'); await writeFile(fullFile, Buffer.from(raw.join(''), 'hex'));
  const history = await loadRegtestHistory(fullFile); history.hashAt = h => history.get(Number(h)).hash;
  const replayHistory = { length: history.length, get: h => history.get(Number(h)), raw: h => history.raw(Number(h)), field: (...a) => history.field(...a), hashAt: history.hashAt };
  const options = { ...deployment, network, beacon: { checkpoint: { ...g, height: 0, chainwork: workFor(g.bits).toString() }, params: REGTEST_PARAMS } };
  let contract = harness(options); for (let h = 1; h <= tip; h++) assert.equal(await contract.run('hd', { headers: [raw[h]] }), null); assert.equal(await contract.batch([]), null);
  const pattern = r.evaluateDiscovery({ proposal: { name: 'dmwprevious', pat: '[0-9]', fld: 4, dt: 'n' }, discoverer: owner, history: legacyHistory, existing: [], number: 0 }).record;
  await store.put('meta', 'patterns', [pattern]); await store.put('meta', 'ruleState', { ...initialState(tip + 1, history.hashAt(tip), tip), rounds: [{ window: tip, windowHash: history.hashAt(tip), claimableHeight: tip, slots: r.legacyRules.slotsFor(history.get(tip), [pattern]), claims: [], headerSenders: [], seedHash: null, closed: false }] });
  const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  await intake.observe({ tip, counted: tip, confirmed: tip, hash: history.hashAt(tip) });
  const walletKey = '23'.repeat(32), payer = testPayoutAddress(walletKey, 'tap', 'regtest'), treasury = testPayoutAddress('24'.repeat(32), 'tap', 'regtest');
  const registry = { feePolicy: createFeePolicy('100'), link: { treasury }, assets: {} };
  const feeQuotes = new FeeQuotes({ network, secret, registry: async () => registry });
  const baseReads = { counted: async () => tip, bitmap: async () => ({ agent: owner, address: payer }), link: async () => null, registry: async () => registry,
    validateFeeTerms: async (kind, row) => feeQuotes.accepted(row.terms.feeAuthorization, `${kind}/${row.id}`, row.id, row.request.until) };
  const legacyLinks = new Links({ store, network, reads: baseReads, terms: async (id, until, counted) => {
    const quote = await feeQuotes.issue('link/' + id, counted); return { treasury, baseFee: quote.baseFee, feeAuthorization: await feeQuotes.accept(quote, 'link/' + id, id, until, counted) };
  } });
  const checkout = new WebCheckout({ store, reads: baseReads, config: { mode: 'regtest', network, endpoints: { ethereum: 'http://127.0.0.1:1' }, local: { escrow: { chainId: 31337, address: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20) } } },
    post: (_, body) => legacyLinks.request(body), links: legacyLinks });
  http = await serve({ intake, files, links: legacyLinks, bindings: bindings.bindings, web: createWeb(checkout) });
  let loseLink = true;
  const oldClient = new OldClient({ origin: http.url, network, gateway: edPublic(secret), receiptSigners: bindings.members, fetchImpl: async (url, opts) => {
    const response = await fetch(url, opts);
    if (loseLink && url.endsWith('/link/request')) { loseLink = false; await response.arrayBuffer(); throw Error('simulated_lost_reply'); }
    return response;
  } });
  const trac = { network, head: async () => ({ tip: history.get(tip), counted: tip }), hashAt: async h => history.hashAt(h), settings: async () => activated ? { ruleset: 'dmw-v2', batchVersion: 2 } : { pending_blocks: 432 } };
  const legacyAgent = new OldAgent({ wallet, journal, network, service: oldClient, trac, dryRun: false, puzzleBits: 0, powLimitBits: 0x207fffff });
  const proposal = { name: 'dmwretained', pat: '[123]', fld: 4, dt: 'n' };
  await legacyAgent.propose({ actionId: 'saved-discovery', proposal, history: legacyHistory, patterns: [pattern] });
  await legacyAgent.claim({ event: { window: tip, hash: history.hashAt(tip), claimableHeight: tip }, plots: [{ block: 5, patterns: [0] }], history: legacyHistory, patterns: [pattern] });
  const payout = await legacyAgent.bindPayoutWallet({ actionId: 'saved-payout', rail: 'tap', address: payer });
  await bindings.bindings.complete({ id: payout.request.id, walletSignature: signTestPayout(payout.request.message, walletKey, 'tap', 'regtest') });
  await assert.rejects(legacyAgent.linkBitmap({ actionId: 'saved-link', height: 42, payer }), /no HTTP response/);
  assert.equal(journal.get('link/saved-link').state, 'unknown');
  const linkBody = journal.get('link/saved-link').body, linkId = r.linkId(network, linkBody.request), paymentHash = hash('disposable-link-preimage');
  const quoted = await checkout.prepareLink(linkId, { paymentHash, walletSignature: signTestPayout(linkWalletMessage(network, linkId, paymentHash), walletKey, 'tap', 'regtest') });
  const originalLink = store.get('linkIntents', linkId), paymentId = hash('disposable-paid-link') + 'i0';
  const payment = { requestId: linkId, id: paymentId, kind: 'tap', payer, confirmations: 1, consumed: true, verifiedHeight: tip, eventIndex: 0,
    total: quoted.price, tick: 'tap', lockKind: 'htlc', conditionType: 'hashlock', hash: paymentHash, refund: payer, claim: treasury, base: quoted.split.treasury,
    allocations: r.tapPaymentAllocations(quoted.split, {}, 'link'), refundAfter: linkBody.request.until + 144,
    settlement: { accepted: true, refund: false, paymentId, txid: hash('disposable-link-release'), confirmations: 1 } };
  baseReads.linkPaymentFor = async () => structuredClone(payment);
  await legacyLinks.payment({ id: linkId, paymentId });
  const retained = Object.fromEntries(journal.recent(100).map(({ id }) => [id, journal.get(id)]));
  const originalNotary = new Map(contract.db), document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: String(tip), values: { ...r.SETTINGS_PROFILE, puzzleBits: 0, proofBytes: 262144 } });
  const snapshot = { version: 2, height: tip, requests: new Map(), links: new Map([[linkId, store.get('linkRequests', linkId)]]), custody: new Map() };
  const rows = legacyGatewayRows(store), migration = prepareFinancialMigration({ rows, records: originalNotary, snapshot, network, document, height: tip, gateway: edPublic(secret) });
  const legacySettings = { puzzleBits: 0, receiptSigners: bindings.members }, anchor = { height: String(tip), hash: history.hashAt(tip) };
  const pending = preparePendingWork({ store, network, document, anchor, lastTo: tip, gateway: edPublic(secret), history: replayHistory, hashAt: history.hashAt, legacySettings, financialMigration: migration });
  const imported = prepareTerminalImport({ records: originalNotary, height: tip, network, financialSnapshot: snapshot, pendingWork: pending, gatewayRows: rows, document });
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2', previousBatchRoot: contract.db.get('bt/1'), bitcoinAnchor: anchor,
    settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(pending.named), accountsRoot: imported.financialRoot, receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: KIT_VERSION, route: 'terminal-import' };
  const manifestHash = r.hashObject(manifest), resources = r.resourceRevision({ operator: 'kit upgrade rehearsal', values: { ...r.RESOURCE_PROFILE } });
  contract = harness({ ...options, v2: { manifest, manifestHash, document, importRoot: imported.importRoot, importRows: imported.importRows } });
  for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
  for (const [key, value] of originalNotary) assert.deepEqual(contract.db.get(key), value);
  await installGatewayActivation({ store, document, imported, manifest, manifestHash, named: pending.named, legacySettings, gateway: edPublic(secret), history: replayHistory });
  const rulesContext = async () => ({ ruleset: 'dmw-v2', ready: true, manifest, manifestHash, settings: document, settingsHash: r.hashObject(document), last: await contract.state().batchLast(),
    catalogRoot: contract.db.get('v2/catalog'), accountsRoot: contract.db.get('v2/accounts'), claimsRoot: contract.db.get('v2/claims') });
  const stamp = async () => ({ counted: tip, tip, tipHash: history.hashAt(tip), last: await contract.state().batchLast() });
  const sourceReads = () => installFinancialSources({ ...baseReads, batchStamp: stamp, feeQuotes: new FeeQuotes({ network, secret, registry: async () => registry }) }, {
    network, document, bitcoinNetwork: 'regtest', recoveryVersion: 2, request: async id => store.get('financialLinks', id), reservation: async () => assert.fail('import has a pinned source'),
    record: async key => contract.db.get(key) ?? null });
  const independent = sourceReads(), reads = Object.assign(sourceReads(), { rulesContext, counted: async () => tip, batchLast: () => contract.state().batchLast(),
    batchRoot: async n => contract.db.get('bt/' + n) ?? null, committeeEpoch: async () => 0, settings: () => contract.state().settings() });
  for (const [i, member] of bindings.members.entries()) {
    const witness = await new SignerJournal(join(directory, member.id + '.log'), 'disposable-upgrade-witness', network, member.id).load();
    witnessJournals.push(witness);
    receiptFences.push(new ReceiptFences({ journal: witness, reads: { ...reads, tip: async () => ({ tip }), authority: async () => ({ epoch: 0 }) },
      network, gateway: edPublic(secret), signer: member.id, secret: Buffer.alloc(32, 180 + i), members: bindings.members }));
  }
  let approvals = 0;
  const committee = { acknowledgeReceipt: (receipt, checkpoint) => Promise.all(receiptFences.map(f => f.admit(receipt, checkpoint))), healthy: async () => bindings.config,
    attestRoot: async seal => bindings.members.slice(0, 3).map((m, i) => r.attestReceiptRoot(seal, seal.tip, m.id, Buffer.alloc(32, 180 + i))),
    signature: async (_, proposal) => {
      const d = await pipeline.loadDraft(), context = { authority: { epoch: 0 }, counted: tip, last: await contract.state().batchLast(), gateway: edPublic(secret),
        state: d.startState, patterns: d.startPatterns, inputs: d.items.map(i => i.input), history: replayHistory, hashAt: history.hashAt, settings: d.settings, limits: d.limits, activation: d.activation, previousRoot: d.previousRoot };
      const rebuilt = rebuildBatch(network, proposal, context);
      for (const fence of receiptFences) fence.checkBatch(proposal.batch, rebuilt.files);
      await verifyFinancialExecution({ files: proposal.files.map(f => r.decodeBinary(Buffer.from(f, 'hex'))), reads: independent, document, network, height: tip, at: await stamp() });
      approvals++; return { signature: { compact: secp256k1.sign(rebuilt.digest, committeeSecret, { prehash: false, lowS: true }).toCompactHex() } };
    } };
  const runtime = await createV2Runtime({ config: { mode: 'regtest', network, committee: bindings.config, assetRecoveryVersion: 2, v2: { manifest, manifestHash, document, resources } }, store, secret, history: replayHistory, reads, committee });
  const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => assert.equal(await contract.run(m.op, m.value), null),
    status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
  pipeline = new Pipeline({ store, files, history: replayHistory, intake: runtime.intake, reads, committee, financial: runtime.financial, settings: runtime.settings, outbox: new Outbox({ store, transport, retryMs: 0 }) });
  const port = Number(new URL(http.url).port); await http.close(); http = await serve({ port, intake: runtime.intake, files, bindings: bindings.bindings, links: runtime.links });
  activated = true; await runtime.intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip }); await runtime.refresh();
  let refusal;
  await assert.rejects(legacyAgent.headers({ height: tip, raw: raw[tip], history: legacyHistory }), error => {
    refusal = error.message; assert.equal(error.code, KIT_UPGRADE_CODE); assert.equal(error.status, 409);
    assert.match(refusal, /install_0_2_0_from_github_com_trac_systems_digital_matter_world/); return true;
  });
  assert.equal(journal.get(`header/${tip}`).state, 'unknown');
  const refusedPacket = journal.get(`header/${tip}`).body;
  for (const [id, before] of Object.entries(retained)) assert.deepEqual(journal.get(id).body, before.body);
  journal.close(); wipeWallet(wallet);
  wallet = await unlock({ directory: home, password }); journal = await Journal.open(home, scope, { intervalMs: 0, perTip: 100 });
  assert.equal(publicKey(wallet), owner); assert.deepEqual(await readFile(join(home, 'keystore.json')), walletBytes);
  assert.deepEqual(await readFile(join(home, 'regtest.json')), configBytes); assert.deepEqual(await readFile(headerFile), cacheBytes);
  const upgradedHistory = await loadRegtestHistory(headerFile); assert.equal(upgradedHistory.get(tip).hash, legacyHistory.get(tip).hash);
  await writeFile(profileFile, JSON.stringify({ ...profile, gateway: http.url }));
  const configUpgrade = await upgradeConfig({ configFile: join(home, 'regtest.json'), networkFile: profileFile });
  assert.equal(configUpgrade.changed, true); assert.deepEqual(await readFile(configUpgrade.backup), configBytes);
  assert.equal(JSON.parse(await readFile(configUpgrade.config)).directory, home);
  assert.equal((await upgradeConfig({ configFile: configUpgrade.config, networkFile: profileFile })).changed, false);
  const client = new ServiceClient({ origin: http.url, network, gateway: edPublic(secret), receiptSigners: bindings.members });
  Object.assign(trac, { rulesContext, settingsByHash: async hash => contract.db.get('v2/settings/' + hash) });
  const activatedTrac = new TracClient({ network, integerVersion: 2, api: { dmwAuthority: async () => ({ network }), dmwHead: () => contract.state().head(),
    dmwHashAt: h => contract.state().beacon().hashAt(h), dmwSettings: () => contract.state().settings(), dmwRulesContext: rulesContext,
    dmwSettingsByHash: async h => contract.db.get('v2/settings/' + h), dmwAccountRoot: async a => contract.db.get('ar/' + a),
    dmwBalance: (a, asset, proof) => contract.state().balance(a, asset, proof) } });
  activatedTrac.balanceProof = (a, asset, limit) => client.accountProof(a, asset, limit);
  const current = new Agent({ wallet, network, journal, service: client, trac: activatedTrac, dryRun: false, puzzleBits: 0, powLimitBits: 0x207fffff });
  const resumed = await current.linkBitmap({ actionId: 'saved-link', height: 42, payer });
  assert.equal(resumed.request.id, linkId); assert.equal(journal.get('link/saved-link').state, 'submitted'); assert.deepEqual(journal.get('link/saved-link').body, linkBody);
  await current.reconcileAction('payout/saved-payout'); assert.equal(journal.get('payout/saved-payout').state, 'accepted');
  const drain = async () => { for (let n = 0; n < 100; n++) { await pipeline.tick(); await runtime.refresh();
    if (!store.hasRows('observations') && !store.get('meta', 'draft') && !store.get('meta', 'namedReservedBatch') && !runtime.financial.pending()) return; } throw Error('upgrade_drain'); };
  await runtime.intake.seal(); await drain();
  for (tip = 64; tip <= 65; tip++) { assert.equal(await contract.run('hd', { headers: [raw[tip]] }), null);
    await runtime.intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip }); await drain(); }
  tip = 65;
  await writeFile(headerFile, Buffer.from(raw.slice(0, tip + 1).join(''), 'hex')); const continuedHistory = await loadRegtestHistory(headerFile);
  assert.deepEqual((await readFile(headerFile)).subarray(0, cacheBytes.length), cacheBytes);
  await current.reveal({ actionId: 'saved-discovery', history: continuedHistory }); await drain();
  assert.equal(store.get('patternsByAsset', 'p2:1').name, proposal.name);
  assert.equal(store.get('finds', 'f2:5:0').finder, owner);
  assert.equal(await activatedTrac.balance(owner, 'p0'), '1');
  const proofRead = activatedTrac.balanceProof; activatedTrac.balanceProof = async (...args) => { const e = await proofRead(...args); e.proof.leaves[0].value.available = '999'; return e; };
  await assert.rejects(activatedTrac.balance(owner, 'p0')); activatedTrac.balanceProof = proofRead;
  await runtime.links.tick(); await drain(); await runtime.links.tick(); await drain();
  assert.equal((await client.linkStatus(linkId)).state, 'accepted');
  assert.equal(contract.db.get('fl/' + linkId).state, 'complete');
  assert.deepEqual(store.get('financialLinks', linkId).legacyLink.request, originalLink.request);
  assert.deepEqual(journal.get(`header/63`).body, refusedPacket);
  for (const [id, before] of Object.entries(retained)) assert.deepEqual(journal.get(id).body, before.body);
  // A new player uses the same activated stack and needs no legacy journal.
  const fresh = join(directory, 'fresh'); const { init } = await import('../lib/keyring.mjs'); await init({ directory: fresh, password });
  const freshWallet = await unlock({ directory: fresh, password }), freshJournal = await Journal.open(fresh, `${network}/${publicKey(freshWallet)}`, { intervalMs: 0 });
  try { const freshAgent = new Agent({ wallet: freshWallet, journal: freshJournal, network, trac: activatedTrac, service: client, dryRun: false, puzzleBits: 0, powLimitBits: 0x207fffff });
    await freshAgent.postHeader({ height: tip, history: continuedHistory }); await drain(); assert.equal(freshJournal.get(`header/${tip}`).body.v, 2);
  } finally { freshJournal.close(); wipeWallet(freshWallet); }
  await verifyInstalled();
  await writeFile(join(directory, 'results.json'), JSON.stringify({ passed: true, baseline, trackedFilesVerified: entries.length, kitVersion: KIT_VERSION,
    refusal, walletUnchanged: true, configBackupExact: true, playerDirectoryUnchanged: true, headerPrefixUnchanged: true, originalJournalBodiesUnchanged: Object.keys(retained).length,
    discoveryAccepted: true, legacyClaimSettled: true, payoutResumed: true, legacyPaidLinkCompleted: true, freshInstall: true, independentBalanceProof: true, alteredBalanceProofRejected: true, replayApprovals: approvals,
    limitations: 'Synthetic local chain/payment source; real wallet, HTTP clients, signatures, PM3 importer, replay and contract state machine. No physical mainnet or threshold service claim.' }, null, 2) + '\n');
});
