import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { rules } from '../src/rules.mjs';
import { reserveTicker } from '../src/ticker-availability.mjs';
import { signTapWalletMessage } from '../../rules/test/tap-wallet-signing.mjs';
const require = createRequire(new URL('../../rules/package.json', import.meta.url));
const btc = require('@scure/btc-signer'), { secp256k1 } = require('@noble/curves/secp256k1');

const makerSecret = Buffer.alloc(32, 5), otherSecret = Buffer.alloc(32, 6);
const maker = Buffer.from(ed25519.getPublicKey(makerSecret)).toString('hex');
const commitment = 'e9'.repeat(32), asset = 'c2:' + commitment;
const record = { id: asset, commitment, v: 4, recipe: 'fusion', name: 'Nullspar + Muffinite fusion', firstMaker: maker };

async function setup(t) {
  const f = await provisioningFixture(t);
  await f.store.put('officialCatalogNameIndex', 'ready', { version: 1 });
  await f.store.put('compoundTypes', asset, record);
  f.reads.officialName = async name => f.store.get('officialCatalogNames', name.toLowerCase()) ?? null;
  return f;
}
const message = (f, ticker, revision, expiry) => rules.compoundTickerMessage({ network: f.network, asset, ticker, revision, expiry, firstMaker: rules.encodeTracAddress(maker) });
function choose(f, ticker, { secret = makerSecret, revision = 1, expiry = Date.now() + 60000 } = {}) {
  const agentSignature = Buffer.from(ed25519.sign(Buffer.from(message(f, ticker, revision, expiry)), secret)).toString('hex');
  return f.operator.chooseTicker(asset, { asset, ticker, revision, expiry, agentSignature });
}
// The player's inscription of the job's current deploy text, then its registration.
async function deploy(f, job) {
  const item = job.attempts.find(a => a.phase === 'deployment' && a.attempt === job.tickerAttempt);
  const id = f.index(item.text); f.mine();
  return f.operator.submit(asset, { phase: 'deployment', inscription: id });
}

test('a compound without a chosen ticker waits for its first maker and packages no automatic ticker', async t => {
  const f = await setup(t);
  const job = await f.operator.advanceAsset(asset, record);
  assert.equal(job.state, 'awaiting_ticker'); assert.equal(job.reason, 'ticker_choice_required');
  assert.deepEqual(job.attempts, []); assert.equal(job.content, null); assert.equal(job.inscriptionText, null);
  // The periodic tick leaves it alone until the first maker acts.
  await f.operator.tick();
  assert.equal(f.store.get('provisioning', asset).updatedAt, job.updatedAt);
  // No automatic dmwc name is reserved for it.
  assert.equal(f.store.get('officialCatalogNames', 'dmwc' + commitment.slice(0, 8)), null);
  assert.deepEqual(f.store.get('officialCatalogNames', 'nullspar + muffinite fusion'), { asset, name: 'nullspar + muffinite fusion' });
});

test('the first maker chooses the ticker, the deploy text uses it, and it registers under that ticker', async t => {
  const f = await setup(t);
  let job = await choose(f, 'nullspar');
  assert.equal(job.state, 'awaiting_player_deploy'); assert.equal(job.chosenTicker.tick, 'nullspar'); assert.equal(job.chosenTicker.by, 'agent');
  assert.equal(job.content.tick, 'nullspar'); assert.equal(job.content.prov, rules.encodeTracAddress(maker));
  assert.equal(JSON.parse(job.inscriptionText).tick, 'nullspar'); assert.deepEqual(JSON.parse(job.inscriptionText), job.attempts.at(-1).text);
  assert.deepEqual(f.store.get('officialCatalogNames', 'nullspar'), { asset, name: 'nullspar' });
  assert.deepEqual(f.store.get('tickerReservations', 'nullspar'), { requestId: 'official/' + asset });
  job = await deploy(f, job);
  assert.equal(job.state, 'registered'); assert.equal(job.entry.tick, 'nullspar');
  assert.equal((await f.reads.registry()).assets[asset].tick, 'nullspar');
  // Once deployed the ticker is fixed.
  await assert.rejects(choose(f, 'other', { revision: 2 }), /ticker_fixed/);
});

