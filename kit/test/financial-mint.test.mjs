import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { makeFinancialMint } from '../lib/financial-mint.mjs';
import { financialMintId } from '../../rules/src/financial-mint.js';
import { hashObject, settingsRevision, SETTINGS_PROFILE } from '../../rules/src/index.js';
import { cleanup, temp, testWallet } from './helpers.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { gameTools } from '../lib/tools.mjs';

for (const tamper of [false, true]) test(`v2 kit preserves the reservation packet and refuses changed actions: tamper=${tamper}`, async t => {
  const directory = await temp(t), network = 'dmw-kit-test', wallet = testWallet();
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '20', values: { ...SETTINGS_PROFILE } });
  const context = { settings, settingsHash: hashObject(settings) }, packets = []; let lost = true;
  let journal = await Journal.open(directory, network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const service = { network, paymentLink: id => 'http://127.0.0.1/mint/' + id, mintQuote: async () => ({ feeQuote: { settingsHash: context.settingsHash } }),
    requestMint: async body => {
      const id = financialMintId(network, body.request); packets.push(structuredClone(body));
      if (body.reserve) { if (lost) { lost = false; throw Error('lost_response'); } return { id, requestId: id, state: 'reserving' }; }
      const r = body.request, evidence = { version: 2, requestId: id, owner: r.owner, asset: r.asset, amount: r.amount,
        receiver: body.receiver, payer: body.payer, rail: body.kind, expiry: r.expires, settingsHash: r.settingsHash, request: r,
        quote: body.feeQuote, signature: body.signature, authorization: body.authorization };
      return { id, state: 'authorizing', reservationEvidence: evidence, reservationAction: { type: 'reserve', id, owner: r.owner,
        asset: r.asset, amount: tamper ? '99' : r.amount, terms: hashObject(evidence), revision: '0', nonce: r.nonce, until: r.until } };
    } };
  const a = new Agent({ wallet, network, service, journal, dryRun: false, trac: { network, settingsByHash: async hash => hash === context.settingsHash ? settings : null, head: async () => ({ counted: 20, tip: { height: 20 } }) } });
  const intent = { asset: 'c1', amount: '3', receiver: 'receiver', payer: 'payer', kind: 'tap', compound: true };
  await assert.rejects(makeFinancialMint(a, intent, 'same', null, context), tamper ? /Mint reservation action mismatch/ : /lost_response/);
  if (tamper) { assert.equal(packets.length, 1); assert.equal(journal.get('mint/same/reservation-v2'), null); return; }
  journal.close(); journal = a.journal = await Journal.open(directory, network, { intervalMs: 0 });
  const amended = settingsRevision({ network, previous: settings, effectiveBatch: '2', effectiveBitcoinWindow: '20', values: { ...SETTINGS_PROFILE, pendingBlocks: 500 } });
  await makeFinancialMint(a, intent, 'same', null, { settings: amended, settingsHash: hashObject(amended) });
  assert.equal(packets[2].request.until, String(20 + settings.values.moveFreshnessTips)); assert.equal(packets[2].request.expires, String(20 + settings.values.pendingBlocks));
  assert.deepEqual(packets[1], packets[2]);
  const status = await a.status(); assert.equal(status.actions.length, 1); assert.equal(status.actions[0].id, 'mint/same');
  assert.equal(status.actions[0].requestId, financialMintId(network, packets[1].request));
});

