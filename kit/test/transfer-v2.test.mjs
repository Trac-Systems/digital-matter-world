import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import { settingsRevision, SETTINGS_PROFILE, hashObject } from '../../rules/src/index.js';
import { accountActionDigest } from '../../contract/root-accounts.js';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { explainError } from '../lib/errors.mjs';
import { prepareTransferV2 } from '../lib/transfer-v2.mjs';
import { runTool } from '../lib/tools.mjs';
import { temp, cleanup, testWallet } from './helpers.mjs';

const network = 'transfer-unit-v2', recipient = testWallet(2).publicKey.toString('hex'), to = encodeTracAddress(recipient);
const compound = 'c2:' + 'ab'.repeat(32);
const settings = settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...SETTINGS_PROFILE } });
const context = { ready: true, settings, settingsHash: hashObject(settings) };
async function fixture(t, { dryRun = false } = {}) {
  const directory = await temp(t), wallet = testWallet(), balances = { 'p2:1': '9007199254740993', p0: '10', [compound]: '3' };
  const state = { revision: '9007199254740993', root: 'ac'.repeat(32), counted: '10', signed: 0, reads: [] };
  const trac = { network, head: async () => ({ counted: state.counted, tip: { height: state.counted } }),
    accountRoot: async () => ({ root: state.root, revision: state.revision }),
    balance: async (_, asset) => { state.reads.push(asset); return balances[asset] ?? '0'; },
    prepare: () => assert.fail('no legacy transaction'), submit: () => assert.fail('no legacy send') };
  const agent = new Agent({ network, wallet: { publicKey: wallet.publicKey, sign: bytes => { state.signed++; return wallet.sign(bytes); } }, trac,
    service: { network, submit: () => assert.fail('no unsupported move'), financialAction: () => assert.fail('no financial send') },
    journal: await Journal.open(directory, network), dryRun });
  agent.namedContext = async () => context;
  agent.catalog = async () => [{ number: 0, key: '11'.repeat(32), legacy: { asset: 'p0' } }, { number: 1, key: '22'.repeat(32) }];
  cleanup(t, () => agent.journal.close());
  return { agent, directory, state, balances };
}
const args = (actionId = 'keep', assets = [['p2:1', '9007199254740993']]) => ({ actionId, op: 'tf', value: { to, assets } });
const unavailable = error => error.code === 'transfer_v2_unavailable' && error.prepared === true && error.sent === false;

test('v2 transfer saves exact contract authorizations without a gateway or TNK submission', async t => {
  const { agent, state } = await fixture(t);
  const request = args('keep', [['p2:1', '9007199254740993'], ['p0', '2'], [compound, '1']]);
  await assert.rejects(agent.transaction(request), unavailable);
  const row = agent.journal.get('tx/keep/v2-intent');
  assert.equal(row.state, 'prepared'); assert.equal(agent.journal.get('tx/keep'), null);
  assert.equal(state.signed, 3); assert.deepEqual(state.reads, request.value.assets.map(([asset]) => asset));
  assert.equal(new Set(row.body.actions.map(a => a.nonce)).size, 3);
  for (const [i, action] of row.body.actions.entries()) {
    assert.deepEqual(Object.keys(action).sort(), ['type', 'owner', 'to', 'asset', 'amount', 'revision', 'nonce', 'until', 'sig'].sort());
    assert.equal(action.type, 'transfer'); assert.equal(action.owner, agent.owner); assert.equal(action.to, recipient);
    assert.deepEqual([action.asset, action.amount], request.value.assets[i]);
    assert.equal(action.revision, state.revision); assert.equal(action.until, String(10 + settings.values.requestMaxBlocks));
    assert.ok(ed25519.verify(action.sig, accountActionDigest(network, action), agent.owner));
  }
  const status = await agent.status();
  assert.deepEqual(status.actions, [{ id: 'tx/keep/v2-intent', state: 'prepared', outcome: null, settlement: null }]);
  assert.ok(!JSON.stringify(status).includes(row.body.actions[0].sig));
  assert.match(explainError(new Error('transfer_v2_unavailable')), /nothing is submitted or charged/);
});

