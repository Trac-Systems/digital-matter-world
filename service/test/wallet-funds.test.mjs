import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletJournal, tapPaymentStep, ethereumPaymentStep, escrowPaymentToken } from '../public/web/wallets.js';
import { tapWallet1049 } from '../../kit/test/tap-wallet-1049-fixture.mjs';
import { walletFundsReply, cardinalFixture } from '../../kit/test/wallet-funds-fixture.mjs';
import { createWeb } from '../src/web.mjs';

function journal() {
  const saved = new Map();
  globalThis.localStorage = { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v) };
  return new WalletJournal('funds-test');
}
const address = 'bc1pfixture';
function tapFixture() {
  const f = tapWallet1049({ address }), reader = {}, j = journal();
  const fetchImpl = async url => {
    if (reader.fail) throw Error('reader offline');
    return { ok: true, json: async () => walletFundsReply(url, reader) };
  };
  return { ...f, reader, j, options: { provider: f.provider, address, network: 'mainnet', fetchImpl } };
}
test('site Bitmap lock totals its token amount and cannot open an unfunded wallet', async () => {
  const f = tapFixture(), message = { auth: f.authId, items: [], actions: [{ op: 'lock', tick: 'tap', amt: '3' }] };
  f.reader.overall = '2000000000000000000';
  await assert.rejects(tapPaymentStep(f.j, 'lock', { ...f.options, message }), /needs 3 TAP.*can spend 2 TAP/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.j.getStep('lock'), undefined);
  f.reader.overall = '3000000000000000000';
  await tapPaymentStep(f.j, 'lock', { ...f.options, message, options: { label: 'Bitmap lock' } });
  assert.deepEqual(f.state.calls, [['redeemTapActions', message, { label: 'Bitmap lock' }]]);
  f.reader.fail = true;
  await tapPaymentStep(f.j, 'lock', { ...f.options, message });
  assert.equal(f.state.calls.length, 1, 'saved result bypasses both payment and balance read');
});
for (const op of ['claim', 'refund']) test(`site TAP ${op} needs cardinal Bitcoin but no second TAP balance`, async () => {
  const f = tapFixture(), message = { auth: f.authId, items: [], actions: [{ op, lock: 'lock-id' }] };
  f.state.coins = [cardinalFixture(100)]; f.reader.overall = '0';
  await assert.rejects(tapPaymentStep(f.j, op, { ...f.options, message }), /Not enough Bitcoin for fees/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.j.getStep(op), undefined);
  f.state.coins = [cardinalFixture()];
  await tapPaymentStep(f.j, op, { ...f.options, message });
  assert.equal(f.state.calls.length, 1);
});
test('site direct fee payment rejects held TAP and read failures before journal or transfer', async () => {
  const f = tapFixture(), message = { items: [{ tick: 'tap', amt: '1' }] };
  f.reader.overall = '1000000000000000000'; f.reader.held = '500000000000000000';
  await assert.rejects(tapPaymentStep(f.j, 'fees', { ...f.options, message, transfer: true }), /can spend 0\.5 TAP.*transfer inscriptions/);
  f.reader.fail = true;
  await assert.rejects(tapPaymentStep(f.j, 'fees', { ...f.options, message, transfer: true }), /Could not check your TAP balance/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.j.getStep('fees'), undefined);
  f.reader.fail = false; f.reader.held = '0';
  await tapPaymentStep(f.j, 'fees', { ...f.options, message, transfer: true });
  assert.deepEqual(f.state.calls, [['singleTxTransfer', message.items]]);
});
test('uncertain site wallet sends remain uncertain and are never automatically repeated', async () => {
  const f = tapFixture(), message = { items: [{ tick: 'tap', amt: '1' }] };
  f.state.transferError = Error('reply lost');
  await assert.rejects(tapPaymentStep(f.j, 'fees', { ...f.options, message, transfer: true }), /reply lost/);
  f.state.transferError = null;
  await assert.rejects(tapPaymentStep(f.j, 'fees', { ...f.options, message, transfer: true }), /interrupted/);
  assert.equal(f.state.calls.length, 1); assert.equal(f.j.getStep('fees').state, 'sending');
});