for (const [asset, ledger] of [['p2:0', 'p0'], ['p0', 'p0'], ['p2:1', 'p2:1']]) test(`v2 mint offers deployment without signing or reserving: ${asset}`, async t => {
  const directory = await temp(t), network = 'dmw-kit-test', wallet = testWallet();
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '20', values: { ...SETTINGS_PROFILE } });
  const context = { settings, settingsHash: hashObject(settings) }, journal = await Journal.open(directory, network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const service = new ServiceClient({ network }); let state = 'deployment_needed';
  service.mintQuote = async value => {
    assert.equal(value.asset, ledger);
    return { state, asset: ledger, catalogAsset: ledger === 'p0' ? 'p2:0' : asset, deploymentNeeded: state === 'deployment_needed', payable: false, requestId: null };
  };
  service.requestMint = () => assert.fail('must not submit before deployment');
  const a = new Agent({ wallet, network, service, journal, dryRun: false, trac: { network, head: async () => ({ counted: '20' }) } });
  const intent = { asset, amount: '3', block: '1', receiver: 'receiver', payer: 'payer', kind: 'tap', compound: false };
  const candidate = { find: { asset: ledger, block: '1', count: '3', finder: a.owner, findHeight: '19', finderUntil: '100', settingsHash: context.settingsHash } };
  const result = await makeFinancialMint(a, intent, 'first', candidate, context);
  assert.equal(result.state, 'deployment_needed'); assert.equal(result.signed, false);
  assert.deepEqual(result.next, [{ tool: 'inscribe_deployment', arguments: { asset: ledger } }]);
  assert.equal(new URL(result.deploymentLink).searchParams.get('owner'), encodeTracAddress(a.owner));
  assert.equal(new URL(result.deploymentLink).pathname, '/mint/' + result.catalogAsset);
  state = 'deployment_pending';
  const pending = await makeFinancialMint(a, intent, 'first', candidate, context);
  assert.equal(pending.signed, false); assert.equal(pending.next[0].arguments.actionId, 'first');
  assert.equal(journal.recent().length, 0);
});

test('service client accepts p2 deployment routes and rejects ambiguous or malformed assets', async () => {
  const calls = [], service = new ServiceClient({ fetchImpl: async (url, options) => {
    calls.push([new URL(url).pathname, options.method]); return new Response('{}', { headers: { 'content-type': 'application/json' } });
  } });
  await service.deployment('p2:1'); await service.deploymentState('p2:0'); await service.deployment('p0');
  assert.deepEqual(calls, [['/mint/deployment/p2:1', 'GET'], ['/mint/deployment-state/p2:0', 'GET'], ['/mint/deployment/p0', 'GET']]);
  for (const asset of ['p2:01', 'p2:-1', 'p2:1/other', 'p2%3A1']) assert.throws(() => service.deployment(asset), /Invalid deployment asset/);
});

test('public deployment tools accept p2 IDs and register the authoritative legacy alias', async () => {
  const packets = [], agent = { dryRun: false, bitcoinWallet: {}, playerMint: { deploy: args => args }, service: {
    deployment: async asset => ({ asset: 'p0', catalogAsset: asset, kind: 'dmt' }),
    submitDeployment: async value => { packets.push(value); return value; }
  } };
  const tools = gameTools({ agent });
  const args = tools.inscribe_deployment.schema.parse({ asset: 'p2:1', maxFeeSats: '10000' });
  assert.equal((await tools.inscribe_deployment.run(args)).asset, 'p2:1');
  const registration = { asset: 'p2:0', phase: 'element', inscription: 'aa'.repeat(32) + 'i0' };
  await tools.register_deployment.run(tools.register_deployment.schema.parse(registration));
  assert.deepEqual(packets, [{ ...registration, asset: 'p0' }]);
  await assert.rejects(tools.register_deployment.run({ ...registration, asset: 'p2:1' }), /Only this compound/);
  for (const asset of ['p2:01', 'p2:-1', 'p2:1/other']) assert.equal(tools.inscribe_deployment.schema.safeParse({ ...args, asset }).success, false);
});

