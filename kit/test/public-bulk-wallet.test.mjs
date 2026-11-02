import test from 'node:test';
import assert from 'node:assert/strict';
import { TapWalletPublicBulkMint, publicBulkPaymentPlan } from '../lib/tap-wallet-bulk-mint.mjs';
import { fundingAddress } from '../lib/inscription-core.mjs';

// A public bulk order paid by TAP Wallet alone: the plan is checked before any wallet call, funds are checked
// before the payment opens, and one payment carries every fee item and one set-aside per block.
const PUB = '02' + '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PAYER = fundingAddress(PUB, 'mainnet'), FUND = fundingAddress('02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5', 'mainnet');
const ORDER = 'e7'.repeat(32), T = n => (BigInt(n) * 10n ** 18n).toString();
const status = (extra = {}) => ({ v: 1, publicBulk: true, orderId: ORDER, state: 'awaiting_payment', payable: true, payer: PAYER, receiver: PAYER, bitcoinNetwork: 'mainnet',
  payBy: { rail: 'tap', untilBlock: '900006' }, paymentIds: [], counts: { total: 2 }, members: [{ block: '1' }, { block: '2' }], payableAmount: T(6), mintFundingSatoshis: '4368',
  redeem: { items: [{ tick: 'tap', amt: '3', address: PAYER, dta: 'a' }, { tick: 'tap', amt: '3', address: PAYER, dta: 'b' }], data: '', actions: [] },
  extraOutputs: [{ address: FUND, satoshis: 2184, label: 'your mint inscription' }, { address: FUND, satoshis: 2184, label: 'your mint inscription' }], ...extra });

test('the plan takes every fee item and one set-aside per block, and refuses anything else before the wallet opens', () => {
  const plan = publicBulkPaymentPlan(ORDER, status(), 'mainnet');
  assert.equal(plan.items.length, 2); assert.equal(plan.extraOutputs.length, 2);
  assert.throws(() => publicBulkPaymentPlan(ORDER, status({ mintFundingSatoshis: '9999' }), 'mainnet'), /does not add up/);
  assert.throws(() => publicBulkPaymentPlan(ORDER, status({ extraOutputs: [] }), 'mainnet'), /set-aside is not valid/);
  assert.throws(() => publicBulkPaymentPlan(ORDER, status({ redeem: { items: [] } }), 'mainnet'), /fee items are not valid/);
  assert.throws(() => publicBulkPaymentPlan(ORDER, { ...status(), requesterRequired: true }, 'mainnet'), /mismatch/);
  assert.throws(() => publicBulkPaymentPlan(ORDER, status({ bitcoinNetwork: 'regtest' }), 'mainnet'), /network mismatch/);
});

function setup({ tap }) {
  const calls = [], reports = [], records = new Map();
  const provider = { getCapabilities: async () => ({ version: '1.0.60', singleTxTransferExtraOutputs: true }), requestAccounts: async () => [PAYER], getAccounts: async () => [PAYER],
    getNetwork: async () => 'mainnet', getPublicKey: async () => PUB, getCurrentAuthority: async () => ({ ins: 'ab'.repeat(32) + 'i0', auth: [], addr: PAYER }), getAuthorityStatus: async () => ({}),
    getBitcoinUtxos: async () => [{ txid: 'cd'.repeat(32), vout: 0, satoshi: 200000, height: 899000, inscriptions: [] }],
    singleTxTransfer: async (items, options) => { calls.push({ items, options }); return { inscriptionId: 'b4'.repeat(32) + 'i0' }; } };
  const reply = value => ({ ok: true, json: async () => value, text: async () => String(value) });
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.host === 'reader.tapscope.io') return reply(u.pathname.startsWith('/getAccountTokensBalance/') ? { data: { list: [{ ticker: 'tap', overallBalance: T(tap), transferableBalance: '' }], total: 1 } }
      : u.pathname.startsWith('/getDeployment/') ? { result: { tick: 'tap', dec: 18 } } : { result: '0' });
    if (u.pathname.endsWith('/fees/recommended')) return reply({ fastestFee: 4, halfHourFee: 3, hourFee: 2 });
    if (u.pathname.endsWith('/utxo')) return reply([{ txid: 'cd'.repeat(32), vout: 0 }]);
    return reply([]);
  };
  const journal = { get: async k => records.get(k), put: async (k, v) => { records.set(k, v); }, lock: async (k, fn) => fn() };
  const wallet = new TapWalletPublicBulkMint({ provider, network: 'mainnet', journal, fetchImpl, readTip: async () => '900000',
    readStatus: async () => status(), reportPayment: async (id, paymentId) => { reports.push({ id, paymentId }); } });
  return { wallet, calls, reports, records };
}

test('too little TAP is refused with the amounts before TAP Wallet opens; enough pays once and reports the redeem inscription', async () => {
  const short = setup({ tap: '5' });
  await short.wallet.connect();
  await assert.rejects(short.wallet.pay(ORDER), /Not enough TAP: this payment needs 6 TAP, your wallet can spend 5 TAP/);
  assert.equal(short.calls.length, 0);
  const ok = setup({ tap: '50' });
  await ok.wallet.connect();
  const result = await ok.wallet.pay(ORDER);
  assert.equal(result.localState, 'payment_submitted');
  assert.equal(ok.calls.length, 1); assert.equal(ok.calls[0].items.length, 2); assert.equal(ok.calls[0].options.extraOutputs.length, 2);
  assert.deepEqual(ok.reports, [{ id: ORDER, paymentId: 'b4'.repeat(32) + 'i0' }]);
  // Pressing Pay again never sends a second payment: the saved receipt is reported instead.
  await ok.wallet.pay(ORDER);
  assert.equal(ok.calls.length, 1);
});
