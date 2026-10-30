import test from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { TapWalletMint } from '../lib/tap-wallet-mint.mjs';
import { EthereumMint } from '../lib/ethereum-mint.mjs';
import { fundingAddress, hex, unhex } from '../lib/inscription-core.mjs';
import { atomicAmount, checkTapFunds, checkEthereumFunds, cardinalCoins, readFunds } from '../lib/wallet-funds.mjs';
import { tapWallet1049 } from './tap-wallet-1049-fixture.mjs';
import { walletFundsReply, cardinalFixture } from './wallet-funds-fixture.mjs';

const id = '12'.repeat(32), key = new Uint8Array(32).fill(4), publicKey = hex(secp256k1.getPublicKey(key));
const address = fundingAddress(publicKey, 'mainnet');
function tapFixture() {
  const f = tapWallet1049({ address, publicKey }), rows = new Map(), reader = {}, reads = [];
  const fees = [{ role: 'treasury', to: address, ticker: 'tap', amount: atomicAmount('440.7', 18).toString(), tt: 'a' }];
  const status = { requestId: id, receiver: address, payer: address, fees, missing: fees, state: 'awaiting_payment', payable: true, payBy: { rail: 'tap' } };
  const journal = { get: async k => structuredClone(rows.get(k)), put: async (k, v) => rows.set(k, structuredClone(v)), lock: async (_, fn) => fn() };
  const fetchImpl = async (url, options) => {
    reads.push(url); assert.equal(options?.method, undefined, 'preflight never writes');
    if (reader.error) throw Error(reader.error);
    return { ok: !reader.httpError, status: 503, json: async () => reader.malformed ? {} : walletFundsReply(url, reader) };
  };
  const wallet = new TapWalletMint({ provider: f.provider, readStatus: async () => status, network: 'mainnet', journal, fetchImpl });
  return { ...f, rows, status, journal, reader, reads, fetchImpl, wallet };
}
for (const [label, reader, words] of [
  ['short TAP', { overall: atomicAmount('103.18', 18).toString() }, /needs 440\.7 TAP.*can spend 103\.18 TAP/],
  ['TAP held in transfer inscriptions', { overall: atomicAmount('103.18', 18).toString(), held: atomicAmount('102.5', 18).toString() }, /needs 440\.7 TAP.*can spend 0\.68 TAP.*102\.5 TAP is held in transfer inscriptions/],
  ['locked TAP', { overall: atomicAmount('500', 18).toString(), locked: atomicAmount('100', 18).toString() }, /can spend 400 TAP.*100 TAP is locked/],
  ['failed TAP read', { error: 'reader offline' }, /Could not check your TAP balance \(reader offline\).*Nothing was sent/],
  ['malformed TAP read', { malformed: true }, /Could not check your TAP balance.*invalid TAP balance response/],
  ['HTTP read failure', { httpError: true }, /Could not check your TAP balance.*HTTP 503/],
]) test(`${label} blocks Pay and mint before transfer or an uncertain journal entry`, async () => {
  const f = tapFixture(); Object.assign(f.reader, reader); await f.wallet.connect();
  await assert.rejects(f.wallet.pay(id), error => { assert.match(error.message, words); assert.ok(error.message.includes(address)); return true; });
  assert.equal(f.state.calls.length, 0); assert.equal(f.rows.get(f.wallet.key(id))?.payment, undefined);
  Object.keys(f.reader).forEach(k => delete f.reader[k]);
  await f.wallet.pay(id); assert.equal(f.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 1);
});

test('Bitcoin set-aside and miner fees are checked even when TAP is sufficient', async () => {
  const f = tapFixture(); await f.wallet.connect(); f.state.coins = [cardinalFixture(4100)];
  f.status.mintFunding = { address, satoshis: 19200 };
  await assert.rejects(f.wallet.pay(id), /Not enough Bitcoin for fees:.*needs about [\d,]+ sats.*4,100 sats spendable.*Nothing was sent.*estimate/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.rows.get(f.wallet.key(id))?.payment, undefined);
  f.state.coins = [cardinalFixture(100000)]; await f.wallet.pay(id);
  assert.deepEqual(f.state.calls[0][2], { extraOutputs: [{ address, satoshis: 19200, label: 'your mint inscription' }] });
});

test('Bitcoin balance and fee read failures never open transfer approval', async () => {
  for (const failure of ['coins', 'fees']) {
    const f = tapFixture(); await f.wallet.connect();
    if (failure === 'coins') f.provider.getBitcoinUtxos = async () => { throw Error('coin lookup failed'); };
    else f.wallet.fetchImpl = async (url, options) => { if (url.includes('fees/recommended')) throw Error('fee lookup failed'); return f.fetchImpl(url, options); };
    await assert.rejects(f.wallet.pay(id), /Could not check your Bitcoin.*lookup failed/);
    assert.equal(f.state.calls.length, 0); assert.equal(f.rows.get(f.wallet.key(id))?.payment, undefined);
  }
});