test('local agent gate opens linked nonholder mints and retains the finder week', async t => {
  const directory = await temp(t), network = 'dmw-kit-test', wallet = testWallet();
  const { PUBLIC_MINT_SETTINGS, hash } = await import('../../rules/src/index.js');
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '100',
    values: { ...SETTINGS_PROFILE, ...PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '100', bitmapMintOpenHeight: '110' } });
  const context = { settings, settingsHash: hashObject(settings) }, journal = await Journal.open(directory, network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  let counted = '109';
  const service = { network, mintQuote: async () => ({ feeQuote: { settingsHash: context.settingsHash } }) };
  const a = new Agent({ wallet, network, service, journal, dryRun: true, trac: { network, head: async () => ({ counted }) } });
  const candidate = { link: { block: '1', linkHeight: '101' }, currentHolder: hash('holder'),
    find: { asset: 'p2:0', block: '1', count: '3', finder: hash('finder'), findHeight: '102', finderUntil: '105', settingsHash: context.settingsHash } };
  const intent = { asset: 'p2:0', block: '1', amount: '3', receiver: 'receiver', payer: 'payer', kind: 'tap' };
  await assert.rejects(makeFinancialMint(a, intent, 'open', candidate, context), /Mint right unavailable/);
  counted = '110'; assert.equal((await makeFinancialMint(a, intent, 'open', candidate, context)).state, 'dry-run');
  const { chooseMint } = await import('../strategies/default.mjs');
  assert.equal(chooseMint({ candidates: [candidate], owner: a.owner, counted, balance: '3', settings }), candidate);
  assert.equal(chooseMint({ candidates: [candidate], owner: a.owner, counted, balance: '2', settings }), null);
  candidate.find.finderUntil = '111';
  await assert.rejects(makeFinancialMint(a, intent, 'week', candidate, context), /Mint right unavailable/);
  candidate.find.finder = a.owner;
  assert.equal((await makeFinancialMint(a, intent, 'week', candidate, context)).state, 'dry-run');
  assert.equal(journal.recent().length, 0);
});

test('selected ticker is quoted by choice and its immutable deployment is bound in the signed mint request', async t => {
  const directory = await temp(t), network = 'dmw-kit-test', wallet = testWallet();
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '20', values: SETTINGS_PROFILE });
  const context = { settings, settingsHash: hashObject(settings) }, deployment = 'd'.repeat(64) + 'i0';
  const journal = await Journal.open(directory, network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  let counted = '2099999999';
  const service = { network, mintQuote: async input => { assert.equal(input.deployment, 'chosen'); return { feeQuote: { settingsHash: context.settingsHash, deploymentId: deployment } }; } };
  const a = new Agent({ wallet, network, service, journal, dryRun: true, trac: { network, head: async () => ({ counted }) } });
  const intent = { asset: 'c1', amount: '3', receiver: 'receiver', payer: 'payer', kind: 'tap', compound: true, deployment: 'chosen' };
  await assert.rejects(makeFinancialMint(a, intent, 'choice', null, context), /multi_ticker_inactive/);
  counted = '2100000000'; const preview = await makeFinancialMint(a, intent, 'choice', null, context);
  assert.equal(preview.request.deployment, deployment);
  assert.notEqual(financialMintId(network, preview.request), financialMintId(network, { ...preview.request, deployment: 'e'.repeat(64) + 'i0' }));
  assert.equal(journal.recent().length, 0);
});

test('ticker tool dry run never requests a fee or inscribes and read choices use the new routes', async () => {
  const calls = [], service = new ServiceClient({ fetchImpl: async (url, options) => { calls.push([new URL(url).pathname, options.method]); return new Response('{}', { headers: { 'content-type': 'application/json' } }); } });
  await service.assetTickers('p2:1'); await service.tickerState('p2:1', 'chosen');
  assert.deepEqual(calls, [['/assets/p2:1/tickers', 'GET'], ['/mint/ticker-state/p2:1', 'GET']]);
  const agent = { dryRun: true, bitcoinWallet: { address: 'receiver' }, service: { deployTicker: () => assert.fail('dry run must not POST') } };
  const tools = gameTools({ agent });
  const tool = tools.deploy_ticker;
  assert.ok(tool);
  const result = await tool.run(tool.schema.parse({ asset: 'p2:1', ticker: 'chosen' }));
  assert.equal(result.state, 'dry-run'); assert.equal(result.sent, false);
});


