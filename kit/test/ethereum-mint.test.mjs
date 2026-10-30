import test from 'node:test';
import assert from 'node:assert/strict';
import { EthereumMint } from '../lib/ethereum-mint.mjs';
import { calldata, TYPES } from '../../committee/signer/escrow.mjs';
import { releaseCalldata } from '../../service/src/ethereum.mjs';

const id = 'ab'.repeat(32), payer = '0x' + '12'.repeat(20), token = '0x' + '34'.repeat(20), escrow = '0x' + '56'.repeat(20), treasury = '0x' + '78'.repeat(20), zero = '0x' + '00'.repeat(20);
function fixture() {
  const target = { bitcoinNetwork: 'regtest', ethereum: { chainId: '0x7a69', token, escrow } };
  const split = { treasury, treasuryAmount: '1', finder: zero, finderAmount: '0', landowner: zero, landownerAmount: '0', discoverer: zero, discovererAmount: '0', burnAmount: '1' };
  const fees = [{ role: 'treasury', to: treasury, ticker: 'tap', amount: '1', tt: 'a' }, { role: 'burn', to: null, ticker: 'tap', amount: '1', tt: 'b' }];
  let expiry = 1000000;
  const plan = { requestId: id, kind: 'ethereum', payer, receiver: 'bound-bitcoin-wallet', target, fees, missing: fees, state: 'awaiting_payment', payable: true, payableAmount: '2', ethereumDepositStatus: 0 };
  const readPlan = async () => ({ ...plan, transactions: [
    { from: payer, to: token, data: calldata('approve(address,uint256)', [['address', escrow], ['uint256', '2']]) },
    { from: payer, to: escrow, data: calldata('deposit(bytes32,uint256,(address,uint256,address,uint256,address,uint256,address,uint256,uint256),uint256)', [['bytes32', id], ['uint256', '2'], ...TYPES.Split.map(({name,type}) => [type, split[name]]), ['uint256', String(++expiry)]]) }
  ] });
  const rows = new Map(), sent = []; let loseDeposit = false, chainId = target.ethereum.chainId;
  const journal = { async get(key) { return structuredClone(rows.get(key)); }, async put(key,value) { rows.set(key,structuredClone(value)); }, async lock(key,fn) { return fn(); } };
  const provider = { async request({ method, params }) {
    if (['eth_accounts','eth_requestAccounts'].includes(method)) return [payer];
    if (method === 'eth_chainId') return chainId;
    if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
    if (method === 'eth_estimateGas') return '0x186a0';
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_call') return params[0].data === '0x313ce567' ? '0x12' : '0xde0b6b3a7640000';
    if (method === 'eth_sendTransaction') { sent.push(params[0]); if (loseDeposit && sent.length === 2) throw Error('reply lost'); return '0x' + String(sent.length).repeat(64); }
    throw Error(method);
  } };
  const status = { ethereumRelease: { chainId: '31337', to: escrow, data: releaseCalldata(payer, id, '0x' + '01'.repeat(65)) } };
  const wallet = new EthereumMint({ provider, journal, network: 'regtest', readTarget: async () => target, readPlan, readStatus: async () => status });
  return { wallet, rows, sent, plan, provider, wrongChain() { chainId = '0x1'; }, loseDeposit() { loseDeposit = true; } };
}

test('Ethereum approval and deposit preserve exact terms across retries and release from the payer', async () => {
  const f = fixture(); await f.wallet.connect(payer);
  const first = await f.wallet.pay(id), second = await f.wallet.pay(id);
  assert.equal(first.transaction, second.transaction); assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].to, token); assert.equal(f.sent[1].to, escrow);
  await f.wallet.release(id); await f.wallet.release(id); assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].from, payer); assert.equal(f.sent[2].value, '0x0');
  f.plan.ethereumDepositStatus = 1; assert.equal((await f.wallet.pay(id)).sent, false); assert.equal(f.sent.length, 3);
});

test('Ethereum ambiguous deposit responses never cause another approval or deposit', async () => {
  const f = fixture(); await f.wallet.connect(); f.loseDeposit();
  await assert.rejects(f.wallet.pay(id), /reply lost/);
  await assert.rejects(f.wallet.pay(id), /interrupted/); assert.equal(f.sent.length, 2);
});

test('Ethereum refuses account/chain changes, mismatched quotes and pending reservations', async () => {
  const f = fixture(); await assert.rejects(f.wallet.connect(treasury), /payer/); await f.wallet.connect();
  f.plan.payable = false; await assert.rejects(f.wallet.pay(id), /not accepting/); assert.equal(f.sent.length, 0);
  f.plan.payable = true; f.plan.payableAmount = '3'; await assert.rejects(f.wallet.pay(id), /approval differs/); assert.equal(f.sent.length, 0);
  f.wrongChain(); await assert.rejects(f.wallet.pay(id), /network changed/); assert.equal(f.sent.length, 0);
});
