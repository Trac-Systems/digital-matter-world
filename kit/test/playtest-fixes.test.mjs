import { publicIdentities } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bech32, bech32m } from '@scure/base';
import { Agent } from '../lib/agent.mjs';
import { Journal } from '../lib/journal.mjs';
import { bitcoinAddress as validateBitcoin } from '../lib/addresses.mjs';
import { gameTools, runTool } from '../lib/tools.mjs';
import { pendingId, linkId, discoveryCommitment } from '../../rules/src/index.js';
import { temp, cleanup, history, fakeTrac, testWallet, bitcoinAddress, patterns } from './helpers.mjs';

async function fixture(t) {
  const directory = await temp(t), { trac, state } = fakeTrac(history()), journal = await Journal.open(directory, 'playtest', { intervalMs: 0 });
  cleanup(t, () => journal.close());
  const owner = { receiver: { bitcoin: bitcoinAddress(), ethereum: '0x' + 'ab'.repeat(20) }, payer: { tap: bitcoinAddress('regtest', 2), ethereum: '0x' + 'AB'.repeat(20) } };
  const calls = [], service = { network: trac.network, paymentLink: (id, origin, kind = 'mint') => `http://127.0.0.1/${kind}/${id}`,
    mintQuote: async () => ({ price: '1' }), requestMint: async body => { calls.push(body); return { id: pendingId(trac.network, body.request), state: 'waiting_payment' }; },
    requestLink: async body => { calls.push(body); return { id: linkId(trac.network, body.request), terms: { payer: body.payer } }; },
    patterns: async () => ({ patterns: [], total: 0, limit: 50, next: null }) };
  const agent = new Agent({ wallet: testWallet(), network: trac.network, trac, journal, service, bitcoinNetwork: 'regtest', owner, puzzleBits: 0 });
  return { agent, service, journal, state, calls, owner };
}