test('active additional ticker mint uses its own candidate and refuses a candidate from another ticker', async t => {
  const directory = await temp(t), network = 'dmw-kit-test', wallet = testWallet();
  const { PER_TICKER_SUPPLY_HEIGHT } = await import('../../rules/src/index.js');
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '20', values: SETTINGS_PROFILE });
  const context = { settings, settingsHash: hashObject(settings) }, deployment = 'd'.repeat(64) + 'i0';
  const journal = await Journal.open(directory, network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const service = { network, mintQuote: async input => { assert.equal(input.deployment, deployment); return { feeQuote: { settingsHash: context.settingsHash, deploymentId: deployment } }; } };
  const agent = new Agent({ wallet, network, service, journal, dryRun: true, trac: { network, head: async () => ({ counted: PER_TICKER_SUPPLY_HEIGHT }) } });
  const intent = { asset: 'p2:0', block: '1', amount: '3', receiver: 'receiver', payer: 'payer', kind: 'tap', deployment };
  const candidate = { deployment, minted: false, pending: null,
    find: { asset: intent.asset, block: '1', count: '3', finder: agent.owner, findHeight: '10', finderUntil: '20', settingsHash: context.settingsHash } };
  const result = await makeFinancialMint(agent, intent, 'additional', candidate, context);
  assert.equal(result.state, 'dry-run'); assert.equal(result.request.deployment, deployment);
  await assert.rejects(makeFinancialMint(agent, intent, 'wrong', { ...candidate, deployment: undefined }, context), /Mint candidate deployment mismatch/);
  for (const flags of [{ minted: true }, { pending: { id: 'pending' } }])
    await assert.rejects(makeFinancialMint(agent, intent, 'duplicate', { ...candidate, ...flags }, context), /Mint right unavailable/);
});

test('mint_on_chain overlaps three requests, preserves action idempotency and ignores mining turn exhaustion', { timeout: 10000 }, async t => {
  const { dashboardFixture } = await import('./fixtures/dashboard-service.mjs');
  const { runTool } = await import('../lib/tools.mjs');
  const f = await dashboardFixture(t); f.minted.delete('10');
  f.agent.journal = f.journal; f.journal.take(20);
  const original = f.service.requestMint.bind(f.service), pending = [], bodies = [];
  let ready; const entered = new Promise(resolve => { ready = resolve; });
  f.service.requestMint = async body => {
    if (body.reserve) {
      bodies.push(body); const wait = new Promise(resolve => pending.push(resolve));
      if (bodies.length === 3) ready(); await wait;
    }
    return original(body);
  };
  t.after(() => pending.forEach(resolve => resolve()));
  const args = ['12', '11', '10'].map(block => ({ actionId: 'parallel-' + block, asset: 'p2:1', block, amount: '3',
    receiver: f.binding.request.address, payer: f.binding.request.address, kind: 'tap' }));
  const tasks = [...args, args[0]].map(a => runTool(f.context, 'mint_on_chain', a));
  await entered;
  await assert.rejects(runTool(f.context, 'mint_on_chain', { ...args[0], amount: '4' }), /Conflicting mint action ID/);
  assert.equal(new Set(bodies.map(b => b.request.nonce)).size, 3);
  pending.forEach(resolve => resolve());
  const results = await Promise.all(tasks);
  assert.equal(new Set(results.map(r => r.request.requestId)).size, 3);
  assert.equal(results[0].request.requestId, results[3].request.requestId);
  assert.equal(f.packets.length, 6);
  const retry = await runTool(f.context, 'mint_on_chain', args[0]);
  assert.equal(retry.request.requestId, results[0].request.requestId); assert.equal(f.packets.length, 6);
});
