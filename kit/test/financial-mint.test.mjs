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