test('only the first maker may choose: another key, an old revision or an expired signature is refused', async t => {
  const f = await setup(t);
  await assert.rejects(choose(f, 'nullspar', { secret: otherSecret }), /first_maker_signature/);
  await assert.rejects(choose(f, 'nullspar', { revision: 2 }), /ticker_choice_stale/);
  await assert.rejects(choose(f, 'nullspar', { expiry: Date.now() - 1 }), /ticker_choice_expired/);
  await assert.rejects(choose(f, 'nullspar', { expiry: Date.now() + 2 * 86400000 }), /ticker_choice_expired/);
  // A signature for one ticker does not choose another.
  const expiry = Date.now() + 60000, agentSignature = Buffer.from(ed25519.sign(Buffer.from(message(f, 'nullspar', 1, expiry)), makerSecret)).toString('hex');
  await assert.rejects(f.operator.chooseTicker(asset, { asset, ticker: 'squat', revision: 1, expiry, agentSignature }), /first_maker_signature/);
  await assert.rejects(f.operator.chooseTicker(asset, { asset, ticker: 'squat', revision: 1, expiry }), /ticker_choice_request/);
  assert.equal(f.store.get('officialCatalogNames', 'nullspar'), null);
  // The replayed first choice cannot undo a later one.
  const first = { asset, ticker: 'nullspar', revision: 1, expiry, agentSignature };
  await f.operator.chooseTicker(asset, first);
  await choose(f, 'second', { revision: 2 });
  await assert.rejects(f.operator.chooseTicker(asset, first), /ticker_choice_stale/);
  assert.equal(f.store.get('provisioning', asset).chosenTicker.tick, 'second');
});

test('the TAP Wallet bound to the first maker can sign the choice; any other wallet cannot', async t => {
  const f = await setup(t), key = Buffer.alloc(32, 9), other = Buffer.alloc(32, 10);
  const address = btc.p2tr(secp256k1.getPublicKey(key, true).subarray(1)).address;
  f.reads.bindings = { resolve: (agent, rail, snapshot, role) => {
    assert.equal(agent, maker); assert.equal(rail, 'tap'); assert.equal(role, 'firstMaker'); return { request: { address } };
  } };
  const expiry = Date.now() + 60000, text = message(f, 'walletpick', 1, expiry);
  await assert.rejects(f.operator.chooseTicker(asset, { asset, ticker: 'walletpick', revision: 1, expiry, walletSignature: signTapWalletMessage(text, other) }), /first_maker_signature/);
  const job = await f.operator.chooseTicker(asset, { asset, ticker: 'walletpick', revision: 1, expiry, walletSignature: signTapWalletMessage(text, key) });
  assert.equal(job.chosenTicker.by, 'wallet'); assert.equal(job.content.tick, 'walletpick');
  // Without a bound wallet the site cannot prove the first maker.
  f.reads.bindings = { resolve: () => { throw Error('first_maker_address_missing'); } };
  await assert.rejects(f.operator.chooseTicker(asset, { asset, ticker: 'later', revision: 2, expiry, walletSignature: signTapWalletMessage(message(f, 'later', 2, expiry), key) }), /first_maker_wallet_required/);
});

test('grammar and availability refusals are the ones deploying your own ticker uses', async t => {
  const f = await setup(t);
  for (const bad of ['', 'dmt-moon', '-moon', 'x'.repeat(33)]) await assert.rejects(choose(f, bad), /ticker_invalid/);
  // Valid TAP tickers that signers cannot rebuild official mint permits for.
  for (const bad of ['ab', 'ñandu', 'my-token', 'two words']) await assert.rejects(choose(f, bad), /ticker_official_grammar/);
  f.index({ p: 'tap', op: 'token-deploy', tick: 'taken', prv: 'outsider' });
  await assert.rejects(choose(f, 'taken'), /ticker_occupied/);
  await f.store.put('officialCatalogNames', 'dmwexample', { asset: 'p2:2', name: 'dmwexample' });
  await assert.rejects(choose(f, 'dmwexample'), /ticker_conflict/);
  await reserveTicker(f.store, 'pending', 'someone-else');
  await assert.rejects(choose(f, 'pending'), /ticker_reserved/);
  assert.equal(f.store.get('provisioning', asset).chosenTicker, undefined);
  // The compound's own official names are its own to use.
  await f.store.put('officialCatalogNames', 'nullspar', { asset, name: 'nullspar' });
  assert.equal((await choose(f, 'nullspar')).chosenTicker.tick, 'nullspar');
});

test('a changed choice supersedes the uninscribed attempt and frees the earlier name', async t => {
  const f = await setup(t);
  let job = await choose(f, 'alpha');
  const alpha = job.attempts.at(-1);
  job = await choose(f, 'beta', { revision: 2 });
  assert.equal(job.tickerAttempt, 1); assert.equal(job.attempts.length, 2); assert.equal(job.content.tick, 'beta');
  assert.equal(job.chosenTicker.attempt, 1); assert.equal(job.chosenTicker.revision, 2);
  assert.equal(f.store.get('officialCatalogNames', 'alpha'), null); assert.equal(f.store.get('tickerReservations', 'alpha'), null);
  assert.deepEqual(f.store.get('officialCatalogNames', 'beta'), { asset, name: 'beta' });
  // The superseded deploy text is no longer accepted.
  const old = f.index(alpha.text); f.mine();
  await assert.rejects(f.operator.submit(asset, { phase: 'deployment', inscription: old }), /deployment_content/);
  // The same choice again is a no-op.
  assert.equal((await choose(f, 'beta', { revision: 3 })).tickerAttempt, 1);
  job = await deploy(f, f.store.get('provisioning', asset));
  assert.equal(job.state, 'registered'); assert.equal(job.entry.tick, 'beta');
});

