import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { TapWalletMint } from '../lib/tap-wallet-mint.mjs';
import { fundingAddress, hex } from '../lib/inscription-core.mjs';
import { tapBurnAddress } from '../../rules/src/tap-burn.js';

import { tapWallet1048 } from './tap-wallet-1048-fixture.mjs';
import { ensureTapAuthority } from '../lib/tap-wallet-actions.mjs';
// TAP Wallet 1.0.48 transfer result is funding, not a redeem inscription.
test('Mint uses the public provider transfer API and preserves its funding receipt', async () => {
  const publicKey = hex(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true)), address = fundingAddress(publicKey, 'mainnet');
  const id = '12'.repeat(32), fundingTxid = '34'.repeat(32), records = new Map(), received = [];
  const fees = [
    { role: 'treasury', to: address, ticker: 'tap', amount: '33900000000000000000', tt: 'a' },
    { role: 'burn', to: tapBurnAddress('mainnet'), ticker: 'tap', amount: '33900000000000000000', tt: 'a' },
  ];
  const status = { requestId: id, receiver: address, payer: address, fees, missing: fees, state: 'awaiting_payment', payable: true, payBy: { rail: 'tap' } };
  const provider = { ...tapWallet1048({ address, publicKey }).provider, requestAccounts: async () => [address], getAccounts: async () => [address], getNetwork: async () => 'mainnet',
    getPublicKey: async () => publicKey, getBitcoinUtxos: async () => [],
    signPsbt: async () => assert.fail('no inscription signing for a transfer'), pushPsbt: async () => assert.fail('no pushPsbt'), pushTx: async () => assert.fail('no pushTx'),
    singleTxTransfer: async items => {
      for (const item of items) {
        assert.equal(typeof item.address, 'string'); assert.equal(item.tick, 'tap');
        assert.equal(item.amt, '33.9'); assert.match(item.dta, /^dmw-pay-v2\|[0-9a-f]{64}\|(treasury|burn)$/);
        assert.deepEqual(Object.keys(item).sort(), ['address', 'amt', 'dta', 'tick']);
      }
      received.push(items); return { txid: fundingTxid };
    } };
  const journal = { get: async k => records.get(k), put: async (k, v) => records.set(k, v), lock: async (_, fn) => fn() };
  const wallet = new TapWalletMint({ provider, readStatus: async () => status, network: 'mainnet', journal });
  await wallet.connect(); assert.equal((await wallet.pay(id)).localState, 'payment_submitted');
  assert.equal((await wallet.pay(id)).localState, 'payment_pending'); assert.equal(received.length, 1);
  assert.deepEqual(records.get(wallet.key(id)).payment.result, { txid: fundingTxid });
  delete provider.singleTxTransfer;
  await assert.rejects(wallet.connect(), /does not provide singleTxTransfer/, 'an incompatible provider lacks this method');
});

