import { acceptedAssetProvenance } from '../src/asset-provenance.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import * as r from '../../rules/src/index.js';
import { harness, deployment, committeeSecret } from '../../contract/tests/helpers/harness.mjs';
import { chain, parseHeader } from '../../contract/tests/helpers/chain.mjs';
import { REGTEST_PARAMS, workFor } from '../../contract/beacon/bitcoin.js';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { accountActionDigest } from '../../contract/root-accounts.js';
import { Policy } from '../../committee/signer/policy.mjs';
import { ReceiptFences } from '../../committee/signer/receipt-fences.mjs';
import { Journal as SignerJournal } from '../../committee/signer/journal.mjs';
import { rebuildBatch } from '../../committee/signer/adapter.mjs';
import { BatchReplay } from '../../committee/signer/replay-worker.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';
import { EvidenceStore, evidencePublisher } from '../prod/evidence.mjs';
import { checkBatchReceiptRoster } from '../prod/reads.mjs';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
import { installGatewayActivation, createV2Runtime } from '../src/v2-runtime.mjs';
import { AccountAvailability } from '../src/account-availability.mjs';
import { initialState } from '../src/rules.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { FinancialExecution } from '../src/financial-execution.mjs';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Feeds } from '../src/feeds.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { Outbox } from '../src/transport.mjs';
import { serve } from '../src/http.mjs';
import { manifestTrust } from '../../kit/lib/header-manifest.mjs';
import { HeaderChunks } from '../src/header-chunks.mjs';
import { downloadArchive } from '../../kit/lib/header-download.mjs';
import { hash, edPublic } from '../src/util.mjs';
import { Agent } from '../../kit/lib/agent.mjs';
import { Journal } from '../../kit/lib/journal.mjs';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { loadRegtestHistory } from '../../kit/lib/headers.mjs';
import { temp, network, secret, agent as witness } from './helpers.mjs';
import { claimAttackChecks } from './claim-policy-attacks.mjs';
import { firstMintFixture } from './first-mint-fixture.mjs';
import { createFeePolicy } from '../src/fees.mjs';