test('v2 transfer retry after restart preserves signatures, nonce, revision and expiry', async t => {
  const { agent, state, directory } = await fixture(t);
  await assert.rejects(agent.transaction(args()), unavailable);
  const saved = agent.journal.get('tx/keep/v2-intent');
  agent.journal.close(); agent.journal = await Journal.open(directory, network);
  state.counted = '999999'; state.revision = '9007199254740994';
  agent.trac.balance = () => assert.fail('retry must preserve an already prepared authorization');
  agent.trac.accountRoot = () => assert.fail('retry must not refresh the revision');
  await assert.rejects(agent.transaction(args()), unavailable);
  assert.deepEqual(agent.journal.get('tx/keep/v2-intent'), saved); assert.equal(state.signed, 1);
  await assert.rejects(agent.transaction(args('keep', [['p2:1', '1']])), /Conflicting transaction action ID/);
  await assert.rejects(agent.transaction({ ...args(), value: { ...args().value, to: encodeTracAddress(testWallet(3).publicKey.toString('hex')) } }), /Conflicting transaction action ID/);
  assert.deepEqual(agent.journal.get('tx/keep/v2-intent'), saved);
});

test('v2 dry-run reports unavailable, creates no journal row, signs nothing and exposes no saved signature', async t => {
  const { agent, state } = await fixture(t, { dryRun: true });
  const result = await runTool({ agent }, 'transfer', { actionId: 'keep', ...args().value });
  assert.equal(result.state, 'dry-run'); assert.equal(result.supported, false); assert.equal(result.reason, 'transfer_v2_unavailable');
  assert.equal(result.signed, false); assert.equal(result.sent, false); assert.equal(state.signed, 0);
  assert.deepEqual(agent.journal.recent(), []); assert.equal(result.value.to, to);
  agent.dryRun = false; await assert.rejects(agent.transaction(args()), unavailable);
  const saved = agent.journal.get('tx/keep/v2-intent');
  agent.dryRun = true; const preview = await agent.transaction(args());
  assert.ok(!JSON.stringify(preview).includes(saved.body.actions[0].sig));
  assert.deepEqual(agent.journal.get('tx/keep/v2-intent'), saved); assert.equal(state.signed, 1);
});

test('v2 transfer rejects bad addresses, amounts and repeated assets before any account read or signature', async t => {
  const { agent, state } = await fixture(t);
  for (const bad of [recipient, to.slice(0, -1) + (to.endsWith('q') ? 'p' : 'q'), '', 'bc1bad']) {
    await assert.rejects(agent.transaction({ ...args(), value: { to: bad, assets: [['p0', '1']] } }), /trac1/);
  }
  for (const assets of [[], [['p0', '0']], [['p0', '01']], [['p0', '-1']], [['p0', 1]], [['p0', '1.5']],
    [['p2:01', '1']], [['p0', '1'.repeat(79)]], [['p0', '1'], ['p0', '2']], Array.from({ length: 17 }, (_, i) => ['p2:' + i, '1'])]) {
    await assert.rejects(agent.transaction(args('bad', assets)), /transfer_assets/);
  }
  assert.deepEqual(state.reads, []); assert.equal(state.signed, 0); assert.deepEqual(agent.journal.recent(), []);
});

test('v2 preflight distinguishes unknown assets, insufficient available units and imported ledger keys', async t => {
  const { agent, state, balances } = await fixture(t);
  await assert.rejects(agent.transaction(args('unknown', [['p2:99', '1']])), /transfer_unknown_asset/);
  await assert.rejects(agent.transaction(args('over', [['p0', '11']])), /transfer_insufficient_units/);
  await assert.rejects(agent.transaction(args('alias', [['p2:0', '1']])), /transfer_insufficient_units/);
  balances.p0 = '0';
  await assert.rejects(agent.transaction(args('held', [['p0', '1']])), /transfer_insufficient_units/);
  assert.equal(state.signed, 0); assert.deepEqual(agent.journal.recent(), []);
});