test('cardinal Bitcoin excludes inscriptions, unconfirmed, spent and protected coins and rejects duplicate coins', async () => {
  const base = cardinalFixture(1000);
  const provider = { getBitcoinUtxos: async () => [base, { ...base, inscriptions: [{}] }, { ...base, height: 0 }, { ...base, isSpent: true }, { ...base, isUserSpendable: true }] };
  assert.deepEqual(await cardinalCoins(provider, address), [base]);
  provider.getBitcoinUtxos = async () => [base, base];
  await assert.rejects(cardinalCoins(provider, address), /duplicate Bitcoin coin/);
});

test('TAP sums each ticker with its own decimals and preserves sub-number precision', async () => {
  let sends = 0;
  const balances = { tap: { dec: 18, total: '1000000000000000001' }, other: { dec: 3, total: '1234' } };
  const fetchImpl = async url => {
    const tick = url.split('/').at(-1), body = url.includes('/getAccountTokensBalance/')
      ? { data: { total: 2, list: Object.entries(balances).map(([ticker, b]) => ({ ticker, overallBalance: b.total, transferableBalance: '' })) } }
      : url.includes('/getDeployment/') ? { result: { tick, dec: balances[tick].dec } }
      : url.includes('fees/recommended') ? { halfHourFee: 1 } : { result: '0' };
    return { ok: true, json: async () => body };
  };
  const items = [{ tick: 'tap', amt: '1' }, { tick: 'TAP', amt: '0.000000000000000001' }, { tick: 'other', amt: '1.234' }];
  const pay = async () => { await checkTapFunds({ provider: { getBitcoinUtxos: async () => [cardinalFixture()] }, address, network: 'mainnet', items, fetchImpl }); sends++; };
  await pay(); assert.equal(sends, 1);
  items.push({ tick: 'tap', amt: '0.000000000000000001' });
  await assert.rejects(pay(), /needs 1\.000000000000000002 TAP.*can spend 1\.000000000000000001 TAP/); assert.equal(sends, 1);
  items.pop(); items.push({ tick: 'other', amt: '0.001' });
  await assert.rejects(pay(), /needs 1\.235 OTHER.*can spend 1\.234 OTHER/); assert.equal(sends, 1);
});

test('TAP missing ticker is zero only after a complete balance page; incomplete pages fail closed', async () => {
  const f = tapFixture(); await f.wallet.connect();
  f.wallet.fetchImpl = async (url, options) => url.includes('/getAccountTokensBalance/')
    ? { ok: true, json: async () => ({ data: { total: 0, list: [] } }) } : f.fetchImpl(url, options);
  await assert.rejects(f.wallet.pay(id), /can spend 0 TAP/); assert.equal(f.state.calls.length, 0);
  f.wallet.fetchImpl = async () => ({ ok: true, json: async () => ({ data: { total: 101, list: [] } }) });
  await assert.rejects(f.wallet.pay(id), /incomplete TAP balance response/); assert.equal(f.state.calls.length, 0);
});

for (const change of ['short', 'spent', 'read failure']) test(`inscription ${change} after confirmation prevents signPsbt and allows a fresh plan`, async () => {
  const f = tapFixture(); await f.wallet.connect();
  const coin = { ...cardinalFixture(), scriptPk: hex(btc.p2tr(secp256k1.getPublicKey(key).slice(1)).script) };
  f.state.coins = [coin]; let signs = 0;
  f.provider.signPsbt = async raw => { signs++; const tx = btc.Transaction.fromPSBT(unhex(raw)); tx.sign(key); tx.finalize(); return hex(tx.toPSBT(0)); };
  f.provider.pushPsbt = async raw => btc.Transaction.fromPSBT(unhex(raw)).id;
  f.provider.pushTx = async raw => btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true }).id;
  const options = { feeRate: 2, maxFeeSats: '10000', confirm: async () => {
    if (change === 'short') f.state.coins = [cardinalFixture(50)];
    if (change === 'spent') f.state.coins = [{ ...coin, txid: '78'.repeat(32) }];
    if (change === 'read failure') f.provider.getBitcoinUtxos = async () => { throw Error('offline'); };
    return true;
  } };
  await assert.rejects(f.wallet.inscribeContent(id, 'fixture', 'deploy', options), /Not enough Bitcoin|no longer spendable|Could not check your Bitcoin balance/);
  assert.equal(signs, 0); assert.equal(f.rows.get(f.wallet.key(id))?.deploy, undefined);
  f.state.coins = [coin]; f.provider.getBitcoinUtxos = async () => f.state.coins;
  await f.wallet.inscribeContent(id, 'fixture', 'deploy', { ...options, confirm: async () => true });
  assert.equal(signs, 1);
});

