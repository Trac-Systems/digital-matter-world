import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { makeFinancialMint } from '../lib/financial-mint.mjs';
import { financialMintId } from '../../rules/src/financial-mint.js';
import { hashObject, settingsRevision, SETTINGS_PROFILE } from '../../rules/src/index.js';
import { cleanup, temp, testWallet } from './helpers.mjs';

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
