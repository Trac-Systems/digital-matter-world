import test from 'node:test';
import { tapBurnAddress } from '../../rules/src/tap-burn.js';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { buildInscription, signCommit, acceptSignedCommit, hex, unhex, fundingAddress, digest as digestForTest, missingItems, transferItems, mintContent } from '../lib/inscription-core.mjs';
import { mempoolBitcoinSource } from '../lib/bitcoin-wallet.mjs';
import { PlayerMint } from '../lib/player-mint.mjs';
import { Journal } from '../lib/journal.mjs';
import { temp, cleanup } from './helpers.mjs';
import { errorMeanings } from '../lib/errors.mjs';

const id = '12'.repeat(32), payee = '34'.repeat(32);
function fixture() {
  const key = schnorr.utils.randomPrivateKey(), publicKey = hex(schnorr.getPublicKey(key)), address = fundingAddress(publicKey, 'regtest');
  const fees = [{ role: 'treasury', to: address, ticker: 'tap', amount: '1230000000000000001', tt: 'a', dta: `dmw-pay-v2|${id}|treasury` }];
  const status = { requestId: id, receiver: address, payer: address, asset: 'cfixture', amount: '2', fees, missing: fees, payBy: { rail: 'tap', untilBlock: 500 }, state: 'awaiting_payment' };
  const utxos = [{ txid: payee, vout: 0, value: '100000', script: hex(btc.p2tr(schnorr.getPublicKey(key)).script), cardinal: true, confirmed: true }];
  const wallet = { address, publicKey, network: 'regtest', signCommit: p => signCommit(p, key), redeem: () => JSON.stringify({ p: 'tap', op: 'token-auth' }),
    source: { utxos: async () => utxos, feeRate: async () => 2, broadcast: async (raw, expected) => { assert.equal(btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true }).id, expected); return expected; } } };
  const plan = text => buildInscription({ text, receiver: address, publicKey, network: 'regtest', utxos, feeRate: 2, maxFeeSats: '10000' });
  const ready = () => Object.assign(status, { state: 'permit_issued', missing: [], mintContent: { p: 'tap', op: 'token-mint', tick: 'dmwfixture', amt: '2', dta: id, prv: { address, hash: '56'.repeat(32) } } });
  return { key, wallet, status, plan, ready };
}

test('shared inscription builder signs a script-path reveal to the exact player and validates the commit', () => {
  const f = fixture(), plan = f.plan('a'.repeat(1400)), signed = f.wallet.signCommit(plan);
  const commit = btc.Transaction.fromRaw(unhex(signed.commitHex)), reveal = btc.Transaction.fromRaw(unhex(plan.revealHex), { allowUnknownInputs: true });
  assert.equal(commit.id, plan.commitTxid); assert.equal(reveal.id + 'i0', plan.inscriptionId);
  assert.equal(hex(reveal.getOutput(0).script), hex(commit.getOutput(1).script));
  assert.equal(reveal.getInput(0).finalScriptWitness.length, 3, 'the reveal spends the inscription script, not a key path');
  assert.equal(reveal.getOutput(0).amount, 546n);
  assert.equal(commit.getOutput(0).amount - 546n + btc.Transaction.fromPSBT(unhex(signed.signedCommitPsbt)).fee, BigInt(plan.feeSats));
  const changed = btc.Transaction.fromPSBT(unhex(plan.commitPsbt));
  changed.updateOutput(1, { amount: changed.getOutput(1).amount - 1n }); changed.sign(f.key); changed.finalize();
  assert.throws(() => acceptSignedCommit(plan, hex(changed.toPSBT(0))), /changed the approved/);
});

test('fee ceiling and cardinal-coin checks stop spending before a signature is requested', () => {
  const f = fixture();
  const args = { text: 'test', receiver: f.wallet.address, publicKey: f.wallet.publicKey, network: 'regtest', feeRate: 1000, maxFeeSats: '1', utxos: [] };
  assert.throws(() => buildInscription(args), /cardinal/);
  assert.throws(() => buildInscription({ ...args, utxos: [{ txid: payee, vout: 0, value: '1000000', script: hex(btc.p2tr(schnorr.getPublicKey(f.key)).script), cardinal: true, confirmed: true }] }), { code: 'bitcoin_fee_limit' });
});