function fixture(active = false) {
  const publicKey = hex(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true)), address = fundingAddress(publicKey, 'mainnet');
  const f = tapWallet1048({ address, publicKey, active }), records = new Map(), id = '12'.repeat(32);
  const fees = [{ role: 'treasury', to: address, ticker: 'tap', amount: '1000000000000000000', tt: 'a' }];
  const status = { requestId: id, receiver: address, payer: address, fees, missing: fees, state: 'awaiting_payment', payable: true, payBy: { rail: 'tap' } };
  const journal = { get: async k => structuredClone(records.get(k)), put: async (k, v) => records.set(k, structuredClone(v)), lock: async (_, fn) => fn() };
  const notices = [], options = { provider: f.provider, readStatus: async () => status, network: 'mainnet', journal, notify: text => notices.push(text) };
  return { ...f, records, id, status, journal, notices, options, wallet: new TapWalletMint(options) };
}
test('fresh 1.0.48 Mint creates and activates a global authority before recording payment; reload never sends twice', async () => {
  const f = fixture(); await f.wallet.connect();
  const transfer = f.provider.singleTxTransfer;
  f.provider.singleTxTransfer = items => {
    assert.equal(f.records.get(f.wallet.key(f.id)).payment.state, 'sending');
    assert.ok(f.state.active); return transfer(items);
  };
  const create = f.provider.createGlobalTapAuthority;
  f.provider.createGlobalTapAuthority = () => { assert.equal(f.records.get(f.wallet.key(f.id))?.payment, undefined); return create(); };
  await f.wallet.pay(f.id);
  assert.match(f.notices[0], /all TAP tokens/);
  assert.deepEqual(f.state.calls.map(c => c[0]), ['createGlobalTapAuthority', 'getInscriptions', 'sendInscription', 'singleTxTransfer']);
  assert.deepEqual(f.records.get(f.wallet.key(f.id)).payment.result, { txid: f.funding });
  const resumed = new TapWalletMint(f.options); await resumed.connect();
  assert.equal((await resumed.pay(f.id)).localState, 'payment_pending');
  f.status.missing = []; f.status.state = 'permit_issued';
  assert.equal((await resumed.pay(f.id)).state, 'permit_issued');
  assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 1);
});
test('1.0.48 hides scoped authorities and setup already in progress must not create another order', async () => {
  const f = fixture(true); f.state.scope = ['tap']; await f.wallet.connect();
  f.state.existingSetup = { state: 'ready-to-tap', tappingStatus: 2 };
  await assert.rejects(f.wallet.pay(f.id), /already exists/);
  assert.equal(f.records.get(f.wallet.key(f.id))?.payment, undefined);
  assert.deepEqual(f.state.calls, []);
  f.state.existingSetup = null; await f.wallet.pay(f.id);
  assert.equal(f.state.calls[0][0], 'createGlobalTapAuthority');
});
test('No authority found clears only the definite preflight failure; generic 4001 preserves payment after reload', async () => {
  const f = fixture(true); await f.wallet.connect();
  f.state.transferError = { code: 4001, message: 'No authority found' };
  await assert.rejects(f.wallet.pay(f.id), /No payment was sent/);
  assert.equal(f.records.get(f.wallet.key(f.id))?.payment, undefined);
  f.state.transferError = { code: 4001, message: 'User rejected the request.' };
  await assert.rejects(f.wallet.pay(f.id), /may have been sent/);
  const resumed = new TapWalletMint(f.options); await resumed.connect();
  assert.equal((await resumed.pay(f.id)).localState, 'payment_pending');
  assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 2);
});
test('pending authority lookup failure and popup closure preserve authority recovery without marking Mint sending', async () => {
  const f = fixture(); await f.wallet.connect(); f.state.pendingOrder = true; f.state.orderError = true;
  await assert.rejects(f.wallet.pay(f.id), /could not read the saved inscription order/);
  assert.equal(f.records.get(f.wallet.key(f.id))?.payment, undefined);
  const resumed = new TapWalletMint(f.options); await resumed.connect();
  await assert.rejects(resumed.pay(f.id), /could not read/);
  assert.equal(f.state.calls.filter(c => c[0] === 'createGlobalTapAuthority').length, 1);
  const closed = fixture(); await closed.wallet.connect(); closed.state.actionError = { code: 4001, message: 'User rejected the request.' };
  await assert.rejects(closed.wallet.pay(closed.id), error => error.code === 4001);
  await assert.rejects(closed.wallet.pay(closed.id), /interrupted/);
  assert.equal(closed.records.get(closed.wallet.key(closed.id))?.payment, undefined);
});
test('authority waits for inscription ownership, retries only definite missing UTXO, and resumes activation after confirmation', async () => {
  const f = fixture(), data = {};
  const steps = { getStep: name => data[name], step: async (name, action, { definitelyNotSent = () => false } = {}) => {
    if (data[name]?.state === 'done') return data[name].result;
    assert.equal(data[name], undefined); data[name] = { state: 'sending' };
    try { const result = await action(); data[name] = { state: 'done', result }; return result; }
    catch (error) { if (definitelyNotSent(error)) delete data[name]; throw error; }
  } };
  const options = { attempts: 1, wait: async () => {} };
  f.state.available = false;
  await assert.rejects(ensureTapAuthority(f.provider, f.state.address, steps, options), /not available/);
  assert.equal(data['authority-activation'], undefined);
  f.state.available = true; f.state.activationError = { message: 'UTXO not found.' };
  await assert.rejects(ensureTapAuthority(f.provider, f.state.address, steps, options), { message: 'UTXO not found.' });
  assert.equal(data['authority-activation'], undefined);
  f.state.activationError = null;
  const send = f.provider.sendInscription;
  f.provider.sendInscription = async (...args) => { const tx = await send(...args); f.state.active = false; return tx; };
  await assert.rejects(ensureTapAuthority(f.provider, f.state.address, steps, options), /activation is pending/);
  f.state.active = true;
  assert.equal(await ensureTapAuthority(f.provider, f.state.address, steps, options), f.authId);
  assert.equal(f.state.calls.filter(c => c[0] === 'sendInscription').length, 2, 'one definite UTXO failure plus one broadcast');
  assert.equal(f.state.calls.filter(c => c[0] === 'createGlobalTapAuthority').length, 1);
});
test('locked or changed 1.0.48 account fails before a durable payment attempt', async () => {
  const f = fixture(true); await f.wallet.connect();
  for (const state of [{ locked: true }, { locked: false, network: 'regtest' }, { network: 'mainnet', address: 'bc1pwrong' }]) {
    Object.assign(f.state, state); await assert.rejects(f.wallet.pay(f.id), /changed/);
    assert.equal(f.records.size, 0);
  }
});

