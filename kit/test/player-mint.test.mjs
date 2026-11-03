import test from 'node:test';
import { tapBurnAddress } from '../../rules/src/tap-burn.js';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { buildInscription, signCommit, acceptSignedCommit, hex, unhex, fundingAddress, digest as digestForTest, missingItems, transferItems, mintContent, deploymentContent, checkDeployer } from '../lib/inscription-core.mjs';
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
    // The fixture wallet also holds a second coin: a saved transaction keeps the coin it spends.
    source: { utxos: async () => [...utxos, { ...utxos[0], vout: 1 }], feeRate: async () => 2, broadcast: async (raw, expected) => { assert.equal(btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true }).id, expected); return expected; } } };
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


test('a compound waiting for its first maker\'s ticker is not deployed and says how to choose it', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'deploy'); cleanup(t, () => journal.close());
  let reads = 0;
  const job = { asset: 'c2:' + 'ab'.repeat(32), kind: 'compound', state: 'awaiting_ticker', reason: 'ticker_choice_required', phase: 'deployment', tickerAttempt: 0, attempts: [], content: null };
  const player = new PlayerMint({ service: { deployment: async () => { reads++; return job; } }, journal, wallet: f.wallet, owner: 'fixture-first-maker' });
  const result = await player.deploy({ asset: job.asset, maxFeeSats: '10000' });
  assert.equal(result.state, 'awaiting_ticker'); assert.equal(result.sent, false); assert.match(result.notice, /chooses the ticker first/);
  assert.equal(reads, 1); assert.equal(journal.recent().length, 0);
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

test('a c2 compound deployment job yields its dmwc token-deploy content; malformed ids are refused', async () => {
  const { ServiceClient } = await import('../lib/service-client.mjs');
  const asset = 'c2:' + 'ab'.repeat(32), payload = { p: 'tap', op: 'token-deploy', tick: 'dmwcabababab', prv: payee + 'i0', max: '18446744073709551615', dec: '0' };
  const job = { asset, kind: 'compound', state: 'awaiting_player_deploy', phase: 'deployment', tickerAttempt: 0,
    definition: { firstMaker: 'fixture-first-maker' }, content: payload, inscriptionText: JSON.stringify(payload), attempts: [{ id, phase: 'deployment', attempt: 0, text: payload }] };
  assert.deepEqual(deploymentContent(job), { text: JSON.stringify(payload), attemptId: id, phase: 'deployment' });
  for (const bad of ['c2:' + 'ab'.repeat(31), 'c2:' + 'AB'.repeat(32)]) assert.throws(() => deploymentContent({ ...job, asset: bad }), /not ready/);
  assert.throws(() => deploymentContent({ ...job, kind: 'dmt' }), /not ready/);
  const service = new ServiceClient({ origin: 'http://127.0.0.1:5570', mode: 'regtest' });
  assert.equal(service.deploymentLink(asset), 'http://127.0.0.1:5570/mint/' + asset);
  assert.throws(() => service.deploymentLink('c2:xyz'), /Invalid deployment asset/);
});

test('a compound deploys its first maker\'s chosen ticker; another ticker or one signers cannot use is refused', () => {
  const asset = 'c2:' + 'ab'.repeat(32), payload = { p: 'tap', op: 'token-deploy', tick: 'nullspar', prv: payee + 'i0', max: '18446744073709551615', dec: '0' };
  const job = { asset, kind: 'compound', state: 'awaiting_player_deploy', phase: 'deployment', tickerAttempt: 1, chosenTicker: { tick: 'nullspar', revision: 1, attempt: 1 },
    definition: { firstMaker: 'fixture-first-maker' }, content: payload, inscriptionText: JSON.stringify(payload), attempts: [{ id, phase: 'deployment', attempt: 1, text: payload }] };
  assert.deepEqual(deploymentContent(job), { text: JSON.stringify(payload), attemptId: id, phase: 'deployment' });
  for (const tick of ['dmwcabababab', 'other', 'NULLSPAR']) {
    const text = { ...payload, tick };
    assert.throws(() => deploymentContent({ ...job, content: text, inscriptionText: JSON.stringify(text), attempts: [{ id, phase: 'deployment', attempt: 1, text }] }), /Invalid mint authority or ticker/);
  }
  // Without a choice only an automatic dmw ticker packaged earlier is accepted.
  assert.throws(() => deploymentContent({ ...job, chosenTicker: null }), /Invalid mint authority or ticker/);
});

