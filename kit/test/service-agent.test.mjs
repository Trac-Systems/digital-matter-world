import { bitcoinAddress } from './helpers.mjs';
import { feeFixture } from '../../service/test/helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { Store } from '../../service/src/store.mjs';
import { Intake } from '../../service/src/intake.mjs';
import { Files } from '../../service/src/files.mjs';
import { serve } from '../../service/src/http.mjs';
import { createPublicAPI } from '../../service/src/public-api.mjs';
import { Mints, verifyPayer } from '../../service/src/mints.mjs';
import { processBlock, buildBatch, merkleProof, verifyRequest } from '../../rules/src/index.js';
import { Agent } from '../lib/agent.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { Journal } from '../lib/journal.mjs';
import { publicAddress } from '../lib/keyring.mjs';
import { loadHistory } from '../lib/headers.mjs';
import { cleanup, temp, testWallet, history, patterns, fakeTrac, witnesses } from './helpers.mjs';

async function fixture(t) {
  const dir = await temp(t), hist = history(), wallet = testWallet(), network = 'dmw-kit-test', secret = Buffer.alloc(32, 9);
  const store = await Store.open(join(dir, 'service')), files = new Files(join(dir, 'static'));
  const intake = new Intake({ store, network, secret, hashAt: hist.hashAt, puzzleBits: 0 });
  await intake.observe({ tip: 20, hash: hist.hashAt(20), counted: 15, confirmed: 15 });
  const publicViews = { catalog: () => ({ patterns: [], compounds: [] }), receipts: () => [] };
  const publicAPI = createPublicAPI({ files, views: publicViews });
  const http = await serve({ intake, files, publicAPI });
  cleanup(t, async () => { await http.close(); await store.close(); });
  const witness = witnesses(), service = new ServiceClient({ origin: http.url, network, gateway: intake.gateway, receiptSigners: witness.members });
  const journal = await Journal.open(join(dir, 'signer'), `${network}/${publicAddress(wallet)}`, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const { trac, state } = fakeTrac(hist, { network });
  const agent = new Agent({ bitcoinNetwork: 'regtest', wallet, network, service, trac, journal, dryRun: false, puzzleBits: 0, powLimitBits: 0x207fffff });
  return { dir, hist, wallet, network, store, files, intake, http, service, journal, trac, state, agent, witness, publicViews };
}
test('real gateway accepts a bundled claim, survives lost HTTP response and produces verifiable audit inclusion', async t => {
  const f = await fixture(t), { hist, agent, service, intake, store, files } = f;
  let lost = true;
  service.fetchImpl = async (...args) => { const response = await fetch(...args); if (args[1].method === 'POST' && lost) { lost = false; await response.arrayBuffer(); throw new Error('response lost'); } return response; };
  const claim = { event: { window: 20, hash: hist.hashAt(20) }, plots: [{ block: 20, patterns: [0, 2] }], history: hist, patterns, header: { height: 20, raw: hist.raw(20) } };
  await assert.rejects(agent.claim(claim), /outcome may be unknown/);
  assert.equal(f.journal.get('claim/20').state, 'unknown'); assert.equal(store.count('dedupe'), 1);
  const result = await agent.claim(claim); assert.equal(result.state, 'received'); assert.equal(result.receipt.sequence, 1);
  assert.equal((await agent.claim(claim)).replayed, true); assert.equal(store.count('dedupe'), 1);
  await assert.rejects(agent.claim({ ...claim, plots: [{ block: 20, patterns: [0] }] }), /Conflicting/);
  const entries = intake.entries().map(r => r.value), sealed = await intake.observe({ tip: 21, hash: hist.hashAt(21), counted: 16, confirmed: 16 });
  const output = processBlock({ network: f.network, gateway: intake.gateway, height: 15, blockHash: hist.hashAt(15), tip: 20, tipHash: hist.hashAt(20), history: hist, patterns,
    entries, receiptRoot: sealed.receiptRoot, rootAttestations: f.witness.attest(sealed.receiptRoot), hashAt: hist.hashAt, state: { lastTip: 19, counted: 14 }, settings: { puzzleBits: 0, receiptSigners: f.witness.members } });
  assert.equal(output.file.moves[0].reason, 'accepted');
  const publication = await files.publish(output, sealed);
  const batch = buildBatch({ network: f.network, executionHeight: 15, epoch: 0, sequence: 1, lastTo: 14, files: [output.file] });
  const resultFile = await service.audit(publication, { hashAt: hist.hashAt, commitment: { proof: merkleProof([output.auditBytes], 0), root: batch.batch.root } });
  assert.equal(resultFile.contractCommitted, true); assert.equal(resultFile.file.receipts[0].move, result.receipt.move);
  assert.equal(result.inclusion, 'unverified'); assert.equal(resultFile.witnessed, true);
  assert.equal((await agent.claimInclusion({ window: 20, publication })).receipt.move, result.receipt.move);
  f.publicViews.receipts = () => [...Array.from({ length: 200 }, (_, n) => ({ id: String(n).padStart(4, '0'), height: 20, seal: sealed.receiptRoot, archive: null })),
    { id: '9999', height: 20, seal: sealed.receiptRoot, archive: publication.audit }];
  service.latest = async () => { throw Error('The current publication no longer contains this old receipt'); };
  const found = await agent.claimInclusion({ window: 20 });
  assert.equal(found.verified, true); assert.equal(found.inclusion, 'witnessed'); assert.equal(found.contractCommitted, false);
  assert.equal(found.publication.height, publication.height); assert.equal(found.publication.audit.hash, publication.audit.hash);
  await assert.rejects(service.audit({ ...publication, audit: { ...publication.audit, hash: '00'.repeat(32) } }, { hashAt: hist.hashAt }), /hash mismatch/);
});
test('dry-run never sends; tip changes, closed claims and mismatching header data fail before signing', async t => {
  const f = await fixture(t), { agent, hist } = f;
  agent.dryRun = true;
  const result = await agent.headers({ height: 20, raw: hist.raw(20) }); assert.equal(result.signed, false); assert.equal(f.store.count('dedupe'), 0); assert.equal(f.journal.recent().length, 0);
  agent.dryRun = false;
  await assert.rejects(agent.headers({ height: 20, raw: hist.raw(19) }), /proof of work/);
  await assert.rejects(agent.claim({ event: { window: 18, hash: hist.hashAt(18) }, plots: [{ block: 18, patterns: [0] }], patterns, history: hist }), /closed/);
  const original = f.trac.head.bind(f.trac); let reads = 0;
  f.trac.head = async () => { const head = await original(); if (++reads === 2) return { ...head, tip: hist.get(21) }; return head; };
  await assert.rejects(agent.headers({ height: 20, raw: hist.raw(20) }), /Tip changed/); assert.equal(f.store.count('dedupe'), 0);
});
test('the default pass sends a header with an empty table and directs the player to discovery', async t => {
  const f = await fixture(t);
  f.agent.dryRun = true;
  const preview = await f.agent.runOnce({ history: f.hist });
  assert.equal(preview.state, 'discovery_needed'); assert.equal(preview.header.signed, false);
  assert.equal(f.store.count('dedupe'), 0);
  f.agent.dryRun = false;
  const result = await f.agent.runOnce({ history: f.hist });
  assert.equal(result.state, 'discovery_needed'); assert.equal(result.header.state, 'received');
  assert.deepEqual(result.next.map(n => n.tool), ['search_patterns', 'propose_pattern', 'reveal_pattern']);
  assert.equal(f.journal.recent().length, 1); assert.equal(f.store.count('dedupe'), 1);
  assert.equal(f.intake.entries()[0].value.move.t, 'header');
});
test('craft signs an exact owner exchange and enforces stable action IDs', async t => {
  const { agent, hist, store, network } = await fixture(t);
  const result = await agent.craft({ actionId: 'fusion-1', inputs: [['p0', '2'], ['p1', '2']], patterns });
  assert.equal(result.state, 'received'); assert.equal(result.compound.amount, '2');
  const move = store.list('dedupe')[0].value, signed = agent.journal.get('craft/fusion-1').body;
  assert.equal(verifyRequest('xc', network, signed.p.request, signed.p.sig, 15), true);
  assert.equal(move.receipt.move.length, 64);
  await assert.rejects(agent.craft({ actionId: 'fusion-1', inputs: [['p0', '1'], ['p1', '1']], patterns }), /Conflicting/);
  assert.equal((await agent.craft({ actionId: 'fusion-1', inputs: [['p0', '2'], ['p1', '2']], patterns })).replayed, true);
});
test('proposal sender verifies all history and submits only a secret commitment to the gateway', async t => {
  const f = await fixture(t), path = join(f.dir, 'mainnet.bin');
  await writeFile(path, Buffer.from((await readFile(new URL('./fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex'));
  const history = await loadHistory(path), hashAt = h => history.get(h).hash;
  f.intake.hashAt = hashAt; await f.intake.observe({ tip: 63, hash: hashAt(63), counted: 58, confirmed: 58 });
  f.agent.trac = fakeTrac({ get: h => history.get(h), hashAt }, { network: f.network, tip: 63 }).trac;
  const proposal = { name: 'dmwnewdigits', pat: '[12]', fld: 4, dt: 'n' };
  const result = await f.agent.propose({ actionId: 'digits', proposal, history, patterns: [] });
  assert.equal(result.state, 'received'); assert.equal(result.revealFrom, 65); assert.equal(result.revealUntil, 207);
  assert.deepEqual(f.journal.get('discovery/digits/commit').body.p, { commitment: result.commitment });
  assert.equal(JSON.stringify(result).includes(proposal.pat), false);
  assert.equal(f.store.count('dedupe'), 1);
  await assert.rejects(f.agent.propose({ actionId: 'rare', proposal: { ...proposal, name: 'dmwtooexact', pat: '^63$' }, history, patterns: [] }), /too_rare/);
});
test('owner-signed mint and payer authorization match the real service verifier and do not pay', async t => {
  const f = await fixture(t), calls = [];
  const mint = new Mints({ store: f.store, network: f.network, operations: { supportsMintBatches: true }, committee: {}, payments: {}, inscriber: { quote: async () => '100' }, reads: {
    ...feeFixture({ store: f.store, network: f.network, baseFee: '10' }), counted: async () => 15, balance: async () => '100', isMinted: async () => false,
    assetContext: async () => ({ deployment: { active: true, kind: 'dmt' }, tier: 1,
      treasury: 'local-treasury', finderAddress: 'local-finder', find: { block: 10, asset: 'p0', count: 2, finder: f.agent.owner, findHeight: 10 } })
  } });
  const http = await serve({ intake: f.intake, files: f.files, mints: mint }); cleanup(t, () => http.close());
  f.agent.service = new ServiceClient({ origin: http.url, network: f.network, gateway: f.intake.gateway, fetchImpl: async (url, options) => { calls.push(new URL(url).pathname); return fetch(url, options); } });
  const args = { actionId: 'mint-one', asset: 'p0', amount: '2', block: 10, receiver: bitcoinAddress(), payer: bitcoinAddress('regtest', 2), candidate: { found: true, minted: false, pending: false, find: { block: 10, asset: 'p0', count: 2, finder: f.agent.owner, findHeight: 10 } } };
  const send = f.agent.service.fetchImpl; let lost = false;
  f.agent.service.fetchImpl = async (url, options) => {
    const response = await send(url, options);
    if (new URL(url).pathname === '/mint/quote' && JSON.parse(options.body).request && !lost) { lost = true; await response.arrayBuffer(); throw Error('Lost mint response'); }
    return response;
  };
  await assert.rejects(f.agent.makeReal(args), /outcome may be unknown/);
  f.state.balances.p0 = '0';
  const result = await f.agent.makeReal(args); assert.equal(result.state, 'submitted'); assert.equal(result.replayed, true); assert.match(result.paymentLink, /\/mint\/[0-9a-f]{64}$/);
  assert.equal(calls.filter(p => p === '/mint/quote').length, 2); f.state.balances.p0 = '100';
  const body = f.journal.get('mint/mint-one').body;
  assert.equal(verifyPayer(f.network, body), true); assert.equal(verifyPayer(f.network, { ...body, payer: 'different' }), false);
  assert.deepEqual(body.feeQuote, f.store.get('mints', result.request.id).quote.feeQuote);
  assert.equal(verifyPayer(f.network, { ...body, feeQuote: { ...body.feeQuote, payouts: { discoverer: 'ab'.repeat(32) } } }), false);
  assert.equal(result.request.state, 'awaiting_payment'); assert.equal(calls.includes('/mint/payment'), false);
  assert.equal((await f.agent.makeReal(args)).replayed, true);
  const journalStatus = (await f.agent.status()).actions.find(row => row.id === 'mint/mint-one');
  assert.equal(journalStatus.requestId, result.request.id); assert.equal(journalStatus.statusTool.arguments.id, result.request.id);
  assert.equal((await f.agent.mintStatus('mint/mint-one')).id, result.request.id);
  assert.equal(JSON.stringify(journalStatus).includes(body.signature), false);
  await assert.rejects(f.agent.makeReal({ ...args, actionId: 'wrong-count', amount: '1' }), /mint_count/);
  await assert.rejects(f.agent.makeReal({ ...args, actionId: 'wrong-owner', candidate: { ...args.candidate, find: { ...args.candidate.find, finder: 'cc'.repeat(32) } } }), /mint_finder/);
});
test('HTTP client refuses nonlocal gateways, redirects and oversized responses', async t => {
  assert.throws(() => new ServiceClient({ origin: 'https://example.com' }), /loopback/);
  const server = createServer((req, res) => { if (req.url === '/redirect') { res.writeHead(302, { location: '/health' }); res.end(); } else res.end('x'.repeat(100)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup(t, () => new Promise(resolve => server.close(resolve)));
  const client = new ServiceClient({ origin: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(client.request('/health', { limit: 20 }), /too large/);
  await assert.rejects(client.request('/redirect'), /unavailable/);
  await assert.rejects(client.request('//elsewhere'), /Invalid/);
});

test('HTTP failures identify service, route and status without suggesting a read submitted anything', async () => {
  const origin = 'http://127.0.0.1:5555';
  const client = new ServiceClient({ origin, fetchImpl: async () => { throw Object.assign(Error('private-password'), { cause: { code: 'ECONNREFUSED' } }); } });
  for (const call of [() => client.patterns({ limit: 2 }), () => client.events(), () => client.mintQuote({ asset: 'p0', block: 1 })]) {
    await assert.rejects(call(), error => /Gateway service http:\/\/127.0.0.1:5555 (GET|POST) \/.*no HTTP response, code ECONNREFUSED/.test(error.message) && !/outcome|private-password/.test(error.message));
  }
  await assert.rejects(client.requestMint({request:{}}), /\/mint\/quote: no HTTP response.*submission outcome may be unknown/);
  client.fetchImpl = async () => Response.json({ error: 'asset_unregistered', secret: 'private-password' }, { status: 400 });
  await assert.rejects(client.mintQuote({ asset: 'p3' }), error => error.status === 400 && /POST \/mint\/quote: HTTP 400, code asset_unregistered/.test(error.message) && /Deployment needed/.test(error.message) && !/outcome|private-password/.test(error.message));
  client.fetchImpl = async () => new Response('secret invalid JSON');
  await assert.rejects(client.patterns(), /GET \/patterns: HTTP 200, code invalid_json/);
  client.fetchImpl = async () => new Response(new ReadableStream({ start(controller) { controller.error(Error('private-password')); } }));
  await assert.rejects(client.events(), error => /HTTP 200.*response body interrupted/.test(error.message) && !/outcome|private-password/.test(error.message));
});

test('mint retry preserves signed expiry and canonical payer when the client suggestion changes', async t => {
  const f = await fixture(t), submitted = [];
  let duration = 100;
  f.trac.settings = async () => ({ pending_blocks: duration });
  f.service.quote = async () => ({ total: '100' });
  f.service.mintStatus = async () => { throw Object.assign(Error('missing'), { status: 404 }); };
  f.service.requestMint = async body => {
    submitted.push(structuredClone(body));
    if (submitted.length === 1) throw Error('unknown result');
    const { pendingId } = await import('../../rules/src/index.js');
    return { id: pendingId(f.network, body.request), state: 'reserving' };
  };
  const args = { actionId: 'retry-expiry', asset: 'c1', amount: '1', compound: true, receiver: bitcoinAddress(), payer: '0x' + 'AB'.repeat(20), kind: 'ethereum' };
  await assert.rejects(f.agent.makeReal(args), /unknown result/);
  assert.equal(submitted[0].request.expires, 120);
  assert.equal(submitted[0].payer, args.payer.toLowerCase());
  duration = 2016; f.state.tip = 21;
  assert.equal((await f.agent.makeReal({ ...args, payer: args.payer.toLowerCase() })).state, 'submitted');
  assert.deepEqual(submitted[0], submitted[1]);
  assert.equal(verifyPayer(f.network, submitted[1]), true);
  assert.equal(verifyPayer(f.network, { ...submitted[1], request: { ...submitted[1].request, expires: 116 } }), false);
});

test('a first-mint deployment quote returns the next wallet step without reserving units', async t => {
  const f = await fixture(t);
  f.service.mintQuote = async () => ({ state: 'deployment_needed', deploymentNeeded: true, requestId: null, payable: false });
  f.service.requestMint = () => { throw Error('must not reserve before deployment'); };
  const result = await f.agent.makeReal({ actionId: 'needs-deployment', asset: 'p0', block: 10, amount: '1',
    receiver: bitcoinAddress(), payer: bitcoinAddress(), candidate: { found: true, find: { asset: 'p0', block: 10, count: 1, finder: f.agent.owner, findHeight: 10 } } });
  assert.equal(result.state, 'deployment_needed'); assert.equal(result.signed, false);
  assert.equal(result.next[0].tool, 'inscribe_deployment'); assert.equal(f.journal.recent().length, 0);
});
