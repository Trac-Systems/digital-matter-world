import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { TapWalletMint } from '../lib/tap-wallet-mint.mjs';
import { fundingAddress, hex } from '../lib/inscription-core.mjs';
import { tapBurnAddress } from '../../rules/src/tap-burn.js';

import { tapWallet1048 } from './tap-wallet-1048-fixture.mjs';
import { tapWallet1049 } from './tap-wallet-1049-fixture.mjs';
import { cardinalFixture, walletFundsFetch, walletFundsReply } from './wallet-funds-fixture.mjs';
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
  const provider = { ...tapWallet1049({ address, publicKey }).provider, requestAccounts: async () => [address], getAccounts: async () => [address], getNetwork: async () => 'mainnet',
    getPublicKey: async () => publicKey, getBitcoinUtxos: async () => [cardinalFixture()],
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
  const wallet = new TapWalletMint({ provider, readStatus: async () => status, network: 'mainnet', journal, fetchImpl: walletFundsFetch });
  await wallet.connect(); assert.equal((await wallet.pay(id)).localState, 'payment_submitted');
  assert.equal((await wallet.pay(id)).localState, 'payment_pending'); assert.equal(received.length, 1);
  assert.deepEqual(records.get(wallet.key(id)).payment.result, { txid: fundingTxid });
  delete provider.singleTxTransfer;
  await assert.rejects(wallet.connect(), /does not provide singleTxTransfer/, 'an incompatible provider lacks this method');
});