test('1.0.48 signing uses inputForSigns and refuses the unsigned Ledger controller result before any broadcast', async () => {
  const { p2tr, Transaction } = await import('@scure/btc-signer');
  const { unhex } = await import('../lib/inscription-core.mjs');
  const key = new Uint8Array(32).fill(4);
  for (const hardwareControllerBug of [false, true]) {
    const f = fixture(true); await f.wallet.connect(); let broadcasts = 0;
    f.provider.getBitcoinUtxos = async () => [{ txid: '45'.repeat(32), vout: 0, satoshi: 100000, scriptPk: hex(p2tr(unhex(await f.provider.getPublicKey()).slice(1)).script), height: 1, inscriptions: [], isSpent: false }];
    f.provider.signPsbt = async (psbt, options) => {
      const replacement = Transaction.fromPSBT(unhex(psbt));
      assert.deepEqual(options, { autoFinalized: true, inputForSigns: Array.from({ length: replacement.inputsLength }, (_, index) => ({ index, address: f.state.address })) });
      replacement.sign(key); replacement.finalize();
      return hardwareControllerBug ? psbt : hex(replacement.toPSBT(0));
    };
    f.provider.pushPsbt = async psbt => { broadcasts++; return Transaction.fromPSBT(unhex(psbt)).id; };
    f.provider.pushTx = async raw => { broadcasts++; return Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true }).id; };
    const run = () => f.wallet.inscribeContent(f.id, 'fixture inscription', 'mint', { feeRate: 2, maxFeeSats: '10000', confirm: async () => true });
    if (hardwareControllerBug) { await assert.rejects(run(), /did not finalize/); assert.equal(broadcasts, 0); }
    else { assert.equal((await run()).state, 'broadcast'); assert.equal(broadcasts, 2); }
  }
});

test('account changes while refreshing after setup fail before the payment record is written', async () => {
  const f = fixture(true); await f.wallet.connect(); let reads = 0;
  f.wallet.readStatus = async () => { if (++reads === 2) f.state.locked = true; return f.status; };
  await assert.rejects(f.wallet.pay(f.id), /changed/);
  assert.equal(f.records.get(f.wallet.key(f.id))?.payment, undefined);
  assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 0);
});

test('an older saved scoped authority is never activated as global or replaced by another paid order', async () => {
  const f = fixture(); let actions = 0;
  const old = { orderId: 'old-scoped-order', inscriptionId: f.authId, txid: f.authId.slice(0, 64), paymentTxid: f.funding, pending: false };
  const journal = { getStep: () => ({ state: 'done', result: old }), step: async () => { actions++; return old; } };
  await assert.rejects(ensureTapAuthority(f.provider, f.state.address, journal), /older payment flow/);
  assert.equal(actions, 1); assert.deepEqual(f.state.calls, []);
});


test('public deployment uses only its receiving TAP wallet while agent and compound deployments retain bindings', async () => {
  const f = fixture(true); await f.wallet.connect();
  const text = 'dmwpublic.123.4.element', attemptId = 'ab'.repeat(32);
  const job = { asset: 'p2:1', kind: 'dmt', state: 'awaiting_player_deploy', phase: 'element', elementAttempt: 0,
    definition: { pat: '123', fld: 4, dt: 'n' }, elementName: 'dmwpublic', content: text, inscriptionText: text,
    attempts: [{ phase: 'element', attempt: 0, id: attemptId, text }] };
  const request = { publicMint: true, asset: job.asset, receiver: f.wallet.address, kind: 'tap' };
  const sent = [];
  f.wallet.inscribeContent = async (...args) => { sent.push(args); return { state: 'broadcast' }; };
  await assert.rejects(f.wallet.inscribeDeployment(job), /bound TAP Wallet/);
  await assert.rejects(f.wallet.inscribeDeployment(job, { publicRequest: { ...request, publicMint: false } }), /receiving this public mint/);
  await assert.rejects(f.wallet.inscribeDeployment(job, { publicRequest: { ...request, asset: 'p2:2' } }), /receiving this public mint/);
  await assert.rejects(f.wallet.inscribeDeployment(job, { publicRequest: { ...request, receiver: 'different' } }), /receiving this public mint/);
  await assert.rejects(f.wallet.inscribeDeployment({ ...job, receiver: 'different' }, { publicRequest: request }), /receiving this public mint/);
  await assert.rejects(f.wallet.inscribeDeployment({ ...job, kind: 'compound' }, { publicRequest: request }), /receiving this public mint/);
  assert.equal(sent.length, 0);
  assert.equal((await f.wallet.inscribeDeployment(job, { publicRequest: request })).phase, 'element');
  assert.deepEqual(sent[0].slice(0, 3), [attemptId, text, 'deploy']);
  const owner = 'agent';
  await assert.rejects(f.wallet.inscribeDeployment(job, { owner, binding: { request: { agent: 'other', address: f.wallet.address } } }), /bound TAP Wallet/);
  assert.equal((await f.wallet.inscribeDeployment(job, { owner, binding: { request: { agent: owner, address: f.wallet.address } } })).state, 'broadcast');
});