// Five independent policy/evidence instances and loopback HTTP endpoints. The
// fixture uses one disposable committee key after all five policies agree;
// production threshold ceremony coverage remains in committee/test/services.
test('eight kit journals, five HTTP policies, targeted evidence and imported notary settle 800 claims', { timeout: 180000 }, async t => {
  const path = await temp('v2-stack-'), closes = [], journals = [], timings = [];
  t.after(async () => { for (const j of journals) j.close(); for (const close of closes.reverse()) await close(); });
  const genesis = '01000000' + '00'.repeat(32) + '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' + 'dae5494dffff7f2002000000';
  const checkpoint = { ...parseHeader(genesis), height: 0, chainwork: workFor(0x207fffff).toString() };
  const raw = [genesis, ...chain(1030, checkpoint)]; await writeFile(join(path, 'headers.bin'), Buffer.from(raw.join(''), 'hex'));
  const history = await loadRegtestHistory(join(path, 'headers.bin')); history.hashAt = h => history.get(Number(h)).hash;
  const replayHistory = { length: history.length, get: h => history.get(h), raw: h => history.raw(h), field: (...args) => history.field(...args), hashAt: history.hashAt };
  const options = { ...deployment, network, beacon: { checkpoint, params: REGTEST_PARAMS } };
  const old = harness(options); await old.advance(1009); assert.equal(await old.batch([]), null); await old.advance(1);
  const imported = prepareTerminalImport({ records: old.db, height: 1010, pageBytes: 10000 });
  const document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '1010', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0, proofBytes: 262144,
    settlementPageRows: 100, settlementPagesPerObservation: 2, compoundPrecisionBits: 1, compoundWorkBudget: 8, adminDelayTips: 1,
    feePolicyRevision: createFeePolicy('100').current, linkMultiplier: r.FEE_DEFAULTS.link } });
  const named = r.emptyNamedDiscovery();
  const legacyPattern = { number: 0, name: 'dmwflorite', pat: '1', fld: 4, dt: 'n', tier: 1, rarity: 1,
    discoverer: r.bytesToHex(ed25519.getPublicKey(r.hashBytes('isolated-kit-player-7'))), historyHeight: 1009, historyHash: history.hashAt(1009) };
  const legacyKey = r.definitionKey({ name: legacyPattern.name, pat: legacyPattern.pat, fld: legacyPattern.fld, dt: legacyPattern.dt }, document), legacyRecord = { ...legacyPattern, number: '0', key: legacyKey,
    legacy: { asset: 'p0', record: legacyPattern }, knownMatchCount: '0', knownOccurrenceTotal: '0', evidenceRoot: r.namedRoot(null),
    catalogRevision: '0', settingsHash: r.hashObject(document), definitionSettingsHash: r.hashObject(document),
    anchor: { height: '1009', hash: history.hashAt(1009) }, attributionProvisional: false };
  for (const [key, value] of [['number/0', legacyKey], ['pattern/' + legacyKey, legacyRecord], ['name/' + legacyPattern.name, legacyKey], ['revision/' + legacyKey + '/0', legacyRecord]])
    named.records = r.namedSet(named.records, key, value);
  named.nextPattern = '1';
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2',
    previousBatchRoot: old.db.get('bt/1'), bitcoinAnchor: { height: '1010', hash: history.hashAt(1010) }, settingsHash: r.hashObject(document),
    catalogRoot: r.namedStateRoot(named), accountsRoot: imported.financialRoot, receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const manifestHash = r.hashObject(manifest), resources = r.resourceRevision({ operator: 'isolated-stack', values: { ...r.RESOURCE_PROFILE } });
  const members = Array.from({ length: 5 }, (_, i) => ({ id: `policy-${i}`, peer: { id: `policy-${i}`, identity: witness(900 + i).address,
    encryption: witness(950 + i).address, url: `http://127.0.0.1:${58330 + i}` } }));
  const receiptPin = { receiptProtocol: 1, gateway: edPublic(secret), receiptSigners: members.map(({ peer: { id, identity } }) => ({ id, identity })) };
  const contract = harness({ ...options, v2: { manifest, manifestHash, document, ...receiptPin, importRoot: imported.importRoot, importRows: imported.importRows } });
  for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
  for (const [key, value] of old.db) assert.deepEqual(contract.db.get(key), value);
  const rulesContext = async () => ({ ruleset: 'dmw-v2', ready: true, manifest, manifestHash, settings: contract.db.get('v2/settings'), settingsHash: r.hashObject(contract.db.get('v2/settings')), scheduledSettings: contract.db.get('v2/settings-next'),
    last: await contract.state().batchLast(), catalogRoot: contract.db.get('v2/catalog'), accountsRoot: contract.db.get('v2/accounts'), claimsRoot: contract.db.get('v2/claims'), receiptRenewal: contract.db.get('v2/receipt-renewal') ?? null,
    receiptProtocol: contract.db.get('v2/receipt-protocol') ?? null });
  let store = await Store.open(join(path, 'gateway')); const files = new Files(join(store.directory, 'static')); closes.push(() => store.close());
  const fenceReaders = [];
  const attackChecks = claimAttackChecks({ network, store, contract, rulesContext, history: replayHistory, t, receiptFences: () => fenceReaders[0] }); closes.push(() => attackChecks.close());
  await store.put('meta', 'ruleState', initialState(1010, history.hashAt(1010), 1009));
  await installGatewayActivation({ store, manifest, manifestHash, document, imported, named });
  let tip = 1010, pipeline, runtime, approvals = 0, proofRequests = 0, maximumProofBytes = 0, tamperContext = null, craftAttacks = 0, mixedBatches = 0;
  const contexts = join(path, 'contexts'); await mkdir(contexts);
  const config = { network, epoch: 0, data: store.directory, committee: members, prod: { contexts }, v2: { manifest, manifestHash, document, resources, ...receiptPin } };
  const stamp = async () => { const head = await contract.state().head(); return { counted: head.counted, revision: head.revision,
    tip: head.tip.height, tipHash: head.tip.hash, last: await contract.state().batchLast() }; };
  const publisher = evidencePublisher({ config, store, reads: { trac: stamp }, secret }); closes.push(() => publisher.close());
  const rpc = async (url, route, value) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    const body = await response.json(); assert.equal(response.status, 200, body.error); return body;
  };
  const financialSources = new Map();
  let firstMintReads;
  const financialEvidence = async (transition, at) => {
    const evidence = financialSources.get(r.hashObject(transition));
    if (!evidence && firstMintReads) return firstMintReads.financialEvidence(transition, at);
    assert.ok(evidence, 'independent financial source fixture');
    return structuredClone(evidence);
  };
  const servers = [], evidenceReaders = [];
  for (let i = 0; i < 5; i++) {
    const reader = await EvidenceStore.open({ config: { directory: join(path, `reader-${i}`), network, epoch: 0, member: members[i].id },
      identity: witness(900 + i).secret, gateway: edPublic(secret), source: { request: async (_, { body }) => { proofRequests++; return publisher(body); } },
      clock: async () => ({ tip, tipHash: history.hashAt(tip) }), stamp }); closes.push(() => reader.close());
    evidenceReaders.push(reader);
    const reads = { authority: async () => ({ network, committee: options.committee, epoch: 0 }), counted: async () => tip, tip: async () => ({ tip }), rulesContext, settingsByHash: async hash => contract.db.get('v2/settings/' + hash),
      batchRoot: async n => contract.db.get('bt/' + n) ?? null,
      batchStamp: stamp, financialRecord: async key => contract.db.get(key) ?? null, financialEvidence,
      batchContext: async n => { const original = await reader.context(n), c = tamperContext ? tamperContext(structuredClone(original)) : original; checkBatchReceiptRoster(config, c.settings); return { ...c, history: replayHistory, hashAt: history.hashAt }; },
      receiptCertificate: (h, hash, segment) => reader.get('receiptCertificates', `${h}/${hash}/${segment}`),
      receiptCutoffPage: async (hash, index) => reader.get('receiptCutoffPages', r.receiptCutoffPageKey(hash, index)),
    receiptObservation: (h, hash, segment) => reader.get('receiptObservations', `${h}/${hash}/${segment}`),
      replayNodes: (...args) => reader.replayNodes(...args),
      claimNode: (id, ancestors) => reader.claimNode(id, ancestors),
      preflight: (batch, at) => preflightBatch(batch, at, { read: key => contract.db.get(key), deployment: contract.options }) };
    const journal = await new SignerJournal(join(path, `admissions-${i}.log`), 'disposable-stack', network, members[i].id).load(); closes.push(() => journal.close());
    const receiptFences = new ReceiptFences({ journal, reads, members: members.map(m => m.peer), network, gateway: edPublic(secret), signer: members[i].id, secret: witness(900 + i).secret });
    fenceReaders.push(receiptFences);
    const replay = new BatchReplay(); closes.push(() => replay.close());
    const policy = new Policy({ network, publicKey: options.committee, reads, receiptFences, replayBatch: replay.run.bind(replay) });
    const server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
        await reader.refresh(); let result;
        if (req.url === '/ack') result = await receiptFences.admit(body.receipt, body.checkpoint);
        else if (req.url === '/fence') result = await receiptFences.cutoff(body.cutoff, body.evidence);
        else if (req.url === '/attest') {
          const row = await reader.get('receiptObservations', r.receiptSegmentKey(body));
          assert.deepEqual(row.seal, body); assert.ok(r.verifyReceiptRoot(body, row.receipts, { network, gateway: edPublic(secret), tip: Number(body.tip), hash: body.hash }));
          result = r.attestReceiptRoot(body, String(tip), members[i].id, witness(900 + i).secret);
        } else { result = await policy.approve(body); approvals++; }
        res.end(JSON.stringify(result));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(`http://127.0.0.1:${server.address().port}`);
    closes.push(() => new Promise(resolve => server.close(resolve)));
  }
  const committee = { healthy: async () => members,
    fenceReceipts: async (cutoff, evidence) => {
      const votes = await Promise.all(servers.map(async url => {
        let vote; do { vote = await rpc(url, '/fence', { cutoff, evidence }); } while (vote.pending); return vote;
      }));
      assert.ok(r.verifyReceiptFenceVotes('cutoff', cutoff, votes, members.map(m => m.peer))); return votes;
    },
    acknowledgeReceipt: async (receipt, checkpoint) => {
      const votes = await Promise.all(servers.map(url => rpc(url, '/ack', { receipt, checkpoint })));
      assert.ok(r.verifyReceiptFenceVotes('admission', receipt, votes, members.map(m => m.peer))); return votes;
    },
    attestRoot: async seal => {
      const attestations = await Promise.all(servers.map(url => rpc(url, '/attest', seal)));
      await store.put('receiptCertificates', r.receiptSegmentKey(seal), { seal, attestations }); return attestations;
    },
    signature: async (_, proposal) => {
      if (proposal.batch.ops.some(o => o.actions?.some(a => a.type === 'craft')) && proposal.batch.ops.some(o => o.op === 'fp')) mixedBatches++;
      if (!craftAttacks && proposal.batch.ops.some(o => o.actions?.some(a => a.type === 'craft'))) {
        const refuse = async bad => {
          const response = await fetch(servers[0] + '/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
          assert.equal(response.status, 400); assert.match((await response.json()).error, /batch_mismatch|named_storage_integrity|named_predecessor|account_credit_derivation/); craftAttacks++;
        };
        const altered = structuredClone(proposal); altered.batch.ops.find(o => o.actions?.some(a => a.type === 'craft')).actions.find(a => a.type === 'craft').out[0][1] = '99';
        await refuse(altered);
        for (const alter of [
          c => { c.inputs[0].namedEvidence.nodes = []; return c; },
          c => { c.state.namedSnapshot = null; return c; },
          c => { c.inputs[0].accountOperations = []; return c; }
        ]) {
          tamperContext = alter;
          try { await refuse(proposal); } finally { tamperContext = null; }
        }
      }
      const result = await Promise.all(servers.map(url => rpc(url, '/approve', proposal)));
      assert.equal(new Set(result.map(a => a.digest)).size, 1);
      return { signature: { compact: secp256k1.sign(result[0].digest, committeeSecret, { prehash: false, lowS: true }).toCompactHex() } };
    } };
  const reads = { rulesContext, settings: () => contract.state().settings(), financialEvidence, counted: async () => tip, batchLast: () => contract.state().batchLast(), batchRoot: async n => contract.db.get('bt/' + n) ?? null,
    committeeEpoch: async () => 0, publishContext: async (n, d) => {
      maximumProofBytes = Math.max(maximumProofBytes, ...d.items.map(i => Buffer.byteLength(JSON.stringify(i.input.namedEvidence.nodes))));
      const context = { last: d.last, counted: d.execution, state: d.startState, patterns: d.startPatterns, gateway: edPublic(secret),
        settings: d.settings, limits: d.limits, headers: d.headers, activation: d.activation, previousRoot: d.previousRoot, inputs: d.items.map(i => i.input) };
      if (d.items.length) await attackChecks(d, context);
      const bytes = Buffer.from(JSON.stringify(context)), digest = hash(bytes); await writeFile(join(contexts, digest + '.json'), bytes);
      await store.put('evidenceContexts', String(n), { path: digest + '.json', hash: digest });
    } };
  runtime = await createV2Runtime({ config, store, secret, history, reads, committee });
  // Production's observation and pipeline workers can refresh simultaneously.
  // A slow quorum read must not multiply queued signer/source operations.
  const healthy = committee.healthy;
  let releaseHealth, startedHealth, healthCalls = 0;
  const healthStarted = new Promise(resolve => { startedHealth = resolve; });
  committee.healthy = async () => {
    healthCalls++; startedHealth();
    await new Promise(resolve => { releaseHealth = resolve; });
    return members;
  };
  const firstRefresh = runtime.refresh();
  await healthStarted;
  const secondRefresh = runtime.intake.prepareBatch();
  assert.equal(secondRefresh, firstRefresh);
  releaseHealth();
  assert.deepEqual(await Promise.all([firstRefresh, secondRefresh]), [true, true]);
  assert.equal(healthCalls, 1);
  committee.healthy = async () => { healthCalls++; throw Error('fixture_quorum_unavailable'); };
  await assert.rejects(runtime.refresh(), /fixture_quorum_unavailable/);
  committee.healthy = async () => { healthCalls++; return healthy(); };
  assert.equal(await runtime.refresh(), true);
  assert.equal(healthCalls, 3, 'settled results and failures are never reused');
  committee.healthy = healthy;
  const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => { assert.equal(await contract.run(m.op, m.value), null); },
    status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
  reads.financialRecord = async key => contract.db.get(key) ?? null;
  const financial = new FinancialExecution({ store, reads, document, resources: { workPage: 32, mintInputCapacity: 100 } });
  pipeline = new Pipeline({ pipelineDepth: 2, store, files, history: replayHistory, intake: runtime.intake, reads, committee, financial, settings: runtime.settings, outbox: new Outbox({ store, transport, retryMs: 0 }) }); closes.push(() => pipeline.close());
  const http = await serve({ intake: runtime.intake, files, evidence: publisher }); closes.push(() => http.close());
  const drain = async () => { for (let i = 0; i < 1000; i++) { await pipeline.tick(); await runtime.refresh(); if (!store.count('observations') && !store.get('meta', 'namedReservedBatch') && !store.get('meta', 'draft') && !store.get('meta', 'ruleState').rounds.some(r => r.closed || r.closing)) return; } throw Error('backlog_did_not_drain'); };
  const observe = async () => { await runtime.intake.observe({ tip, hash: history.hashAt(tip), counted: tip, confirmed: tip }); await runtime.refresh(); };
  await observe();
  const regexes = ['[0-9]', '[0-9]{1}', '0|[1-9]', '[0-8]|9', '[0-7]|[89]', '[0-6]|[7-9]', '[0-5]|[6-9]', '[0-4]|[5-9]'];
  const players = [];
  for (let i = 0; i < 8; i++) {
    const key = r.hashBytes('isolated-kit-player-' + i), directory = join(path, 'player-' + i), journal = await Journal.open(directory, network, { intervalMs: 0, perTip: 100 }); journals.push(journal);
    const service = new ServiceClient({ origin: http.url, network, gateway: edPublic(secret), receiptSigners: members.map(m => m.peer) });
    const trac = { network, head: async () => ({ tip: history.get(tip), counted: tip }), hashAt: async h => history.hashAt(h), settings: () => contract.state().settings(), rulesContext,
      accountRoot: async owner => contract.db.get('ar/' + owner) };
    const agent = new Agent({ wallet: { publicKey: ed25519.getPublicKey(key), sign: bytes => ed25519.sign(bytes, key) }, network, service, trac, journal, dryRun: false, puzzleBits: 0, powLimitBits: 0x207fffff });
    players.push({ agent, directory, proposal: { name: `dmwstack${i}`, pat: regexes[i], fld: 4, dt: 'n' } });
  }
  const witnesses = { anchor: { height: '1010', hash: history.hashAt(1010) }, matches: [1, 2, 3].map(h => ({ height: String(h), hash: history.hashAt(h), count: '1' })) };
  const submitGroup = async action => {
    let remaining = players;
    for (let tries = 0; remaining.length && tries < 10; tries++) {
      const results = await Promise.allSettled(remaining.map(action)), retry = [];
      if (tries === 0 && results.every(r => r.status === 'rejected')) t.diagnostic(JSON.stringify({ refusals: results.map(r => r.reason.code) }));
      results.forEach((result, i) => { if (result.status === 'rejected') {
        assert.equal(result.reason.refusedBeforeAcceptance, true, result.reason.message); retry.push(remaining[i]);
      } });
      await drain(); remaining = retry;
    }
    assert.equal(remaining.length, 0, 'capacity retries drain at the same Bitcoin height');
  };
  await submitGroup(p => p.agent.propose({ actionId: 'keep', proposal: p.proposal, history, witnesses }));
  // Reopen the same real kit journal between the commitment and reveal.
  const first = players[0], saved = first.agent.journal.get('discovery/keep').body; first.agent.journal.close();
  first.agent.journal = await Journal.open(first.directory, network, { intervalMs: 0, perTip: 100 }); journals[0] = first.agent.journal;
  assert.deepEqual(first.agent.journal.get('discovery/keep').body, saved);
  for (tip = 1011; tip <= 1012; tip++) { await contract.advance(1); await observe(); await drain(); } tip = 1012;
  const start = performance.now(); await submitGroup(p => p.agent.reveal({ actionId: 'keep', history })); timings.push(performance.now() - start);
  const patterns = store.list('patternsByAsset', { limit: 100 }).map(row => ({ ...row.value, number: Number(row.value.number) })).filter(p => !p.legacy); assert.equal(patterns.length, 8);
  await submitGroup(p => {
    const pattern = patterns.find(q => q.name === p.proposal.name);
    return p.agent.claim({ event: { window: tip, hash: history.hashAt(tip) }, plots: Array.from({ length: 100 }, (_, i) => ({ block: i + 1, patterns: [pattern.number] })), history, patterns });
  });
  for (tip = 1013; tip <= 1014; tip++) {
    await contract.advance(1); await observe(); await drain();
    if (tip === 1013) await submitGroup(p => p.agent.headers({ height: tip, raw: Buffer.from(history.raw(tip)).toString('hex'), history }));
  } tip = 1014;
  await runtime.intake.seal(); await drain();
  assert.equal(store.count('finds'), 800);
  assert.ok(pipeline.overlap.promoted > 0, JSON.stringify(pipeline.overlap));
  assert.equal(pipeline.overlap.failed, 0, JSON.stringify(pipeline.overlap));
  t.diagnostic(JSON.stringify({ pipelineOverlap: pipeline.overlap }));
  for (const p of players) {
    const pattern = patterns.find(q => q.name === p.proposal.name), key = accountKey('balance', 'p2:' + pattern.number), record = contract.db.get('ar/' + p.agent.owner);
    assert.equal(readAccountLeaf(record.root, new AccountAvailability(store).prove(record.root, [key]), key).available, '192');
  }
  // A later packet reads the earlier header ticket and an already delivered
  // find. No second credit is possible even with omitted gateway map copies.
  await players[0].agent.claim({ event: { window: 1013, hash: history.hashAt(1013) }, plots: [{ block: 1, patterns: [patterns[0].number] }],
    header: { height: 1013, raw: Buffer.from(history.raw(1013)).toString('hex') }, history, patterns }); await drain();
  tip = 1015; await contract.advance(1); await observe(); await drain();
  await players[0].agent.claim({ event: { window: tip, hash: history.hashAt(tip) }, plots: [{ block: 1013, patterns: [patterns[0].number] }], history, patterns }); await drain();
  assert.equal(store.count('finds'), 801);
  const implicit = store.get('finds', `f2:1013:${patterns[0].number}`); assert.equal(implicit.source, 'header'); assert.equal(implicit.findHeight, '1015');
  await players[1].agent.claim({ event: { window: tip, hash: history.hashAt(tip) }, plots: [{ block: 1013, patterns: [patterns[1].number] }], history, patterns }); await drain();
  assert.equal(store.count('finds'), 802);
  tip = 1016; await contract.advance(1); await observe(); await drain();
  const maker = players[0].agent, ingredient = patterns.find(p => p.name === players[1].proposal.name), own = patterns.find(p => p.name === players[0].proposal.name);
  const balanceBeforeClaim = asset => { const key = accountKey('balance', asset), root = contract.db.get('ar/' + maker.owner).root;
    return BigInt(readAccountLeaf(root, new AccountAvailability(store).prove(root, [key]), key)?.available ?? '0'); };
  const ownBefore = balanceBeforeClaim(`p2:${own.number}`), ingredientBefore = balanceBeforeClaim(`p2:${ingredient.number}`);
  await maker.claim({ event: { window: tip, hash: history.hashAt(tip) }, plots: [{ block: 101, patterns: [ingredient.number] }], history, patterns }); await drain();
  await players[7].agent.claim({ event: { window: tip, hash: history.hashAt(tip) }, plots: [{ block: 1, patterns: [0] }], history,
    patterns: [...patterns, { ...legacyRecord, number: 0 }] }); await drain();
  for (tip = 1017; tip <= 1018; tip++) { await contract.advance(1); await observe(); await drain(); } tip = 1018;
  await runtime.intake.seal(); await drain();
  const balanceAt = asset => { const key = accountKey('balance', asset), root = contract.db.get('ar/' + maker.owner).root;
    return readAccountLeaf(root, new AccountAvailability(store).prove(root, [key]), key)?.available ?? '0'; };
  assert.equal(balanceAt(`p2:${ingredient.number}`), String(ingredientBefore + 3n), 'the second ingredient claim settled');
  const craftArgs = { actionId: 'craft-keep', recipe: 'fusion', inputs: [[`p2:${own.number}`, '1'], [`p2:${ingredient.number}`, '1']] };
  const submit = maker.service.submit.bind(maker.service); let loseReceipt = true;
  maker.service.submit = async (...args) => { const receipt = await submit(...args); if (loseReceipt) { loseReceipt = false; throw Error('test_lost_craft_response'); } return receipt; };
  await assert.rejects(maker.craft(craftArgs), /test_lost_craft_response/);
  assert.equal(maker.journal.get('craft/craft-keep').state, 'unknown');
  const packet = maker.journal.get('craft/craft-keep').body;
  maker.journal.close(); maker.journal = await Journal.open(first.directory, network, { intervalMs: 0, perTip: 100 }); journals[0] = maker.journal;
  const crafted = await maker.craft(craftArgs); assert.equal(crafted.state, 'received');
  assert.equal((await maker.craft(craftArgs)).replayed, true); assert.deepEqual(maker.journal.get('craft/craft-keep').body, packet);
  // An independent owner's reservation shares the craft batch. Every signer
  // must derive the craft prefix before simulating the financial transition.
  const payer = players[2].agent, paidAsset = 'p2:' + patterns.find(p => p.name === players[2].proposal.name).number;
  const requestId = r.hash('mg1-mixed-reservation'), fees = [{ key: r.hash('mg1-fee'), amount: '2' }];
  const terms = { owner: payer.owner, asset: paidAsset, amount: '3', fees, settingsHash: r.hashObject(document),
    finderUntil: store.get('finds', `f2:1:${paidAsset.slice(3)}`).finderUntil };
  const reservationAction = { type: 'reserve', owner: payer.owner, asset: paidAsset, amount: '3', id: requestId,
    terms: r.hashObject(terms), revision: contract.db.get('ar/' + payer.owner).revision, nonce: r.hash('mg1-reserve-nonce'), until: String(tip + 100) };
  reservationAction.sig = r.bytesToHex(await payer.wallet.sign(accountActionDigest(network, reservationAction)));
  const reservation = { type: 'reserve', id: requestId, action: reservationAction, fees };
  financialSources.set(r.hashObject(reservation), terms); await financial.submit(reservation);
  await drain();
  assert.equal(mixedBatches, 1); assert.equal(contract.db.get('ao/' + requestId).state, 'reserved');
  const available = asset => { const key = accountKey('balance', asset), root = contract.db.get('ar/' + maker.owner).root;
    return readAccountLeaf(root, new AccountAvailability(store).prove(root, [key]), key)?.available ?? '0'; };
  assert.equal(available(crafted.compound.id), '1'); assert.equal(available(`p2:${own.number}`), String(ownBefore - 1n)); assert.equal(available(`p2:${ingredient.number}`), String(ingredientBefore + 2n));
  assert.equal(store.get('compoundTypes', crafted.compound.id).firstMaker, maker.owner);
  assert.equal(crafted.compound.tier.value, null);
  let refinement;
  for (let i = 0; i < 100; i++) {
    refinement = await maker.refineCompound({ actionId: `tier-${i}`, asset: crafted.compound.id });
    if (refinement.state === 'complete') break;
    assert.equal(refinement.state, 'received'); await drain();
  }
  assert.equal(refinement.state, 'complete'); assert.equal(refinement.tier, 5);
  assert.equal(store.get('compoundTiers', crafted.compound.id).value, 5);
  for (const reader of [store, ...evidenceReaders]) {
    await reader.refresh?.();
    const compound = await acceptedAssetProvenance({ store: reader, reads: { rulesContext }, asset: crafted.compound.id });
    assert.equal(compound.maker, maker.owner); assert.equal(compound.tier, 5);
    const asset = 'p2:' + own.number, found = await acceptedAssetProvenance({ store: reader, reads: { rulesContext }, asset, block: '1' });
    assert.deepEqual(found.find, store.get('finds', r.findIdV2('1', String(own.number)))); assert.equal(found.pattern.discoverer, maker.owner);
    assert.equal((await acceptedAssetProvenance({ store: reader, reads: { rulesContext }, asset, block: '999999999999999999999' })).find, null);
  }
  assert.equal(store.get('compoundTypes', crafted.compound.id).tier.value, null, 'original type remains immutable');
  const second = await maker.craft({ actionId: 'craft-child', recipe: 'fusion', inputs: [[crafted.compound.id, '1'], [`p2:${own.number}`, '1']] }); await drain();
  assert.equal(second.compound.properties.generation, '2'); assert.equal(available(crafted.compound.id), '0'); assert.equal(available(second.compound.id), '1');
  const before = await contract.state().batchLast();
  await assert.rejects(maker.craft({ actionId: 'no-balance', recipe: 'fusion', inputs: [[crafted.compound.id, '1'], [`p2:${own.number}`, '1']] }), /account_insufficient/);
  assert.deepEqual(await contract.state().batchLast(), before);
  assert.equal(craftAttacks, 4);
  const pay = async (transition, evidence) => {
    financialSources.set(r.hashObject(transition), evidence); await financial.submit(transition); await drain();
    assert.equal(store.count('financialQueue'), 0);
  };
  assert.equal(approvals % 5, 0); assert.ok(proofRequests > approvals);
  await t.test('settled p2 find deploys, registers, quotes, reserves, pays and receives a mint permit over HTTP', async t => {
    const player = players[7], p = patterns.find(p => p.name === player.proposal.name);
    await firstMintFixture(t, { store, contract, document, network, secret, committeeSecret, rulesContext, stamp, financial, drain,
      agent: player.agent, catalogAsset: 'p2:' + p.number, sourceReady: reads => { firstMintReads = reads; } });
  });
  await t.test('imported p2 catalog pattern spends its settled p0 find through the same first-mint flow', async t => {
    assert.equal(store.get('finds', 'f2:1:0').asset, 'p0');
    await firstMintFixture(t, { store, contract, document, network, secret, committeeSecret, rulesContext, stamp, financial, drain,
      agent: players[7].agent, catalogAsset: 'p2:0', sourceReady: reads => { firstMintReads = reads; } });
    assert.equal(store.get('provisioning', 'p2:0'), null, 'no duplicate token for the catalog alias');
  });
  const feeds = new Feeds({ store, files, history: replayHistory, reads: {}, settings: { feedEventRows: 19 } });
  const publicAPI = createPublicAPI({ views: { store }, files });
  await assert.rejects(publicAPI.read('/patterns'), /public_projection_pending/);
  for (let i = 0; store.count('feedEvents') && i < 1000; i++) await feeds.events();
  assert.equal(store.count('feedEvents'), 0);
  assert.equal((await publicAPI.read('/patterns')).patterns.length, 9);
  const projectedCompound = store.get('catalogTypes', crafted.compound.id);
  const { tierProgress, ...compoundRecord } = projectedCompound;
  assert.deepEqual(compoundRecord, store.get('compoundTypes', crafted.compound.id));
  assert.deepEqual(tierProgress, store.get('compoundTiers', crafted.compound.id));
  assert.equal(tierProgress.value, refinement.tier);
  assert.equal(store.get('catalogAgents', maker.owner).craftCount, '2');
  assert.equal(store.db.prepare("SELECT n FROM publicItemCountsV2 WHERE kind='events' AND scope=''").get().n,
    store.countUint('publicEvents'));
  for (const type of ['find', 'header_find', 'discovery', 'craft']) {
    let cursor, found = false;
    do {
      const page = await publicAPI.read('/events?' + new URLSearchParams({ type, limit: '1', ...(cursor ? { cursor } : {}) }));
      found = page.events.some(event => event.type === type); cursor = page.next;
    } while (!found && cursor);
    assert.ok(found, 'individual ' + type + ' event');
  }
  for (const p of players) {
    const pattern = patterns.find(q => q.name === p.proposal.name), asset = 'p2:' + pattern.number;
    const page = await publicAPI.read('/patterns/' + asset + '/claimed-blocks?limit=50&found=true');
    assert.equal(page.knownMatchCount, store.get('catalogPatterns', asset).knownMatchCount); assert.equal(page.rows.length, 50); assert.ok(page.nextCursor);
    assert.ok(page.rows.every(row => row.find?.finderUntil));
    assert.equal(store.get('catalogAgents', p.agent.owner).discoveryCount, p === players[7] ? '2' : '1');
    const balance = await publicAPI.read('/accounts/' + p.agent.owner + '/balances/' + asset);
    assert.equal(balance.account.root, contract.db.get('ar/' + p.agent.owner).root);
    assert.deepEqual(readAccountLeaf(balance.account.root, balance.proof, accountKey('balance', asset)),
      readAccountLeaf(balance.account.root, new AccountAvailability(store).prove(balance.account.root, [accountKey('balance', asset)]), accountKey('balance', asset)));
  }
  for (let i = 0; store.count('feedPages') && i < 50; i++) await feeds.tick();
  assert.equal(store.count('feedPages'), 0);
  const amendment = r.settingsRevision({ network, previous: document,
    effectiveBatch: r.addUint((await contract.state().batchLast()).n, '2'), effectiveBitcoinWindow: '1020',
    values: { ...document.values, claimsPerWindow: 120, finderWindow: 1200, batchBytes: 100000, receiptSegmentEntries: 1, observationBudget: 1, batchKv: 2 } });
  assert.equal(await contract.run('ad_settings', { document: amendment }), null);
  tip = 1019; await contract.advance(1); await observe(); await drain();
  assert.equal(await contract.run('ad_apply', { id: 'settings' }), null);
  // Leave a real kit receipt queued under the predecessor. Its reserved batch
  // executes after the new document's two activation boundaries are reached.
  await players[0].agent.propose({ actionId: 'amendment-pending', proposal: players[0].proposal, history, witnesses });
  const pendingMove = players[0].agent.journal.get('discovery/amendment-pending/commit').body;
  assert.equal(pendingMove.settingsHash, r.hashObject(document));
  await players[1].agent.propose({ actionId: 'amendment-pending-second', proposal: players[1].proposal, history, witnesses });
  const secondMove = players[1].agent.journal.get('discovery/amendment-pending-second/commit').body;
  await maker.claim({ event: { window: tip, hash: history.hashAt(tip) }, plots: [{ block: 102, patterns: [ingredient.number] }], history, patterns });
  const predecessor = await rulesContext();
  const fence = await runtime.intake.fence({ document, successor: amendment, predecessor: {
    n: predecessor.last.n, root: contract.db.get('bt/' + predecessor.last.n), claims: predecessor.claimsRoot, catalog: predecessor.catalogRoot } });
  const cutoffSegments = fence.evidence.segments ?? Array.from({ length: Number(fence.cutoff.segmentCount) }, (_, i) =>
    store.get('receiptCutoffPages', r.receiptCutoffPageKey(r.hashObject(document), String(i))).segment);
  for (const segment of cutoffSegments) await committee.attestRoot(segment.seal);
  assert.equal(cutoffSegments.flatMap(s => s.receipts).length, 3);
  tip = 1020; await contract.advance(1); await observe(); await drain();
  assert.equal(contract.db.get('v2/receipt-renewal/' + r.hashObject(fence.cutoff)).state, 'consumed');
  assert.equal(contract.db.get('v2/settings').revision, '1');
  assert.equal(runtime.settings.settingsRevision, '1');
  const namedState = new r.NamedStorage({ get: id => store.get('namedNodes', id), cacheSize: 64 }).load(store.get('meta', 'ruleState').namedSnapshot);
  const retained = r.namedGet(namedState.records, `commit/${players[0].agent.owner}/${pendingMove.p.commitment}`);
  assert.equal(retained.settingsHash, r.hashObject(document));
  assert.equal(r.namedGet(namedState.records, `commit/${players[1].agent.owner}/${secondMove.p.commitment}`).settingsHash, r.hashObject(document));
  const originalFind = store.list('finds', { limit: 1 })[0].value;
  assert.equal(originalFind.finderUntil, r.addUint(originalFind.findHeight, String(document.values.finderWindow)));
  for (tip = 1021; tip <= 1022; tip++) { await contract.advance(1); await observe(); await drain(); } tip = 1022;
  const boundaryFind = store.get('finds', `f2:102:${ingredient.number}`);
  assert.equal(boundaryFind.finder, maker.owner);
  assert.equal(boundaryFind.settingsHash, r.hashObject(document));
  assert.equal(boundaryFind.finderUntil, r.addUint(boundaryFind.findHeight, String(document.values.finderWindow)));
  await players[0].agent.reveal({ actionId: 'amendment-pending', history }); await drain();
  const reopened = new r.NamedStorage({ get: id => store.get('namedNodes', id), cacheSize: 64 }).load(store.get('meta', 'ruleState').namedSnapshot);
  assert.equal(r.namedGet(reopened.records, `commit/${players[0].agent.owner}/${pendingMove.p.commitment}`).opened, true);
  await players[1].agent.reveal({ actionId: 'amendment-pending-second', history }); await drain();
  const paidItems = [{ key: r.hash('mg1-payment'), fee: fees[0].key, amount: '2', total: '2' }];
  await pay({ type: 'fund', id: requestId, items: paidItems }, { requestId, owner: payer.owner, terms: reservationAction.terms,
    items: paidItems, state: 'settled', confirmations: 1 });
  const permitHash = r.hash('mg1-permit');
  await pay({ type: 'consume', id: requestId, permitHash }, { requestId, owner: payer.owner, terms: reservationAction.terms,
    state: 'authorized', permitHash, fundingRoot: contract.db.get('fp/' + requestId).root });
  assert.equal(contract.db.get('ao/' + requestId).state, 'consumed'); assert.equal(store.count('financialAccepted'), 11);
  assert.equal(store.get('meta', 'ruleState').claimRoot, contract.db.get('v2/claims'));
  assert.equal(financial.document.revision, '1');
  assert.equal(contract.db.get('ao/' + requestId).terms, r.hashObject(terms));
  attackChecks.finish();
  // Recover the accepted/publication indexes, then serve the same verified
  // records to real kit HTTP clients while retaining independent root checks.
  while (store.count('feedEvents')) await feeds.events();
  await store.close(); store = await Store.open(join(path, 'gateway'));
  const recoveredAPI = createPublicAPI({ views: { store, reads: new Proxy({}, { get() { throw Error('public_source_request'); } }) }, files });
  const headers = new HeaderChunks({ store, files, history: { ...replayHistory, length: tip + 1 }, network: 'regtest', secret, settings: { chunkRows: 128, chunksPerTick: 2 } });
  do { await headers.tick(); } while (headers.manifest().count < tip + 1);
  const recoveredHTTP = await serve({ intake: { store }, files, headers, publicAPI: recoveredAPI }); closes.push(() => recoveredHTTP.close());
  const readsBefore = proofRequests, readStarted = performance.now();
  const replies = await Promise.all(Array.from({ length: 500 }, async (_, i) => {
    const p = players[i % players.length], pattern = patterns.find(q => q.name === p.proposal.name), asset = 'p2:' + pattern.number;
    const client = new ServiceClient({ origin: recoveredHTTP.url });
    if (i % 2) return client.claimedBlocks(asset, { limit: 2, found: true });
    const balance = await client.readPage('/accounts/' + p.agent.owner + '/balances/' + asset);
    assert.equal(balance.account.root, contract.db.get('ar/' + p.agent.owner).root);
    assert.deepEqual(readAccountLeaf(balance.account.root, balance.proof, accountKey('balance', asset)), new AccountAvailability(store).prove(balance.account.root, [accountKey('balance', asset)]).leaves[0].value);
    return balance;
  }));
  assert.equal(replies.length, 500); assert.equal(proofRequests, readsBefore);
  const readElapsedMs = performance.now() - readStarted;
  const source = { manifest: async () => (await fetch(recoveredHTTP.url + '/headers/manifest.json')).json(), hash: async h => history.hashAt(h),
    archive: (route, { start = 0 }) => fetch(recoveredHTTP.url + route, { headers: start ? { range: `bytes=${start}-` } : {} }) };
  const downloaded = await downloadArchive({ output: join(path, 'downloaded.bin'), source, independent: { hash: source.hash }, network: 'regtest', manifestTrust: manifestTrust(edPublic(secret)) });
  assert.equal(downloaded.count, tip + 1); assert.equal(downloaded.tip, history.hashAt(tip));
  t.diagnostic(JSON.stringify({ players: 8, signers: 5, claimsPerPlayer: 100, explicitFinds: 803, implicitFinds: 2, mixedCraftFinancialBatches: mixedBatches, financialTransitions: 11, acceptedV2Batches: String(BigInt((await contract.state().batchLast()).n) - 1n),
    readyRevealMs: timings[0], publicReadClientsAfterRestart: 500, publicReadElapsedMs: readElapsedMs, headerDownloadBytes: downloaded.downloadedBytes, publicReadSourceRequests: 0, approvals, targetedEvidenceRequests: proofRequests, importedRecords: imported.importRows, maximumProofBytes, proofBudget: document.values.proofBytes,
    signing: 'five independent HTTP policies; disposable common key, no TSS in this fixture' }));
});