test('v2 preflight rejects a changed account, malformed balance and account budget overflow before signing', async t => {
  const { agent, state } = await fixture(t); let reads = 0;
  agent.trac.accountRoot = async () => ({ root: state.root, revision: String(++reads) });
  await assert.rejects(agent.transaction(args()), /transfer_account_changed/);
  agent.trac.balance = async () => '01';
  await assert.rejects(agent.transaction(args()), /transfer_balance/);
  await assert.rejects(prepareTransferV2(agent, args('limit', [['p0', '1'], ['p2:1', '1']]),
    { ...context, settings: { values: { ...settings.values, accountActions: 1 } } }), /transfer_capacity/);
  assert.equal(state.signed, 0); assert.deepEqual(agent.journal.recent(), []);
});

test('v2 never overwrites or replaces a saved legacy transaction with the same action ID', async t => {
  const { agent, state } = await fixture(t);
  agent.journal.reserve('tx/keep', { op: 'tf', value: { to: recipient, assets: [['p0', '1']] } }, { tx: 'ab'.repeat(32), nonce: 'cd'.repeat(32) });
  agent.journal.mark('tx/keep', 'unknown'); const saved = agent.journal.get('tx/keep');
  await assert.rejects(agent.transaction(args('keep', [['p0', '1']])), /transfer_legacy_action/);
  assert.deepEqual(agent.journal.get('tx/keep'), saved); assert.equal(agent.journal.get('tx/keep/v2-intent'), null);
  assert.equal(state.signed, 0); assert.deepEqual(state.reads, []);
});

test('a saved v2 authorization cannot fall back to a legacy TNK transaction', async t => {
  const { agent, state } = await fixture(t), request = args('keep', [['p0', '1']]);
  await assert.rejects(agent.transaction(request), unavailable);
  const saved = agent.journal.get('tx/keep/v2-intent');
  agent.namedContext = async () => null;
  await assert.rejects(agent.transaction(request), /transfer_v2_unavailable/);
  assert.equal(agent.journal.get('tx/keep'), null); assert.deepEqual(agent.journal.get('tx/keep/v2-intent'), saved); assert.equal(state.signed, 1);
});

for (const dryRun of [true, false]) test(`transfer intent is captured before asynchronous balance reads, dryRun=${dryRun}`, async t => {
  const { agent } = await fixture(t, { dryRun }), request = args('keep', [['p0', '1']]);
  agent.trac.balance = async () => { request.value.assets[0][1] = '9'; request.value.to = agent.address; return '10'; };
  if (dryRun) {
    const preview = await agent.transaction(request);
    assert.deepEqual(preview.value, { to, assets: [['p0', '1']] }); assert.deepEqual(agent.journal.recent(), []);
  } else {
    await assert.rejects(agent.transaction(request), unavailable);
    const action = agent.journal.get('tx/keep/v2-intent').body.actions[0];
    assert.equal(action.amount, '1'); assert.equal(action.to, recipient);
    await assert.rejects(agent.transaction(args('keep', [['p0', '1']])), unavailable);
  }
});

async function activate(f) {
  const { PUBLIC_MINT_SETTINGS, checkMoveV2 } = await import('../../rules/src/index.js');
  const document = settingsRevision({ network, previous: settings, effectiveBatch: '2', effectiveBitcoinWindow: '8',
    values: { ...settings.values, ...PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '10', puzzleBits: 0 } });
  f.agent.namedContext = async () => ({ ...context, settings: document, settingsHash: hashObject(document) });
  f.agent.trac.head = async () => ({ counted: f.state.counted, tip: { height: f.state.counted, hash: 'aa'.repeat(32) } });
  f.agent.trac.hashAt = async () => 'aa'.repeat(32);
  f.agent.journal.intervalMs = 0;
  const packets = [];
  f.agent.service.submit = async move => {
    assert.equal(checkMoveV2(move, { settings: document, tip: f.state.counted, hashAt: () => 'aa'.repeat(32) }), null);
    packets.push(structuredClone(move)); return { move: 'receipt-' + packets.length };
  };
  return { document, packets };
}