function fixture(active = false) {
  const publicKey = hex(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true)), address = fundingAddress(publicKey, 'mainnet');
  const f = tapWallet1049({ address, publicKey, active }), records = new Map(), id = '12'.repeat(32);
  const fees = [{ role: 'treasury', to: address, ticker: 'tap', amount: '1000000000000000000', tt: 'a' }];
  const status = { requestId: id, receiver: address, payer: address, fees, missing: fees, state: 'awaiting_payment', payable: true, payBy: { rail: 'tap' } };
  const journal = { get: async k => structuredClone(records.get(k)), put: async (k, v) => records.set(k, structuredClone(v)), lock: async (_, fn) => fn() };
  const notices = [], options = { provider: f.provider, readStatus: async () => status, network: 'mainnet', journal, fetchImpl: walletFundsFetch, notify: text => notices.push(text) };
  return { ...f, records, id, status, journal, notices, options, wallet: new TapWalletMint(options) };
}
test('Mint without 1-TX Transfers explains how to turn them on and sends nothing; with them on it pays once', async () => {
  const f = fixture(); await f.wallet.connect();
  await assert.rejects(f.wallet.pay(f.id), /Turn on 1-TX Transfers in TAP Wallet first/);
  assert.equal(f.records.get(f.wallet.key(f.id))?.payment, undefined);
  assert.deepEqual(f.state.calls, []);
  f.state.active = true;
  await f.wallet.pay(f.id);
  assert.deepEqual(f.state.calls.map(c => c[0]), ['singleTxTransfer']);
  assert.deepEqual(f.records.get(f.wallet.key(f.id)).payment.result, { txid: f.funding });
  const resumed = new TapWalletMint(f.options); await resumed.connect();
  assert.equal((await resumed.pay(f.id)).localState, 'payment_pending');
  f.status.missing = []; f.status.state = 'permit_issued';
  assert.equal((await resumed.pay(f.id)).state, 'permit_issued');
  assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 1);
});
test('a scoped authority or a setup still in progress is explained, never created or activated by DMW', async () => {
  const f = fixture(true); f.state.scope = ['tap']; await f.wallet.connect();
  await assert.rejects(f.wallet.pay(f.id), /Turn on 1-TX Transfers/);
  f.state.existingSetup = { state: 'ready-to-tap', tappingStatus: 2 };
  await assert.rejects(f.wallet.pay(f.id), /still setting up 1-TX Transfers/);
  assert.equal(f.records.get(f.wallet.key(f.id))?.payment, undefined);
  assert.deepEqual(f.state.calls, []);
  await assert.rejects(ensureTapAuthority({}, f.state.address), /does not support 1-TX Transfers/);
});
test('No authority found clears only the definite preflight failure; generic 4001 preserves payment after reload', async () => {
  const f = fixture(true); await f.wallet.connect();
  f.state.transferError = { code: 4001, message: 'No authority found' };
  await assert.rejects(f.wallet.pay(f.id), /Turn on 1-TX Transfers/);
  assert.equal(f.records.get(f.wallet.key(f.id))?.payment, undefined);
  f.state.transferError = { code: 4001, message: 'User rejected the request.' };
  await assert.rejects(f.wallet.pay(f.id), /reports the payment was cancelled/);
  const resumed = new TapWalletMint(f.options); await resumed.connect();
  const pending = await resumed.pay(f.id);
  assert.equal(pending.localState, 'payment_pending'); assert.equal(pending.retryable, true);
  assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 2);
  f.state.transferError = null;
  const chain = { mempool: [{ txid: 'aa' }], chain: [] }, seen = [];
  resumed.fetchImpl = async url => { if (walletFundsReply(url)) return walletFundsFetch(url); seen.push(url); return { ok: true, json: async () => url.endsWith('/txs/mempool') ? chain.mempool : chain.chain }; };
  await assert.rejects(resumed.pay(f.id, { retry: true }), /still unconfirmed/);
  chain.mempool = []; chain.chain = [{ txid: 'bb', status: { confirmed: true, block_time: Math.floor(Date.now() / 1000) } }];
  await assert.rejects(resumed.pay(f.id, { retry: true }), /sent a Bitcoin transaction after/);
  assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 2, 'Bitcoin activity never allows a second payment');
  chain.chain = [{ txid: 'cc', status: { confirmed: true, block_time: Math.floor(Date.now() / 1000) - 86400 } }];
  assert.ok(seen.every(url => url.startsWith('https://mempool.space/api/address/' + resumed.address + '/txs/')));
  assert.equal((await resumed.pay(f.id, { retry: true })).localState, 'payment_submitted');
  assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 3);
  const after = await resumed.pay(f.id, { retry: true });
  assert.equal(after.localState, 'payment_pending'); assert.equal(after.retryable, false);
  assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 3);
});
test('a TAP Wallet refusal before signing says nothing was sent and allows a plain retry', async () => {
  const f = fixture(true); await f.wallet.connect();
  f.state.transferError = { code: 4001, message: 'Transaction cannot be processed due to the following issues:\n\n• Insufficient amount for tokens: tap\n' };
  await assert.rejects(f.wallet.pay(f.id), /refused the payment before signing: your wallet does not have enough spendable TAP.*Nothing was sent/s);
  assert.equal(f.records.get(f.wallet.key(f.id))?.payment, undefined);
  f.state.transferError = { code: 4001, message: 'Invalid items' };
  await assert.rejects(f.wallet.pay(f.id), /refused the payment before signing: Invalid items\. Nothing was sent/);
  f.state.transferError = null;
  assert.equal((await f.wallet.pay(f.id)).localState, 'payment_submitted');
});
test('an unknown TAP Wallet error keeps the payment uncertain and shows the wallet message', async () => {
  const f = fixture(true); await f.wallet.connect();
  f.state.transferError = { code: -32603, message: 'broadcast failed: bad-txns' };
  await assert.rejects(f.wallet.pay(f.id), /did not return a payment receipt\. TAP Wallet said: “broadcast failed: bad-txns”/);
  assert.equal(f.records.get(f.wallet.key(f.id))?.payment?.state, 'sending');
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

test('a submitted payment resolves its redeem inscription from Bitcoin for reporting', async () => {
  const f = fixture(true); await f.wallet.connect(); await f.wallet.pay(f.id);
  const funding = f.records.get(f.wallet.key(f.id)).payment.result.txid, reveal = 'ab'.repeat(32), urls = [];
  const replies = { [funding]: { vin: [{ witness: ['sig'] }] }, [funding + '/outspend/0']: { spent: false } };
  f.wallet.fetchImpl = async url => { urls.push(url); const key = url.split('/api/tx/')[1]; return { ok: key in replies, json: async () => replies[key] }; };
  assert.equal(await f.wallet.paymentInscription(f.id), null, 'not revealed yet');
  replies[funding + '/outspend/0'] = { spent: true, txid: reveal };
  assert.equal(await f.wallet.paymentInscription(f.id), reveal + 'i0');
  replies[funding] = { vin: [{ witness: ['sig', 'script', 'control'] }] };
  assert.equal(await f.wallet.paymentInscription(f.id), funding + 'i0', 'a receipt naming the reveal is used directly');
  assert.equal(await f.wallet.paymentInscription('34'.repeat(32)), null, 'no saved receipt, nothing to report');
  assert.ok(urls.every(url => url.startsWith('https://mempool.space/api/tx/')));
});

// TAP Wallet 1.0.49: one approval pays the fees and sets aside the Bitcoin for the server-sent mint.
const setAsideAddress = (network = 'mainnet') => fundingAddress(hex(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true)), network);
function fixture1049({ version, mintFunding } = {}) {
  const f = fixture(true), wallet = tapWallet1049({ address: f.status.receiver, publicKey: hex(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true)), active: true, version });
  const seen = [], provider = new Proxy(wallet.provider, { get: (target, name) => typeof target[name] === 'function' ? (...args) => { seen.push([name, args.length]); return target[name](...args); } : target[name] });
  if (mintFunding !== undefined) f.status.mintFunding = mintFunding;
  const options = { ...f.options, provider };
  return { ...f, ...wallet, seen, options, wallet: new TapWalletMint(options) };
}
test('1.0.49 with mintFunding sends one transfer carrying the set-aside output, journals it and never pays twice', async () => {
  const mintFunding = { address: setAsideAddress(), satoshis: 4200, feeRate: 6, label: 'your mint inscription' };
  const f = fixture1049({ mintFunding }); await f.wallet.connect();
  const result = await f.wallet.pay(f.id);
  assert.equal(result.localState, 'payment_submitted'); assert.equal(result.mintFunded, true);
  const sent = f.state.calls.filter(c => c[0] === 'singleTxTransfer');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][2], { extraOutputs: [{ address: mintFunding.address, satoshis: 4200, label: 'your mint inscription' }] });
  const record = f.records.get(f.wallet.key(f.id)).payment;
  assert.deepEqual(record.extraOutputs, [{ address: mintFunding.address, satoshis: 4200, label: 'your mint inscription' }]);
  assert.deepEqual(record.result.extraOutputs, [{ address: mintFunding.address, satoshis: 4200, vout: 1 }]);
  const again = new TapWalletMint(f.options); await again.connect();
  assert.equal((await again.pay(f.id)).localState, 'payment_pending');
  assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 1);
});
test('1.0.49 without mintFunding keeps the 1.0.48 transfer call: items only, no options argument', async () => {
  const f = fixture1049(); await f.wallet.connect();
  const result = await f.wallet.pay(f.id);
  assert.equal(result.localState, 'payment_submitted'); assert.equal(result.mintFunded, undefined);
  assert.deepEqual(f.seen.filter(c => c[0] === 'singleTxTransfer'), [['singleTxTransfer', 1]]);
  assert.equal(f.records.get(f.wallet.key(f.id)).payment.extraOutputs, undefined);
});
test('a wallet older than 1.0.49 is refused before any other wallet call', async () => {
  for (const version of [undefined, '1.0.48', '1.0', '0.9.99', 'v1.0.49', '']) {
    const f = fixture1049({ version });
    if (version === undefined) { f.provider.getCapabilities = undefined; assert.equal(typeof tapWallet1048({}).provider.getCapabilities, 'undefined'); }
    const seen = [], provider = new Proxy(f.provider, { get: (target, name) => typeof target[name] === 'function' ? (...args) => { seen.push(name); return target[name](...args); } : target[name] });
    const wallet = new TapWalletMint({ ...f.options, provider });
    await assert.rejects(wallet.connect(), /This needs TAP Wallet 1\.0\.49 or newer\. Update TAP Wallet, then reload this page\./, String(version));
    assert.deepEqual(seen.filter(name => name !== 'getCapabilities'), [], String(version));
    assert.deepEqual(f.state.calls, []);
  }
  // A wallet downgraded after connecting is refused before the payment.
  const f = fixture1049(); await f.wallet.connect(); f.state.version = '1.0.48';
  await assert.rejects(f.wallet.pay(f.id), /1\.0\.49 or newer/);
  assert.deepEqual(f.state.calls, []); assert.equal(f.records.get(f.wallet.key(f.id)), undefined);
  for (const version of ['1.0.49', '1.0.50', '1.0.100', '1.1', '2.0.0']) { const ok = fixture1049({ version }); await ok.wallet.connect(); }
});
test('an invalid mintFunding is refused before the authority check, the journal and the transfer', async () => {
  const good = { address: setAsideAddress(), satoshis: 4200, label: 'your mint inscription' };
  const legacy = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
  for (const mintFunding of [{ ...good, address: setAsideAddress('regtest') }, { ...good, address: legacy }, { ...good, address: good.address.toUpperCase() },
    { ...good, address: good.address.slice(0, -1) + (good.address.endsWith('q') ? 'p' : 'q') }, { ...good, satoshis: 545 }, { ...good, satoshis: 100001 },
    { ...good, satoshis: 4200.5 }, { ...good, satoshis: '4200' }, { ...good, label: 'x'.repeat(41) }, { ...good, label: '<b>mint</b>' }, { ...good, label: 'a\nb' }, 'bc1q', null]) {
    const f = fixture1049({ mintFunding }); await f.wallet.connect();
    if (mintFunding === null) { assert.equal((await f.wallet.pay(f.id)).localState, 'payment_submitted'); continue; }
    await assert.rejects(f.wallet.pay(f.id), /set-aside for the mint is not valid\. Nothing was paid/, JSON.stringify(mintFunding));
    assert.deepEqual(f.seen.filter(c => ['getCurrentAuthority', 'singleTxTransfer'].includes(c[0])), [], JSON.stringify(mintFunding));
    assert.equal(f.records.get(f.wallet.key(f.id)), undefined);
  }
});
test('mintFunding that changes while the wallet is checked stops the payment', async () => {
  const f = fixture1049({ mintFunding: { address: setAsideAddress(), satoshis: 4200, label: 'your mint inscription' } }); await f.wallet.connect();
  let reads = 0; const read = f.options.readStatus;
  const wallet = new TapWalletMint({ ...f.options, readStatus: async id => { const s = await read(id); return ++reads > 1 ? { ...s, mintFunding: { ...s.mintFunding, satoshis: 5000 } } : s; } });
  await wallet.connect();
  await assert.rejects(wallet.pay(f.id), /Payment changed while checking the wallet/);
  assert.deepEqual(f.state.calls.filter(c => c[0] === 'singleTxTransfer'), []);
  assert.equal(f.records.get(f.wallet.key(f.id)), undefined);
});
test('a 1.0.49 wallet without extraOutputs support pays the two-step way', async () => {
  const f = fixture1049({ mintFunding: { address: setAsideAddress(), satoshis: 4200, label: 'your mint inscription' } });
  f.provider.getCapabilities = async () => ({ version: '1.0.49' });
  await f.wallet.connect(); await f.wallet.pay(f.id);
  assert.deepEqual(f.seen.filter(c => c[0] === 'singleTxTransfer'), [['singleTxTransfer', 1]]);
});