test('payment uses exact missing amounts, preserves role correlation and refuses native burns', () => {
  const f = fixture();
  f.status.missing = [{ ...f.status.fees[0], amount: '100000000000000001' }];
  assert.equal(transferItems(f.status)[0].amt, '0.100000000000000001');
  assert.equal(transferItems(f.status)[0].dta, `dmw-pay-v2|${id}|treasury`);
  const burn = { role: 'burn', to: null, ticker: 'tap', amount: '1', tt: 'b' };
  f.status.fees.push(burn); f.status.missing.push(burn);
  assert.throws(() => transferItems(f.status), { code: 'tap_burn_redeem_unsupported' });
  f.status.missing = [{ ...f.status.fees[0], to: 'different' }];
  assert.throws(() => missingItems(f.status), /differs from the quote/);
  assert.ok(errorMeanings.first_maker_address_missing); assert.equal(errorMeanings.firstMaker_address_missing, undefined);
});

test('dry-run and already-paid requests never pay; unsupported burn sends nothing', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'mint'); cleanup(t, () => journal.close());
  let sends = 0, signs = 0; f.wallet.redeem = () => { signs++; throw Error('unexpected signing'); }; f.wallet.source.broadcast = () => { sends++; };
  const player = new PlayerMint({ wallet: f.wallet, journal, service: { mintStatus: async () => f.status } });
  assert.equal((await player.pay({ id, maxFeeSats: '10000' })).state, 'dry-run');
  assert.equal(journal.recent().length, 0);
  player.dryRun = false;
  const burn = { role: 'burn', to: null, ticker: 'tap', amount: '1', tt: 'b' }; f.status.fees.push(burn);
  await assert.rejects(player.pay({ id, maxFeeSats: '10000' }), { code: 'tap_burn_redeem_unsupported' });
  f.ready(); assert.equal((await player.pay({ id, maxFeeSats: '10000' })).sent, false);
  assert.equal(signs, 0); assert.equal(sends, 0);
});

test('a crash after the commit resumes the saved reveal with no new funding transaction', async t => {
  const f = fixture(); f.ready(); const directory = await temp(t);
  let journal = await Journal.open(directory, 'mint'), sends = [], fail = true;
  cleanup(t, () => journal.close());
  f.wallet.source.broadcast = async (raw, txid) => {
    assert.ok(journal.get(`bitcoin-mint/${id}`)?.body.plan.commitHex, 'signed transactions were durable before either send');
    sends.push({ raw, txid });
    if (sends.length === 2 && fail) { fail = false; throw Error('reply lost'); }
    return txid;
  };
  let player = new PlayerMint({ wallet: f.wallet, journal, service: { mintStatus: async () => structuredClone(f.status) }, dryRun: false });
  await assert.rejects(player.inscribe({ id, maxFeeSats: '10000' }), /reply lost/);
  journal.close(); journal = await Journal.open(directory, 'mint');
  f.wallet.source.utxos = () => { throw Error('must reuse the saved plan'); };
  player = new PlayerMint({ wallet: f.wallet, journal, service: { mintStatus: async () => f.status }, dryRun: false });
  const result = await player.inscribe({ id, maxFeeSats: '10000' });
  assert.equal(result.replayed, true); assert.deepEqual(sends.slice(0, 2), sends.slice(2));
  assert.equal(journal.recent().length, 1);
});

test('uncertain payment retries reuse the original redeem, even while indexer still reports missing', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'pay'); cleanup(t, () => journal.close());
  let redeems = 0, sends = [];
  f.wallet.redeem = () => { redeems++; return 'payment'; };
  f.wallet.source.broadcast = async (raw, txid) => { sends.push(txid); return txid; };
  const player = new PlayerMint({ wallet: f.wallet, journal, service: { mintStatus: async () => f.status }, dryRun: false });
  await player.pay({ id, maxFeeSats: '10000' });
  await player.pay({ id, maxFeeSats: '10000' });
  assert.equal(redeems, 1); assert.deepEqual(sends.slice(0, 2), sends.slice(2));
});

test('unpaid, expired, wrong receiver and mismatched quantity never authorize a mint', () => {
  const f = fixture();
  assert.throws(() => mintContent(f.status, f.wallet.address), { code: 'mint_permit_not_ready' });
  f.ready(); assert.throws(() => mintContent(f.status, 'another wallet'), { code: 'mint_receiver_mismatch' });
  f.status.mintContent.amt = '3'; assert.throws(() => mintContent(f.status, f.wallet.address), /quantity/);
  f.status.state = 'expired'; assert.throws(() => mintContent(f.status, f.wallet.address), { code: 'mint_permit_not_ready' });
});