test('a chosen ticker taken on TAP before the deploy asks the first maker for another one', async t => {
  const f = await setup(t);
  await choose(f, 'raced');
  f.index({ p: 'tap', op: 'token-deploy', tick: 'raced', prv: 'outsider' });
  let job = await f.operator.advanceAsset(asset, record);
  job = await f.operator.advanceAsset(asset, record);
  assert.equal(job.state, 'awaiting_ticker'); assert.equal(job.reason, 'ticker_occupied'); assert.equal(job.tickerAttempt, 1);
  assert.equal(job.attempts.some(a => a.attempt === 1), false);
  job = await choose(f, 'second', { revision: 2 });
  assert.equal(job.state, 'awaiting_player_deploy'); assert.equal(job.tickerAttempt, 1); assert.equal(job.content.tick, 'second');
});

test('an automatic dmwc deploy is replaced by its first maker\'s choice until it is submitted for registration', async t => {
  const f = await setup(t), dmwc = 'dmwc' + commitment.slice(0, 8);
  const legacy = { p: 'tap', op: 'token-deploy', tick: dmwc, prv: f.privilege, prov: rules.encodeTracAddress(maker), max: '18446744073709551615', dec: '0' };
  const packaged = async () => {
    await f.store.put('officialCatalogNames', dmwc, { asset, name: dmwc });
    const job = await f.operator.enqueue(asset, record);
    return f.operator.save(job, { attempts: [{ phase: 'deployment', attempt: 0, id: 'ab'.repeat(32), text: legacy }], state: 'awaiting_player_deploy',
      phase: 'deployment', content: legacy, inscriptionText: rules.stableJSON(legacy) });
  };
  // Packaged and only sent (not in a block): the next pass asks for a ticker, and the choice replaces it.
  await packaged();
  await f.store.put('inflight', `deployment/${asset}/deployment`, { kind: 'deployment', ref: asset, phase: 'deployment', attempt: 0, confirmations: null });
  let job = await f.operator.advanceAsset(asset, record);
  assert.equal(job.state, 'awaiting_ticker');
  job = await choose(f, 'nullspar');
  assert.equal(job.tickerAttempt, 1); assert.equal(job.content.tick, 'nullspar');
  assert.equal(f.store.get('officialCatalogNames', dmwc), null);
  // In a block but never submitted for registration: still replaced; the automatic token stays unregistered.
  const g = await setup(t);
  Object.assign(f, g);
  await packaged();
  f.index(legacy); f.mine();
  job = await f.operator.advanceAsset(asset, record);
  assert.equal(job.state, 'awaiting_ticker');
  job = await choose(f, 'nullspar');
  assert.equal(job.content.tick, 'nullspar'); assert.equal(job.entry ?? null, null);
});

test('an in-flight reveal of the chosen deploy that is already confirmed fixes the ticker', async t => {
  const f = await setup(t);
  await choose(f, 'nullspar');
  await f.store.put('inflight', `deployment/${asset}/deployment`, { kind: 'deployment', ref: asset, phase: 'deployment', attempt: 0, confirmations: null });
  assert.equal((await choose(f, 'second', { revision: 2 })).content.tick, 'second');
  await f.store.put('inflight', `deployment/${asset}/deployment`, { kind: 'deployment', ref: asset, phase: 'deployment', attempt: 1, confirmations: 1 });
  await assert.rejects(choose(f, 'third', { revision: 3 }), /ticker_fixed/);
  // Mined but not yet indexed by TAP, and the record not rechecked: ord's inclusion of that reveal fixes it too.
  const mined = f.index({ p: 'tap', op: 'token-deploy', tick: 'unindexed', prv: 'outsider' });
  f.deployments.delete('unindexed');
  await f.store.put('inflight', `deployment/${asset}/deployment`, { kind: 'deployment', ref: asset, phase: 'deployment', attempt: 1, inscriptionId: 'ff'.repeat(32) + 'i0', confirmations: null });
  assert.equal((await choose(f, 'fourth', { revision: 3 })).content.tick, 'fourth');
  await f.store.put('inflight', `deployment/${asset}/deployment`, { kind: 'deployment', ref: asset, phase: 'deployment', attempt: 2, inscriptionId: mined, confirmations: null });
  await assert.rejects(choose(f, 'fifth', { revision: 4 }), /ticker_fixed/);
});