const payer = '0x' + '11'.repeat(20), token = '0x' + '22'.repeat(20), escrow = '0x' + '33'.repeat(20);
test('site Ethereum approval, deposit, release and refund check funds before each wallet call', async () => {
  const j = journal(), sent = [], funds = { eth: 10n, tokens: 0n, allowance: 0n };
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts') return [payer];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBalance') return '0x' + funds.eth.toString(16);
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_gasPrice') return '0x2';
    if (method === 'eth_call') return params[0].data === '0x313ce567' ? '0x0' : '0x' + (params[0].data.startsWith('0xdd62ed3e') ? funds.allowance : funds.tokens).toString(16);
    if (method === 'eth_sendTransaction') { sent.push(params[0]); return 'tx'; }
    throw Error(method);
  } };
  const approval = { from: payer, to: token, data: '0x095ea7b3' + escrow.slice(2).padStart(64, '0') + '64'.padStart(64, '0') };
  const meta = escrowPaymentToken(approval, { token, escrow });
  const pay = (name, transaction, token) => ethereumPaymentStep(j, name, { provider, transaction, token, chainId: '0x1' });
  await assert.rejects(pay('approval', approval, meta), /Not enough bridged TAP/);
  assert.equal(sent.length, 0); assert.equal(j.getStep('approval'), undefined);
  funds.tokens = 100n;
  await assert.rejects(pay('approval', approval, meta), /Not enough ETH/); assert.equal(sent.length, 0);
  funds.eth = 42000n; await pay('approval', approval, meta);
  const deposit = { from: payer, to: escrow, data: '0x1234' };
  await assert.rejects(pay('deposit', deposit, { ...meta, requireAllowance: true }), /allowance/); assert.equal(sent.length, 1);
  funds.allowance = 100n; await pay('deposit', deposit, { ...meta, requireAllowance: true });
  funds.tokens = 0n;
  for (const name of ['release', 'refund']) {
    funds.eth = 0n; await assert.rejects(pay(name, deposit), /Not enough ETH/); assert.equal(j.getStep(name), undefined);
    funds.eth = 42000n; await pay(name, deposit);
  }
  assert.deepEqual(sent, [approval, deposit, deposit, deposit]);
});

test('a delayed wallet approval is awaited without a timeout or retry', async () => {
  const f = tapFixture(), message = { items: [{ tick: 'tap', amt: '1' }] };
  let approve, called = 0, settled = false;
  f.provider.singleTxTransfer = () => { called++; return new Promise(resolve => { approve = resolve; }); };
  const pending = tapPaymentStep(f.j, 'fees', { ...f.options, message, transfer: true }).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(called, 1); assert.equal(settled, false); assert.equal(f.j.getStep('fees').state, 'sending');
  approve({ txid: 'saved' }); assert.deepEqual(await pending, { txid: 'saved' });
});

test('local balance reader routes are restricted to GET, known reads and regtest', async () => {
  const paths = [], checkout = { target: { bitcoinNetwork: 'regtest' }, reads: { tap: async path => { paths.push(path); return '123'; } } };
  const web = createWeb(checkout), response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = value; } });
  const res = response();
  await web.handle({ method: 'GET', url: '/web-api/tap-reader/getBalance/bcrt1pfixture/tap', headers: {} }, res);
  assert.deepEqual(JSON.parse(res.body), { result: '123' }); assert.deepEqual(paths, ['getBalance/bcrt1pfixture/tap']);
  checkout.target.bitcoinNetwork = 'mainnet';
  await assert.rejects(web.handle({ method: 'GET', url: '/web-api/tap-reader/getBalance/bcrt1pfixture/tap', headers: {} }, response()), /unavailable/);
  checkout.target.bitcoinNetwork = 'regtest';
  for (const [method, url] of [['POST', '/web-api/tap-reader/getBalance/x/tap'], ['GET', '/web-api/tap-reader/delete/x'], ['GET', '/web-api/tap-reader/getBalance/x/tap?other=1']])
    await assert.rejects(web.handle({ method, url, headers: {} }, response()));
  assert.equal(paths.length, 1);
  const asset = response(); await web.handle({ method: 'GET', url: '/kit/lib/wallet-funds.mjs', headers: {} }, asset);
  assert.match(asset.body.toString(), /checkTapFunds/);
  const html = response(); await web.handle({ method: 'GET', url: '/mint', headers: { accept: 'text/html' } }, html);
  assert.match(html.headers['Content-Security-Policy'], /connect-src 'self' https:\/\/mempool.space https:\/\/reader.tapscope.io https:\/\/openmayhem.ai;/);
});