test('compound first maker deploys once and retries registration after finality', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'deploy'); cleanup(t, () => journal.close());
  const owner = 'fixture-first-maker', payload = { p: 'tap', op: 'token-deploy', tick: 'dmwcfixture', max: '1000', dec: '0', prv: payee + 'i0' };
  const job = { asset: 'cfixture', kind: 'compound', state: 'awaiting_player_deploy', phase: 'deployment', tickerAttempt: 0,
    definition: { firstMaker: owner }, content: payload, inscriptionText: JSON.stringify(payload), attempts: [{ id, phase: 'deployment', attempt: 0, text: payload }] };
  let sends = [], registrations = [], confirmed = false;
  f.wallet.source.broadcast = async (raw, txid) => { sends.push(txid); return txid; };
  const service = { deployment: async () => job, payoutBinding: async () => ({ binding: { request: { agent: owner, address: f.wallet.address } } }),
    submitDeployment: async body => { registrations.push(body); if (!confirmed) throw Error('deployment_confirmations'); job.state = 'registered'; job.entry = { id: body.inscription }; return job; } };
  const player = new PlayerMint({ service, journal, wallet: f.wallet, owner });
  const args = { asset: 'cfixture', maxFeeSats: '10000' };
  assert.equal((await player.deploy(args)).state, 'dry-run'); assert.equal(sends.length, 0); assert.equal(journal.recent().length, 0);
  player.dryRun = false; player.owner = 'other'; await assert.rejects(player.deploy(args), /first maker/); player.owner = owner;
  const first = await player.deploy(args); assert.equal(first.deploymentState, 'awaiting_verification');
  await assert.rejects(player.deploy({ ...args, maxFeeSats: '1' }), { code: 'bitcoin_fee_limit' });
  confirmed = true;
  assert.equal((await player.deploy(args)).deploymentState, 'registered');
  assert.deepEqual(sends.slice(0, 2), sends.slice(2)); assert.deepEqual(registrations[0], registrations[1]);
  assert.equal((await player.deploy(args)).sent, false);
});

test('unconfirmed reservations never pay and payment hints identify the saved reveal', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'hint'); cleanup(t, () => journal.close());
  let hints = [];
  const player = new PlayerMint({ wallet: f.wallet, journal, dryRun: false, service: { mintStatus: async () => f.status, reportMintPayment: async value => hints.push(value) } });
  f.status.payable = false;
  await assert.rejects(player.pay({ id, maxFeeSats: '10000' }), /reservation/); assert.equal(journal.recent().length, 0);
  f.status.payable = true; f.status.payer = 'different-wallet';
  await assert.rejects(player.pay({ id, maxFeeSats: '10000' }), /quoted TAP payer/); assert.equal(journal.recent().length, 0);
  f.status.payer = f.wallet.address;
  const result = await player.pay({ id, maxFeeSats: '10000' });
  assert.deepEqual(hints, [{ id, paymentId: result.inscriptionId }]);
});


test('the local source recovers only signed-plan cardinal change from the durable journal', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'change'); cleanup(t, () => journal.close());
  const plan = f.wallet.signCommit(f.plan('payment'));
  journal.reserve(`bitcoin-pay/${id}`, { id }, { requestId: id, plan });
  journal.reserve('unrelated/action', {}, { plan });
  const script = hex(btc.p2tr(schnorr.getPublicKey(f.key)).script);
  const calls = [];
  const source = mempoolBitcoinSource({ network: 'regtest', origin: 'http://127.0.0.1:59739', fetchImpl: async url => {
    calls.push(new URL(url).pathname);
    return new Response(JSON.stringify(url.endsWith('/outspend/1') ? { spent: false } : { status: { confirmed: true }, vout: [{}, { scriptpubkey: script, value: 90000 }] }));
  } });
  source.addFunding(journal.bitcoinChanges());
  const coins = await source.utxos(f.wallet.address);
  assert.equal(coins.length, 1); assert.equal(coins[0].txid, plan.commitTxid); assert.equal(coins[0].vout, 1); assert.equal(coins[0].cardinal, true);
  assert.deepEqual(calls, [`/tx/${plan.commitTxid}`, `/tx/${plan.commitTxid}/outspend/1`]);
});