test('Bitcoin validation checks checksum, witness encoding and mainnet/regtest versions', () => {
  const main = bitcoinAddress('mainnet'), reg = bitcoinAddress();
  for (const [value, network] of [[main, 'mainnet'], [reg, 'regtest'], ['1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'mainnet']]) assert.equal(validateBitcoin(value, network), value);
  const v0 = bech32.encode('bcrt', [0, ...bech32.toWords(new Uint8Array(20).fill(3))]);
  assert.equal(validateBitcoin(v0, 'regtest'), v0);
  for (const [value, network] of [['OWNER_ADDRESS', 'regtest'], [main, 'regtest'], [reg, 'mainnet'], [reg.slice(0, -1) + (reg.endsWith('q') ? 'p' : 'q'), 'regtest'],
    [bech32m.encode('bcrt', [0, ...bech32m.toWords(new Uint8Array(20))]), 'regtest'], ['1BoatSLRHtKNngkdXEeobR76b53LETtpyU', 'mainnet']]) assert.throws(() => validateBitcoin(value, network), /Invalid Bitcoin/);
});

test('dry and live actions validate addresses, use immutable owner defaults and previews omit payment links', async t => {
  const f = await fixture(t), mint = { actionId: 'mint', asset: 'c1', amount: '1', compound: true };
  assert.throws(() => { f.agent.ownerConfig.payer.tap = 'changed'; }, TypeError);
  for (const dryRun of [true, false]) {
    f.agent.dryRun = dryRun;
    for (const receiver of ['OWNER_RECEIVER_ADDRESS', bitcoinAddress('mainnet'), '0x' + 'ab'.repeat(20)]) await assert.rejects(f.agent.makeReal({ ...mint, receiver }), /Bitcoin receiver/);
    for (const payer of ['OWNER_PAYER_ADDRESS', bitcoinAddress('mainnet')]) {
      await assert.rejects(f.agent.makeReal({ ...mint, payer }), /Bitcoin payer/);
      await assert.rejects(f.agent.linkBitmap({ actionId: 'bad', height: 1, payer }), /Bitcoin payer/);
    }
    await assert.rejects(f.agent.makeReal({ ...mint, kind: 'ethereum', payer: bitcoinAddress() }), /Ethereum payer/);
    assert.equal(f.calls.length, 0);
  }
  for (const dryRun of [true, false]) {
    f.agent.dryRun = dryRun;
    for (const kind of ['tap', 'ethereum']) {
      const result = await f.agent.makeReal({ ...mint, actionId: 'mint-' + kind, kind });
      if (dryRun) { assert.equal(result.paymentLink, undefined); assert.equal(result.receiver, f.owner.receiver.bitcoin); assert.equal(result.payer, f.owner.payer[kind].toLowerCase()); }
      else { assert.ok(result.paymentLink); assert.equal(f.calls.at(-1).payer, f.owner.payer[kind].toLowerCase()); }
    }
    for (const method of ['linkBitmap']) {
      const result = await f.agent[method]({ actionId: method, height: 1 });
      if (dryRun) { assert.equal(result.paymentLink, undefined); assert.equal(result.payer, f.owner.payer.tap); }
      else assert.equal(f.calls.at(-1).payer, f.owner.payer.tap);
    }
    if (dryRun) assert.equal(f.journal.recent().length, 0);
  }
});

test('ideas explain empty results and warn about unregistered output and consumed finder slots', async t => {
  const f = await fixture(t);
  f.agent.catalog = async () => patterns.slice(0, 2);
  f.state.balances = { p0: '0', p1: '0' };
  assert.deepEqual(await runTool({ agent: f.agent }, 'compound_idea'), { suggestion: null, reason: 'no_balance' });
  assert.deepEqual(await runTool({ agent: f.agent }, 'mint_idea', { asset: 'p0' }), { suggestion: null, reason: 'no_balance' });
  f.state.balances = { p0: '1', p1: '1' };
  f.agent.mintRights = async ({ asset }) => ({ mintRights: asset.startsWith('c') ? [] : [{ asset, block: 1, amount: '1', allowed: true, whoMayMint: 'finder' }], total: asset.startsWith('c') ? 0 : 1, next: null });
  const result = await runTool({ agent: f.agent }, 'compound_idea');
  assert.ok(result.suggestion.id.startsWith('c')); assert.equal(result.reason, null);
  assert.deepEqual(result.warnings.map(w => w.code), ['asset_unregistered', 'consumes_mintable_finder_units']);
  assert.ok(result.warnings[1].slots.every(s => s.blocksMint && s.remaining === '0'));
  assert.deepEqual(await runTool({ agent: f.agent }, 'mint_idea', { asset: 'p0' }), { suggestion: null, reason: 'no_eligible_slot' });
});

test('shared registry exposes every tool in both references and unknown tools list valid names', async t => {
  const f = await fixture(t), tools = gameTools({ agent: f.agent });
  for (const path of ['../llms.txt', '../docs/ACTIONS.md']) {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    for (const name of Object.keys(tools)) assert.ok(text.includes(name), `${path} lacks ${name}`);
  }
  await assert.rejects(runTool({ agent: f.agent }, 'unknown'), error => error.message.startsWith('Unknown tool') && Object.keys(tools).every(name => error.message.includes(name)));
  await assert.rejects(runTool({ agent: f.agent }, 'mine_once', {}, { readOnly: true }), /Use action mine_once/);
});

test('public journal outcomes preserve signed packets, discovery evaluation and idempotent retries', async t => {
  const f = await fixture(t), packet = { t: 'craft', p: { private: 'signed packet' } }, receipt = { tip: 20 };
  f.journal.reserve('craft/accepted', {}, packet); f.journal.mark('craft/accepted', 'received', receipt);
  f.journal.reserve('craft/rejected', {}, packet); f.journal.mark('craft/rejected', 'received', receipt);
  let calls = 0;
  f.service.inclusion = async () => ({ reportedOutcome: calls++ ? 'craft_inputs' : 'accepted', publication: { height: 15 }, contractCommitted: false });
  const status = await f.agent.status();
  assert.equal(status.actions.find(r => r.id === 'craft/rejected').state, 'accepted');
  assert.equal(status.actions.find(r => r.id === 'craft/accepted').state, 'rejected');
  assert.deepEqual(f.journal.get('craft/rejected').body, packet); assert.deepEqual(f.journal.get('craft/rejected').result, receipt);
  await f.agent.status(); assert.equal(calls, 2, 'terminal outcomes are not polled again');
  const proposal = { name: 'dmwexample', pat: '[12]', fld: 4, dt: 'n' }, salt = 'a'.repeat(64);
  f.journal.reserve('discovery/d', proposal, { proposal, salt }); f.journal.mark('discovery/d', 'submitted', {});
  f.journal.reserve('discovery/d/reveal', {}, { t: 'discovery-reveal', p: { proposal, salt } });
  f.journal.mark('discovery/d/reveal', 'received', receipt);
  f.service.inclusion = async () => ({ reportedOutcome: 'accepted', publication: { height: 15 }, contractCommitted: false });
  f.agent.events = async () => ({ events: [], next: null });
  f.agent.profile = async () => ({ discoveries: [], next: null });
  await f.agent.status(); assert.equal(f.journal.get('discovery/d').state, 'submitted', 'accepted reveal still awaits evaluation');
  f.agent.catalog = async () => [{ ...proposal, number: 4, discoverer: f.agent.address }];
  f.agent.profile = async () => ({ discoveries: [proposal], next: null });
  await f.agent.status(); assert.equal(f.journal.get('discovery/d').state, 'submitted', 'competing identical reveal still needs its evaluation');
  f.agent.profile = async () => ({ discoveries: [], next: null });
  await f.agent.status(); assert.equal(f.journal.get('discovery/d').state, 'accepted');
  assert.equal(f.journal.evidence('discovery/d').outcome.asset, 'p4');
  f.journal.reserve('discovery/e', proposal, { proposal, salt }); f.journal.mark('discovery/e', 'submitted', {});
  f.journal.reserve('discovery/e/reveal', {}, {});
  f.agent.events = async () => ({ events: [{ sequence: 7, data: { commitment: discoveryCommitment(proposal, salt, f.agent.owner), state: 'rejected', reason: 'pattern_duplicate' }, provenance: {} }], next: null });
  await f.agent.status(); assert.equal(f.journal.get('discovery/e').state, 'rejected');
});

test('hunting waits for every claimed plot and persists won/lost from settled draws', async t => {
  const f = await fixture(t); f.state.tip = 30;
  for (const window of [10, 11]) { f.journal.reserve('claim/' + window, {}, { t: 'claim', p: { window, plots: [{ block: window, patterns: [0, 1] }] } }); f.journal.mark('claim/' + window, 'received', { tip: window }); }
  f.service.block = async height => ({ draws: [] });
  assert.ok((await f.agent.hunting()).items.every(r => r.phase === 'check_settlement'));
  f.service.block = async height => ({ draws: [{ window: height, settledAt: height + 3, winners: height === 10 ? [{ block: height, winner: f.agent.address, pattern: 0, asset: 'p0', count: 2 }] : [] }] });
  const page = await f.agent.hunting();
  assert.equal(page.items.find(r => r.window === 10).phase, 'won'); assert.equal(page.items.find(r => r.window === 11).phase, 'lost');
  f.service.block = () => { throw Error('settled claims need not be fetched again'); };
  assert.deepEqual((await f.agent.hunting()).items, page.items);
});

test('live once returns its actual window and selections alongside the receipt', async t => {
  const f = await fixture(t), hist = history(); f.agent.catalog = async () => patterns;
  f.service.readPage = async () => ({ rows: [], next: null }); f.service.latest = async () => ({ summary: {} }); f.service.publication = async () => ({ tip: 20, tipHash: hist.hashAt(20), });
  let claimed; f.agent.claim = async args => { claimed = args; return { state: 'received', receipt: { move: 'receipt' } }; };
  f.agent.dryRun = false;
  const result = await f.agent.runOnce({ history: hist, source: { header: async () => hist.raw(20) }, strategy: () => [{ block: 20, patterns: [0, 2] }] });
  assert.equal(result.window, claimed.event.window); assert.deepEqual(result.plots, claimed.plots); assert.deepEqual(result.patterns, [0, 2]); assert.equal(result.receipt.move, 'receipt');
});


test('reconciling lost responses retains the recovered receipt or transaction identity on retry', async t => {
  const f = await fixture(t), receipt = { tip: 20, move: 'receipt' };
  f.journal.reserve('header/20', {}, { t: 'header', p: {} }); f.journal.mark('header/20', 'unknown');
  f.service.inclusion = async () => ({ receipt, reportedOutcome: 'accepted', publication: { height: 15 }, contractCommitted: false });
  await f.agent.reconcileAction('header/20'); assert.deepEqual(f.journal.get('header/20').result, receipt);
  f.agent.dryRun = false;
  const intent = { op: 'tf', value: { to: 'a'.repeat(64), assets: [['p0', '1']] } }, tx = 'b'.repeat(64);
  f.journal.reserve('tx/lost', intent, { tx }); f.journal.mark('tx/lost', 'unknown');
  f.agent.trac.transactionStatus = async () => ({ state: 'accepted' });
  await f.agent.reconcileAction('tx/lost');
  assert.deepEqual(await f.agent.transaction({ actionId: 'lost', ...publicIdentities(intent) }), { state: 'accepted', tx, replayed: true });
  assert.equal(f.calls.length, 0);
});

test('hunting and the durable journal include standalone and bundled header wins outside selected patterns', async t => {
  const f = await fixture(t); f.state.tip = 30;
  f.journal.reserve('claim/20', {}, { t: 'claim', p: { window: 20, plots: [{ block: 19, patterns: [0] }], header: { height: 20 } } });
  f.journal.reserve('header/18', {}, { t: 'header', p: { height: 18 } });
  f.service.block = async block => ({ window: 20, draws: [{ window: block === 18 ? 18 : 20, settledAt: 22, winners: block === 19 ? [] :
    [{ block, winner: f.agent.address, source: 'header', asset: 'p2', pattern: 2, count: 2 }] }] });
  const result = await f.agent.hunting();
  assert.deepEqual(result.items.map(i => i.type), ['header', 'claim']);
  assert.ok(result.items.every(i => i.phase === 'won'));
  assert.ok(result.items.every(i => i.settlement.plots.flatMap(p => p.wins).every(w => w.source === 'header')));
  assert.equal(f.journal.evidence('header/18').settlement.plots[0].wins[0].count, 2);
  assert.equal(f.journal.evidence('claim/20').settlement.plots.find(p => p.block === 20).wins[0].pattern, 2);
});