test('deploy content may name its discoverer or first maker in prov, never anyone else', () => {
  const discoverer = 'trac1-discoverer', elem = 'ee'.repeat(32) + 'i0';
  const payload = { p: 'tap', op: 'dmt-deploy', tick: 'dmwflorite', elem, dt: 'n', prv: payee + 'i0', prov: discoverer };
  const job = { asset: 'p2:0', kind: 'dmt', state: 'awaiting_player_deploy', phase: 'deployment', tickerAttempt: 0, elementId: elem,
    definition: { dt: 'n', discoverer }, content: payload, inscriptionText: JSON.stringify(payload), attempts: [{ id, phase: 'deployment', attempt: 0, text: payload }] };
  assert.equal(deploymentContent(job).text, JSON.stringify(payload));
  const { prov, ...older } = payload;
  assert.equal(deploymentContent({ ...job, content: older, inscriptionText: JSON.stringify(older), attempts: [{ id, phase: 'deployment', attempt: 0, text: older }] }).text, JSON.stringify(older));
  const wrong = { ...payload, prov: 'trac1-someone' };
  assert.throws(() => deploymentContent({ ...job, content: wrong, inscriptionText: JSON.stringify(wrong), attempts: [{ id, phase: 'deployment', attempt: 0, text: wrong }] }), /another discoverer/);
  const compound = { p: 'tap', op: 'token-deploy', tick: 'dmwcabababab', prv: payee + 'i0', prov: 'trac1-someone', max: '18446744073709551615', dec: '0' };
  assert.throws(() => deploymentContent({ asset: 'c2:' + 'ab'.repeat(32), kind: 'compound', state: 'awaiting_player_deploy', phase: 'deployment', tickerAttempt: 0,
    definition: { firstMaker: 'trac1-maker' }, content: compound, inscriptionText: JSON.stringify(compound), attempts: [{ id, phase: 'deployment', attempt: 0, text: compound }] }), /another discoverer or first maker/);
});