for (const [asset, ledger] of [['p0', 'p0'], ['p2:1', 'p2:1'], ['p2:0', 'p0']]) test(`first pattern minter preserves separate element/deploy attempts and exact indexed bindings: ${asset}`, async t => {
  const { deploymentContent } = await import('../lib/inscription-core.mjs');
  const f = fixture(), journal = await Journal.open(await temp(t), 'pattern-deploy'); cleanup(t, () => journal.close());
  const owner = 'pattern-minter', definition = { number: 0, name: 'dmwfirstlight', pat: '[12]', fld: 4, dt: 'n' };
  const elementText = 'dmwfirstlight.[12].4.element';
  const job = { asset: ledger, catalogAsset: asset, kind: 'dmt', state: 'awaiting_player_deploy', phase: 'element', definition, elementAttempt: 0, tickerAttempt: 0,
    content: elementText, inscriptionText: elementText, privilege: payee + 'i0', attempts: [{ id, phase: 'element', attempt: 0, text: elementText }] };
  let confirmed = false, sends = 0;
  f.wallet.source.broadcast = async (_raw, txid) => { sends++; return txid; };
  const service = { deployment: async () => job, payoutBinding: async () => ({ binding: { request: { agent: owner, address: f.wallet.address } } }),
    submitDeployment: async ({ asset: submittedAsset, phase, inscription }) => {
      assert.equal(submittedAsset, ledger);
      if (!confirmed) throw Error('deployment_confirmations');
      if (phase === 'element') {
        const payload = { p: 'tap', op: 'dmt-deploy', tick: definition.name, elem: inscription, dt: 'n', prv: job.privilege };
        Object.assign(job, { phase: 'deployment', elementId: inscription, receiver: f.wallet.address, content: payload, inscriptionText: JSON.stringify(payload) });
        job.attempts.push({ id: 'cd'.repeat(32), phase: 'deployment', attempt: 0, text: payload });
      } else { job.state = 'registered'; job.entry = { id: inscription }; }
      return job;
    } };
  const player = new PlayerMint({ wallet: f.wallet, journal, service, owner });
  const args = { asset, maxFeeSats: '10000' };
  assert.equal((await player.deploy(args)).state, 'dry-run'); assert.equal(sends, 0);
  assert.throws(() => deploymentContent({ ...job, inscriptionText: 'dmwfirstlight.999.4.element' }), /Element differs/);
  player.dryRun = false;
  const first = await player.deploy(args); assert.equal(first.phase, 'element'); assert.equal(first.deploymentState, 'awaiting_verification');
  confirmed = true; await player.deploy(args);
  assert.equal(job.elementId, first.inscriptionId);
  assert.throws(() => deploymentContent({ ...job, elementId: '00'.repeat(32) + 'i0' }), /indexed element/);
  const deployed = await player.deploy(args); assert.equal(deployed.phase, 'deployment'); assert.equal(deployed.deploymentState, 'registered');
  assert.equal(journal.recent().length, 2); assert.equal(sends, 6);
});

test('production mint commitment binds request and deployment in the wallet', () => {
  const { status, ready, wallet } = fixture(); ready();
  status.deploymentId = payee + 'i0';
  status.mintContent.dta = `dmw-mint-v1|fixture-network|${id}|${digestForTest(status.deploymentId)}|${'ab'.repeat(32)}`;
  assert.doesNotThrow(() => mintContent(status, wallet.address));
  status.deploymentId = '00'.repeat(32) + 'i0';
  assert.throws(() => mintContent(status, wallet.address), /not bound/);
});

test('player payments use the configured network burn and refuse a wrong encoding before signing', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'network-burn'); cleanup(t, () => journal.close());
  const burn = { role: 'burn', to: tapBurnAddress('regtest'), ticker: 'tap', amount: '1000000000000000000', tt: 'a' };
  f.status.fees.push(burn);
  const player = new PlayerMint({ wallet: f.wallet, journal, service: { mintStatus: async () => f.status } });
  assert.equal((await player.pay({ id, maxFeeSats: '10000' })).items.at(-1).address, burn.to);
  assert.throws(() => transferItems(f.status, 'mainnet'), { code: 'tap_burn_address' });
  burn.to = tapBurnAddress('mainnet');
  assert.equal(transferItems(f.status, 'mainnet').at(-1).address, burn.to);
  let signs = 0; f.wallet.redeem = () => { signs++; };
  player.dryRun = false;
  await assert.rejects(player.pay({ id, maxFeeSats: '10000' }), { code: 'tap_burn_address' });
  assert.equal(signs, 0); assert.equal(journal.recent().length, 0);
});