test('activation submits the durable pre-activation authorization and exact received retry signs and sends nothing', async t => {
  const f = await fixture(t), request = args();
  await assert.rejects(f.agent.transaction(request), unavailable);
  const intent = f.agent.journal.get('tx/keep/v2-intent'), { packets } = await activate(f);
  const result = await f.agent.transaction(request);
  assert.equal(result.state, 'received'); assert.equal(result.inclusion, 'unverified');
  assert.equal(packets.length, 1); assert.equal(packets[0].t, 'transfer-v2');
  assert.deepEqual(packets[0].p.actions, intent.body.actions);
  assert.deepEqual(f.agent.journal.get('tx/keep/v2-intent'), intent);
  const signed = f.state.signed;
  f.state.revision = '9007199254740994';
  const again = await f.agent.transaction(request);
  assert.equal(again.replayed, true); assert.deepEqual(again.receipt, result.receipt);
  assert.equal(packets.length, 1); assert.equal(f.state.signed, signed);
  assert.equal(f.agent.journal.get('tx/keep'), null, 'legacy transaction slot remains unused');
});

test('activated dry-run never signs, submits or exposes saved signatures', async t => {
  const f = await fixture(t, { dryRun: true }), { packets } = await activate(f);
  const result = await f.agent.transaction(args());
  assert.equal(result.supported, true); assert.equal(result.sent, false); assert.equal(result.signed, false);
  assert.equal(result.reason, undefined); assert.equal(packets.length, 0); assert.equal(f.state.signed, 0);
  assert.deepEqual(f.agent.journal.recent(), []);
});

test('activation refuses stale and expired unsent authorizations without refreshing the durable intent', async t => {
  for (const expiry of [false, true]) {
    const f = await fixture(t); await assert.rejects(f.agent.transaction(args()), unavailable);
    const saved = f.agent.journal.get('tx/keep/v2-intent'); await activate(f);
    if (expiry) f.state.counted = String(BigInt(saved.body.actions[0].until) + 1n);
    else f.state.revision = '9007199254740994';
    await assert.rejects(f.agent.transaction(args()), expiry ? /transfer_intent_expired/ : /transfer_intent_stale/);
    assert.equal(f.state.signed, 1); assert.equal(f.agent.journal.get('tx/keep/v2-move'), null);
    assert.deepEqual(f.agent.journal.get('tx/keep/v2-intent'), saved);
  }
});

test('uncertain activated submission retains the packet after restart and does not reauthorize a changed account', async t => {
  const f = await fixture(t); await activate(f); let first;
  f.agent.service.submit = async move => { first = structuredClone(move); throw Error('connection_lost'); };
  await assert.rejects(f.agent.transaction(args()), /connection_lost/);
  const saved = f.agent.journal.get('tx/keep/v2-intent'); assert.equal(f.agent.journal.get('tx/keep/v2-move').state, 'unknown');
  f.agent.journal.close(); f.agent.journal = await Journal.open(f.directory, network, { intervalMs: 0 });
  f.agent.trac.accountRoot = () => assert.fail('do not refresh an uncertain authorization');
  f.agent.trac.balance = () => assert.fail('do not reauthorize an uncertain transfer');
  f.agent.service.submit = async move => { assert.deepEqual(move, first); return { move: 'retained-receipt' }; };
  assert.equal((await f.agent.transaction(args())).state, 'received');
  assert.deepEqual(f.agent.journal.get('tx/keep/v2-intent'), saved); assert.equal(f.state.signed, 2);
});