test('an initially unfunded inscription explains required and available Bitcoin before signPsbt', async () => {
  const f = tapFixture(); await f.wallet.connect(); f.state.coins = [];
  let signs = 0; f.provider.signPsbt = async () => { signs++; };
  await assert.rejects(f.wallet.inscribeContent(id, 'fixture', 'mint', { feeRate: 2, maxFeeSats: '10000', confirm: async () => true }), /needs about [\d,]+ sats.*can fund 0 sats.*Wallet:.*Nothing was sent/);
  assert.equal(signs, 0);
});

const payer = '0x' + '11'.repeat(20), contract = '0x' + '22'.repeat(20), tokenAddress = '0x' + '33'.repeat(20);
function ethFixture() {
  const funds = { eth: 100000n, token: 100n, allowance: 100n, gas: 21000n, price: 2n }, sent = [], rows = new Map();
  const provider = { request: async ({ method, params }) => {
    if (funds.fail === method) throw Error('RPC unavailable');
    const hex = n => '0x' + n.toString(16);
    if (method === 'eth_accounts') return [payer];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBalance') return hex(funds.eth);
    if (method === 'eth_estimateGas') return hex(funds.gas);
    if (method === 'eth_gasPrice') return hex(funds.price);
    if (method === 'eth_call') return params[0].data === '0x313ce567' ? '0x0' : hex(params[0].data.startsWith('0xdd62ed3e') ? funds.allowance : funds.token);
    if (method === 'eth_sendTransaction') { sent.push(params[0]); return '0x' + '44'.repeat(32); }
    throw Error('Unexpected method ' + method);
  } };
  const journal = { get: async k => rows.get(k), put: async (k, v) => rows.set(k, v) };
  const wallet = new EthereumMint({ provider, journal }); wallet.address = payer; wallet.target = { ethereum: { chainId: '0x1' } };
  const transaction = { from: payer, to: contract, value: '0x64', data: '0x1234' };
  const token = { address: tokenAddress, amount: '100', spender: contract, requireAllowance: true };
  return { provider, wallet, funds, sent, rows, transaction, token };
}
for (const [label, funds, words] of [
  ['short ETH including gas', { eth: 100n }, /needs about 0\.0000000000000421 ETH.*has 0\.0000000000000001 ETH/],
  ['short ERC-20', { token: 99n }, /needs 100 ERC-20 tokens.*has 99 ERC-20 tokens/],
  ['short allowance', { allowance: 99n }, /allowance.*needs 100.*allowance is 99/],
  ['failed native read', { fail: 'eth_getBalance' }, /Could not check your Ethereum balance and gas.*RPC unavailable/],
  ['failed gas read', { fail: 'eth_estimateGas' }, /Could not check your Ethereum balance and gas.*RPC unavailable/],
  ['failed ERC-20 read', { fail: 'eth_call' }, /Could not check your ERC-20 balance.*RPC unavailable/],
]) test(`${label} never calls eth_sendTransaction or records sending`, async () => {
  const f = ethFixture(); Object.assign(f.funds, funds);
  await assert.rejects(f.wallet.step('payment', 'deposit', f.transaction, f.token), words);
  assert.equal(f.sent.length, 0); assert.equal(f.rows.size, 0);
  Object.assign(f.funds, { eth: 100000n, token: 100n, allowance: 100n, fail: undefined });
  await f.wallet.step('payment', 'deposit', f.transaction, f.token);
  assert.deepEqual(f.sent, [f.transaction]);
});

test('Ethereum uses explicit EIP-1559 maxFeePerGas and checks release/refund gas without charging token balance', async () => {
  const f = ethFixture(); f.transaction.maxFeePerGas = '0x5'; f.funds.eth = 100000n; f.funds.token = 0n;
  await assert.rejects(f.wallet.step('payment', 'release', f.transaction), /needs about 0\.0000000000001051 ETH/);
  assert.equal(f.sent.length, 0); f.funds.eth = 105100n;
  await f.wallet.step('payment', 'release', f.transaction); assert.deepEqual(f.sent, [f.transaction]);
});

test('balance reads time out, late completion cannot open approval, and successful reads clear their timer', async () => {
  let finish, sends = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  await assert.rejects((async () => { await readFunds('TAP balance', address, () => pending, 5); sends++; })(), /read timed out.*Nothing was sent/);
  finish(1000n); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(sends, 0);
  assert.equal(await readFunds('TAP balance', address, async () => 1n, 5), 1n);
  const f = ethFixture(); f.provider.request = async () => new Promise(() => {});
  await assert.rejects(checkEthereumFunds({ provider: f.provider, transaction: f.transaction, timeoutMs: 5 }), /read timed out/);
  assert.equal(f.sent.length, 0);
});
