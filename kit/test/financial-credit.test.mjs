import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { submitFinancialCredit } from '../lib/financial-credit.mjs';
import { hashObject, settingsRevision, SETTINGS_PROFILE } from '../../rules/src/index.js';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { publicKey } from '../lib/keyring.mjs';
import { cleanup, temp, testWallet } from './helpers.mjs';

for (const transfer of [false, true]) test(`credit packet survives response loss and accepted revision change: transfer=${transfer}`, async t => {
  const directory = await temp(t), network = 'dmw-kit-test', wallet = testWallet(), owner = publicKey(wallet), packets = [];
  const credit = 'a'.repeat(64), request = 'b'.repeat(64), fee = 'c'.repeat(64);
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '20', values: { ...SETTINGS_PROFILE } });
  let journal = await Journal.open(directory, network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const service = { network, financialAction: async action => {
    packets.push(structuredClone(action)); if (packets.length === 1) throw Error('response_lost');
    return { id: hashObject(['dmw-financial-transition-v2', { type: 'lifecycle', id: action.id, action }]), state: 'accepted' };
  } };
  const a = new Agent({ wallet, network, service, journal, dryRun: false, trac: { network,
    head: async () => ({ counted: '1' + '0'.repeat(79), tip: { height: '1' + '0'.repeat(79) } }), financialRecord: async key => key.startsWith('fc/') ?
      { owner, revision: '0', fees: [{ key: fee, amount: '10' }] } : { owner, state: 'open', paid: ['0'], fees: [{ key: fee, amount: '10' }] } } });
  a.namedContext = async () => ({ settings, settingsHash: hashObject(settings) });
  const args = { actionId: 'retry', credit, ...(transfer ? { to: encodeTracAddress('d'.repeat(64)) } : { request, items: [{ fee, amount: '3' }] }) };
  await assert.rejects(submitFinancialCredit(a, args), /response_lost/);
  journal.close(); journal = a.journal = await Journal.open(directory, network, { intervalMs: 0 });
  a.trac.financialRecord = () => assert.fail('uncertain signed revision must not be replaced');
  assert.equal((await submitFinancialCredit(a, args)).state, 'accepted');
  assert.deepEqual(packets[0], packets[1]);
  await assert.rejects(submitFinancialCredit(a, { ...args, credit: 'e'.repeat(64) }), /Conflicting credit action ID/);
});

test('credit discovery verifies accepted ownership and balances and matches exact fee denominations', async () => {
  const { listFeeCredits, matchingCreditItems } = await import('../lib/financial-credit.mjs');
  const owner = 'a'.repeat(64), id = 'b'.repeat(64), request = 'c'.repeat(64), fee = 'd'.repeat(64), foreign = 'e'.repeat(64), calls = [];
  const credit = { owner, revision: '2', fees: [{ key: fee, amount: '8' }] }, target = { owner, state: 'open', fees: [{ key: fee, amount: '10' }], paid: ['4'] };
  const agent = { owner, address: encodeTracAddress(owner), service: { results: async options => {
    calls.push(options); return { credits: [{ id, amount: '999', origin: { requestId: 'f'.repeat(64), orderId: null } }, { id: foreign }], nextCursor: 'next-page' };
  } }, trac: { financialRecord: async key => key === 'fc/' + id ? credit : key === 'fp/' + request ? target : { ...credit, owner: foreign } } };
  const page = await listFeeCredits(agent, { request, limit: 2 });
  assert.equal(calls[0].owner, agent.address); assert.equal(page.next, 'next-page'); assert.equal(page.credits.length, 1);
  assert.equal(page.credits[0].amount, '8'); assert.equal(page.credits[0].matchingAmount, '6'); assert.equal(page.credits[0].usable, true);
  assert.deepEqual(matchingCreditItems(credit, { ...target, owner: foreign }), []);
  assert.deepEqual(matchingCreditItems(credit, { ...target, fees: [{ key: foreign, amount: '10' }] }), []);
  agent.service.results = async () => ({ credits: [], next: 'empty-page-next' });
  assert.equal((await listFeeCredits(agent)).next, 'empty-page-next');
});

test('matching credit retry uses its exact saved items after confirmation or response loss', async () => {
  const { applyMatchingCredit } = await import('../lib/financial-credit.mjs');
  const credit = 'a'.repeat(64), request = 'b'.repeat(64), items = [{ fee: 'c'.repeat(64), amount: '7' }];
  const agent = { journal: { get: () => ({ body: { action: { operation: { type: 'use', credit, id: request, items } } } }) },
    trac: { financialRecord: () => assert.fail('never refresh an existing signed intent') }, useCredit: async value => value };
  assert.deepEqual(await applyMatchingCredit(agent, { actionId: 'same', credit, request }), { actionId: 'same', credit, request, items });
  await assert.rejects(applyMatchingCredit(agent, { actionId: 'same', credit, request: 'd'.repeat(64) }), /Conflicting/);
});
