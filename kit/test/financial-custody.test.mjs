import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { claimFinancialCustody } from '../lib/financial-custody.mjs';
import { hashObject, settingsRevision, SETTINGS_PROFILE } from '../../rules/src/index.js';
import { publicKey } from '../lib/keyring.mjs';
import { cleanup, temp, testWallet, bitcoinAddress } from './helpers.mjs';

test('beneficiary claim retains its exact signed destination and revision after response loss', async t => {
  const directory = await temp(t), network = 'dmw-kit-test', wallet = testWallet(), owner = publicKey(wallet), packets = [];
  const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '20', values: { ...SETTINGS_PROFILE } });
  let journal = await Journal.open(directory, network, { intervalMs: 0 }); cleanup(t, () => journal.close());
  const a = new Agent({ wallet, network, journal, dryRun: false, bitcoinNetwork: 'regtest', service: { network, financialAction: async action => {
    packets.push(structuredClone(action)); if (packets.length === 1) throw Error('response_lost');
    return { id: hashObject(['dmw-financial-transition-v2', { type: 'lifecycle', id: action.id, action }]), state: 'accepted' };
  } }, trac: { network, head: async () => ({ counted: '100', tip: { height: '100' } }),
    financialRecord: async () => ({ owner, state: 'claimable', revision: '0', rail: 'tap', custodian: bitcoinAddress('regtest', 2) }) } });
  a.namedContext = async () => ({ settings });
  const args = { actionId: 'claim', id: 'a'.repeat(64), destination: bitcoinAddress('regtest', 3) };
  await assert.rejects(claimFinancialCustody(a, args), /response_lost/);
  journal.close(); journal = a.journal = await Journal.open(directory, network, { intervalMs: 0 });
  a.trac.financialRecord = () => assert.fail('must preserve uncertain claim');
  assert.equal((await claimFinancialCustody(a, args)).state, 'accepted'); assert.deepEqual(packets[0], packets[1]);
  await assert.rejects(claimFinancialCustody(a, { ...args, destination: bitcoinAddress('regtest', 4) }), /Conflicting custody action ID/);
});