test('during the discoverer\'s week only the discoverer\'s wallet is offered the deploy', async t => {
  const deployer = { onlyDiscoverer: true, until: '974730', discoverer: 'trac1-discoverer', address: 'bc1p-discoverer' };
  const job = { kind: 'dmt', state: 'awaiting_player_deploy', deployer };
  assert.doesNotThrow(() => checkDeployer(job, { owner: 'trac1-discoverer', address: 'bc1p-discoverer' }));
  assert.doesNotThrow(() => checkDeployer(job, { address: 'bc1p-discoverer' }), 'a public mint wallet that is the discoverer\'s');
  const refusal = 'Only the discoverer can deploy this token until block 974730. After that anyone can, and the deployer keeps its art rights.';
  assert.throws(() => checkDeployer(job, { owner: 'trac1-other', address: 'bc1p-other' }), { message: refusal, code: 'discoverer_receiver' });
  assert.throws(() => checkDeployer(job, { owner: 'trac1-other', address: 'bc1p-discoverer' }), { message: refusal });
  assert.throws(() => checkDeployer({ ...job, deployer: { ...deployer, address: null } }, { owner: 'trac1-discoverer', address: 'bc1p-discoverer' }), { message: refusal });
  for (const open of [{ ...job, deployer: { ...deployer, onlyDiscoverer: false } }, { ...job, deployer: undefined }, { ...job, state: 'registered' }, { ...job, kind: 'compound' }])
    assert.doesNotThrow(() => checkDeployer(open, { owner: 'trac1-other', address: 'bc1p-other' }));
  // The local agent refuses before preparing or signing anything.
  const f = fixture(), journal = await Journal.open(await temp(t), 'week'); cleanup(t, () => journal.close());
  let bound = 0;
  const player = new PlayerMint({ wallet: f.wallet, journal, owner: 'trac1-other', dryRun: false, service: {
    deployment: async () => ({ asset: 'p2', kind: 'dmt', state: 'awaiting_player_deploy', content: 'x', deployer }),
    payoutBinding: async () => { bound++; return {}; } } });
  await assert.rejects(player.deploy({ asset: 'p2', maxFeeSats: '10000' }), { message: refusal });
  assert.equal(journal.recent().length, 0); assert.equal(bound, 0);
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

test('a deployment whose saved commit coin was spent by another confirmed transaction starts a fresh attempt; pending coins are never reused', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'pattern-deploy-coins'); cleanup(t, () => journal.close());
  const script = hex(btc.p2tr(schnorr.getPublicKey(f.key)).script), coin = n => ({ txid: String(n).repeat(64).slice(0, 64), vout: 1, value: '100000', script, cardinal: true, confirmed: true });
  let coins = [coin(1), coin(2)], fail = true, sent = [];
  const outspends = new Map(), known = new Set();
  Object.assign(f.wallet.source, {
    utxos: async () => coins,
    broadcast: async (raw, txid) => { if (fail) throw Error('Bitcoin API returned HTTP 400'); sent.push(txid); known.add(txid); return txid; },
    hasTransaction: async txid => known.has(txid),
    outspend: async (txid, vout) => outspends.get(`${txid}:${vout}`) ?? { spent: false } });
  const owner = 'pattern-minter', job = asset => {
    const text = `dmw${asset.slice(3)}.[12].4.element`;
    return { asset, catalogAsset: asset, kind: 'dmt', state: 'awaiting_player_deploy', phase: 'element', definition: { number: Number(asset.slice(3)), name: `dmw${asset.slice(3)}`, pat: '[12]', fld: 4, dt: 'n' },
      elementAttempt: 0, tickerAttempt: 0, content: text, inscriptionText: text, privilege: payee + 'i0', attempts: [{ id: digestForTest(asset), phase: 'element', attempt: 0, text }] };
  };
  const service = { deployment: async asset => job(asset), payoutBinding: async () => ({ binding: { request: { agent: owner, address: f.wallet.address } } }),
    submitDeployment: async () => { throw Error('deployment_confirmations'); } };
  const player = new PlayerMint({ wallet: f.wallet, journal, service, owner, dryRun: false });
  const inputs = plan => { const tx = btc.Transaction.fromRaw(unhex(plan.commitHex), { allowUnknownOutputs: true }); return hex(tx.getInput(0).txid); };
  // The first deployment's commit never reaches Bitcoin; the second must not take its coin.
  await assert.rejects(player.deploy({ asset: 'p2:575', maxFeeSats: '10000' }), /HTTP 400/);
  const firstKey = `bitcoin-deploy/${digestForTest('p2:575')}`, first = journal.get(firstKey);
  assert.equal(inputs(first.body.plan), coin(1).txid);
  fail = false;
  const second = await player.deploy({ asset: 'p2:531', maxFeeSats: '10000' });
  assert.equal(inputs(journal.get(`bitcoin-deploy/${digestForTest('p2:531')}`).body.plan), coin(2).txid, 'a coin held by a saved transaction is never chosen again');
  assert.equal(second.deploymentState, 'awaiting_verification');
  // An unconfirmed spend elsewhere is not proof: the saved bytes are retried unchanged.
  outspends.set(`${coin(1).txid}:1`, { spent: true, txid: 'ee'.repeat(32), status: { confirmed: false } });
  fail = true; await assert.rejects(player.deploy({ asset: 'p2:575', maxFeeSats: '10000' }), /HTTP 400/);
  assert.equal(journal.get(firstKey).body.plan.commitTxid, first.body.plan.commitTxid);
  // Bitcoin confirmed a different spend of that coin: the saved commit can never confirm.
  outspends.set(`${coin(1).txid}:1`, { spent: true, txid: 'ee'.repeat(32), status: { confirmed: true, block_height: 974246 } });
  coins = [coin(2), coin(3)]; fail = false;
  player.dryRun = true;
  const preview = await player.deploy({ asset: 'p2:575', maxFeeSats: '10000' });
  assert.equal(preview.state, 'dry-run'); assert.equal(preview.replaces.spentBy, 'ee'.repeat(32)); assert.equal(journal.get(firstKey).body.plan.commitTxid, first.body.plan.commitTxid);
  player.dryRun = false;
  const fresh = await player.deploy({ asset: 'p2:575', maxFeeSats: '10000' });
  const replacement = journal.get(firstKey);
  assert.notEqual(replacement.body.plan.commitTxid, first.body.plan.commitTxid);
  assert.equal(inputs(replacement.body.plan), coin(3).txid, 'the fresh attempt skips the coin the other deployment still holds');
  assert.equal(fresh.commitTxid, replacement.body.plan.commitTxid); assert.ok(sent.includes(fresh.commitTxid));
  const archived = journal.recent(10).find(r => r.id.startsWith(firstKey + '#abandoned-'));
  assert.equal(archived?.state, 'rejected');
  assert.ok(!journal.bitcoinPlans().some(p => p.commitTxid === first.body.plan.commitTxid), 'an abandoned plan no longer holds coins');
});
