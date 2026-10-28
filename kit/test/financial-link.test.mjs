import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { makeFinancialLink } from '../lib/financial-link.mjs';
import { financialLinkId } from '../../rules/src/financial-link.js';
import { hashObject, settingsRevision, SETTINGS_PROFILE } from '../../rules/src/index.js';
import { cleanup, temp, testWallet } from './helpers.mjs';

for (const tamper of [false, true]) test(`kit link reservation preserves exact signed packets across restart and amendment: tamper=${tamper}`, async t => {
  const directory = await temp(t), network = 'dmw-kit-test', wallet = testWallet(), height = '1' + '0'.repeat(79);
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '20', values: { ...SETTINGS_PROFILE } });
  const context = { settings, settingsHash: hashObject(settings) }, packets = []; let lost = true;
  let journal = await Journal.open(directory, network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const service = { network, paymentLink: id => 'http://127.0.0.1/link/' + id, linkQuote: async () => ({ feeQuote: { settingsHash: context.settingsHash } }),
    requestLink: async body => {
      const r = body.request, id = financialLinkId(network, r); packets.push(structuredClone(body));
      if (body.reserve) { if (lost) { lost = false; throw Error('lost_response'); } return { id, state: 'reserving' }; }
      const evidence = { version: 2, state: 'reservable', requestId: id, owner: r.owner, bitmapOwner: r.owner, block: r.block,
        until: r.until, payer: r.payer, receiver: r.payer, rail: 'tap', settingsHash: r.settingsHash, request: r, quote: body.feeQuote, signature: body.signature };
      return { id, state: 'authorizing', reservationEvidence: evidence, reservationAction: { type: 'link-reserve', id, owner: r.owner,
        block: tamper ? '4' : r.block, terms: hashObject(evidence), until: r.until } };
    } };
  const a = new Agent({ wallet, network, service, journal, dryRun: false, trac: { network,
    settingsByHash: async hash => hash === context.settingsHash ? settings : null, head: async () => ({ counted: height, tip: { height } }) } });
  const args = { actionId: 'same', height, payer: 'payer' };
  await assert.rejects(makeFinancialLink(a, args, context), tamper ? /Link reservation action mismatch/ : /lost_response/);
  if (tamper) { assert.equal(packets.length, 1); assert.equal(journal.get('link/same/reservation-v2'), null); return; }
  journal.close(); journal = a.journal = await Journal.open(directory, network, { intervalMs: 0 });
  const amended = settingsRevision({ network, previous: settings, effectiveBatch: '2', effectiveBitcoinWindow: '20', values: { ...SETTINGS_PROFILE, pendingBlocks: 500 } });
  await makeFinancialLink(a, args, { settings: amended, settingsHash: hashObject(amended) });
  assert.deepEqual(packets[1], packets[2]);
  assert.equal(packets[2].request.until, (BigInt(height) + BigInt(settings.values.pendingBlocks)).toString());
  assert.equal(journal.get('link/same').state, 'submitted');
});
