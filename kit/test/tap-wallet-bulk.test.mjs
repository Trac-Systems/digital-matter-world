import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import fixture from '../../rules/test/fixtures/bulk-v1.json' with { type: 'json' };
import { hashObject, stableJSON } from '../../rules/src/core.js';
import { bulkOrderId, bulkMembersRoot, bulkFeeRoot } from '../../rules/src/bulk-mint.js';
import { TapWalletBulkMint } from '../lib/tap-wallet-bulk-mint.mjs';
import { fundingAddress, hex } from '../lib/inscription-core.mjs';
import { tapWallet1049 } from './tap-wallet-1049-fixture.mjs';
import { walletFundsFetch, walletFundsReply, cardinalFixture } from './wallet-funds-fixture.mjs';

function setup({ active = true } = {}) {
  const publicKey = hex(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true)), address = fundingAddress(publicKey, 'mainnet');
  const f = tapWallet1049({ address, publicKey, active }), records = new Map(), reports = [];
  f.provider.getBitcoinUtxos = async () => [cardinalFixture()];
  const terms = { ...structuredClone(fixture.terms), payer: address }, feeManifest = structuredClone(fixture.feeManifest);
  const id = bulkOrderId(terms.network, terms.owner, terms.nonce);
  const status = { v: 1, orderId: id, termsHash: hashObject(terms), state: 'awaiting_payment', payable: true,
    ...Object.fromEntries(['payer', 'receiver', 'asset', 'deployment', 'ticker', 'totalAmount', 'grossFeeAtoms', 'payableFeeAtoms'].map(k => [k, terms[k]])),
    count: terms.members.length, payBy: { rail: 'tap', untilBlock: terms.expires }, payment: { reference: null, state: 'unseen' } };
  const journal = { get: async k => structuredClone(records.get(k)), put: async (k, v) => records.set(k, structuredClone(v)), lock: async (_, fn) => fn() };
  const options = { provider: f.provider, journal, network: 'mainnet', readStatus: async () => structuredClone(status),
    readTerms: async () => ({ v: 1, orderId: id, terms: structuredClone(terms), feeManifest: structuredClone(feeManifest) }),
    reportPayment: async value => reports.push(value), readTip: async () => '900000', fetchImpl: walletFundsFetch };
  const wallet = new TapWalletBulkMint(options);
  return { ...f, records, reports, terms, feeManifest, id, status, options, wallet };
}

test('bulk pays exactly once with one extra output, exact decimal TAP, payer different from receiver and no invented redeem i0', async () => {
  const f = setup(); await f.wallet.connect();
  assert.notEqual(f.terms.receiver, f.state.address);
  const result = await f.wallet.pay(f.id);
  const [method, items, extra] = f.state.calls[0];
  assert.equal(method, 'singleTxTransfer'); assert.equal(f.state.calls.length, 1);
  assert.deepEqual(items, [{ address: f.terms.groups[0].to, tick: 'tap', amt: '0.0000000000000001', dta: `dmw-bulk-pay-v1|${f.id}|0` }]);
  assert.deepEqual(extra, { extraOutputs: [{ address: f.terms.mintFunding.address, satoshis: f.terms.mintFunding.satoshis, label: 'your bulk mint inscriptions' }] });
  assert.equal(result.commitTxid, f.funding); assert.equal(result.paymentId, null); assert.equal(result.revealTxid, null);
  assert.deepEqual(f.reports[0], { orderId: f.id, paymentId: null, commitTxid: f.funding, revealTxid: null });
  const resumed = new TapWalletBulkMint(f.options); await resumed.connect(); await resumed.pay(f.id);
  assert.equal(f.state.calls.length, 1); assert.equal(f.reports.length, 2, 'reload can redeliver the saved receipt');
});

test('bulk authority and extra-output capability are prerequisites and never create an authority', async () => {
  const f = setup({ active: false }); await f.wallet.connect();
  await assert.rejects(f.wallet.pay(f.id), /Turn on 1-TX Transfers/); assert.equal(f.records.size, 0); assert.equal(f.state.calls.length, 0);
  f.provider.getCapabilities = async () => ({ version: '1.0.49' });
  await assert.rejects(f.wallet.pay(f.id), /set-aside/); assert.equal(f.records.size, 0);
});

test('bulk rejects changed terms, connected wallet and network before saving an attempt', async () => {
  for (const change of [f => { f.terms.nonce = 'f'.repeat(64); }, f => { f.state.network = 'regtest'; },
    f => { f.state.address = f.terms.receiver; }, f => { f.status.payer = f.terms.receiver; }, f => { f.status.termsHash = 'f'.repeat(64); }]) {
    const f = setup(); await f.wallet.connect(); change(f);
    await assert.rejects(f.wallet.pay(f.id), /mismatch|changed/); assert.equal(f.records.size, 0); assert.equal(f.state.calls.length, 0);
  }
});

test('bulk rechecks immutable terms and payability after the authority check', async () => {
  for (const mutate of [f => { f.status.payable = false; }, f => { f.status.termsHash = 'e'.repeat(64); }]) {
    const f = setup(); await f.wallet.connect(); const read = f.provider.getCurrentAuthority;
    f.provider.getCurrentAuthority = async () => { mutate(f); return read(); };
    await assert.rejects(f.wallet.pay(f.id), /changed|mismatch/); assert.equal(f.records.size, 0); assert.equal(f.state.calls.length, 0);
  }
});

test('bulk ambiguous reply and cancellation keep sending across reload; TAP absence never triggers a retry', async () => {
  for (const error of [null, { code: 4001, message: 'User rejected the request.' }]) {
    const f = setup(); await f.wallet.connect(); let calls = 0;
    f.provider.singleTxTransfer = async () => { calls++; assert.equal(f.records.get(f.wallet.key(f.id)).payment.state, 'sending'); if (error) throw error; return {}; };
    if (error) await assert.rejects(f.wallet.pay(f.id), /no payment receipt/); else assert.equal((await f.wallet.pay(f.id)).localState, 'payment_pending');
    const resumed = new TapWalletBulkMint(f.options); await resumed.connect();
    await resumed.pay(f.id); assert.equal(calls, 1);
    resumed.fetchImpl = async () => Response.json({ chain_stats: { tx_count: 1 }, mempool_stats: { tx_count: 0 } });
    await assert.rejects(resumed.pay(f.id, { retry: true }), /already sent/); assert.equal(calls, 1);
    resumed.fetchImpl = async url => Response.json(walletFundsReply(url) ?? (url.includes('/txs/') ? [] : { chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 0 } }));
    if (error) await assert.rejects(resumed.pay(f.id, { retry: true }), /no payment receipt/);
    else await resumed.pay(f.id, { retry: true });
    assert.equal(calls, 2);
  }
});

test('bulk saves a receipt before reporting; a failed report can resume without a second wallet call', async () => {
  const f = setup(); await f.wallet.connect(); f.wallet.reportPayment = async () => { throw Error('offline'); };
  await assert.rejects(f.wallet.pay(f.id), /offline/);
  assert.equal(f.records.get(f.wallet.key(f.id)).payment.state, 'submitted');
  const resumed = new TapWalletBulkMint(f.options); await resumed.connect(); await resumed.pay(f.id);
  assert.equal(f.state.calls.length, 1); assert.equal(f.reports.length, 1);
});

test('bulk partial, paid, issued and unaccepted orders never offer another wallet payment', async () => {
  for (const state of ['partly_paid', 'paid', 'permit_pending', 'permit_issued', 'reserving', 'expired', 'needs_attention']) {
    const f = setup(); await f.wallet.connect(); f.status.state = state;
    await assert.rejects(f.wallet.pay(f.id), /not accepting/); assert.equal(f.state.calls.length, 0);
  }
});

test('bulk 64-member 131-group wallet plan stays one transfer, bypassing the legacy 32-item cap', async () => {
  const f = setup(), terms = f.terms;
  terms.members = Array.from({ length: 64 }, (_, i) => ({ block: String(900000 + i), amount: '3' }));
  terms.membersRoot = bulkMembersRoot(terms.members); terms.totalAmount = '192';
  terms.groups = Array.from({ length: 131 }, (_, i) => ({ to: fundingAddress(hex(secp256k1.getPublicKey(Uint8Array.from({ length: 32 }, () => i + 16), true)), 'mainnet'), ticker: 'tap', tt: 'a', amount: '1000000000000000001' })).sort((a, b) => a.to < b.to ? -1 : 1);
  f.feeManifest.length = 0; let group = 0;
  for (let i = 0; i < 64; i++) {
    const count = i < 3 ? 3 : 2, shares = ['finder', 'landowner', 'treasury'].slice(0, count).map(role => ({ role, group: group++, beneficiary: null, gross: '1000000000000000001', payable: '1000000000000000001' }));
    f.feeManifest.push({ member: i, grossFeeAtoms: String(1000000000000000001n * BigInt(count)), shares, deferred: { legacyDeploy: '0', deployer: '0' } });
  }
  terms.feeRoot = bulkFeeRoot(f.feeManifest); terms.grossFeeAtoms = terms.payableFeeAtoms = String(131n * 1000000000000000001n);
  terms.mintFunding.satoshis = 64 * 546 + 6546 + Number(terms.mintFunding.maxFeeSats);
  terms.feeQuote.scope = stableJSON(['mint-bulk-v1', terms.asset, terms.deployment, terms.membersRoot]);
  Object.assign(f.status, { termsHash: hashObject(terms), count: 64, totalAmount: terms.totalAmount, grossFeeAtoms: terms.grossFeeAtoms, payableFeeAtoms: terms.payableFeeAtoms });
  await f.wallet.connect(); await f.wallet.pay(f.id);
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.calls[0][1].length, 131);
  assert.equal(f.state.calls[0][1][130].amt, '1.000000000000000001');
  assert.equal(f.state.calls[0][1][130].dta, `dmw-bulk-pay-v1|${f.id}|130`);
});

test('bulk rechecks the wallet after durable journaling and refuses a switch before the transfer', async () => {
  const f = setup(); await f.wallet.connect(); const put = f.options.journal.put;
  f.options.journal.put = async (key, value) => { await put(key, value); f.state.address = f.terms.receiver; };
  await assert.rejects(f.wallet.pay(f.id), /changed/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.records.get(f.wallet.key(f.id)).payment.state, 'sending');
});

test('bulk refuses oversized member/group sets before a wallet call', async () => {
  for (const mutate of [f => { f.terms.members = Array.from({ length: 65 }, (_, i) => ({ block: String(900000 + i), amount: '3' })); },
    f => { f.terms.groups = Array.from({ length: 132 }, () => structuredClone(f.terms.groups[0])); }]) {
    const f = setup(); await f.wallet.connect(); mutate(f); f.status.termsHash = hashObject(f.terms);
    await assert.rejects(f.wallet.pay(f.id), /bulk_members|bulk_groups/); assert.equal(f.state.calls.length, 0);
  }
});

test('bulk refuses before opening the wallet when TAP or Bitcoin is short', async () => {
  for (const [funds, coins, message] of [[{ overall: '1' }, [cardinalFixture()], /Not enough TAP/], [{}, [cardinalFixture(2000)], /Not enough Bitcoin/]]) {
    const f = setup(); await f.wallet.connect(); let opened = false;
    f.provider.getBitcoinUtxos = async () => coins;
    const transfer = f.provider.singleTxTransfer; f.provider.singleTxTransfer = async (...args) => { opened = true; return transfer(...args); };
    f.wallet.fetchImpl = async url => ({ ok: true, json: async () => walletFundsReply(url, funds) });
    await assert.rejects(f.wallet.pay(f.id), message); assert.equal(opened, false);
  }
});

test('bulk refuses fewer than two blocks including tip changes during funds checks', async () => {
  for (const late of [false, true]) {
    const f = setup(); let reads = 0;
    f.wallet.readTip = async () => String(BigInt(f.terms.expires) - (late && reads++ === 0 ? 2n : 1n));
    await f.wallet.connect();
    await assert.rejects(f.wallet.pay(f.id), e => e.code === 'payment_window_short' && /fresh mint request/.test(e.message));
    assert.equal(f.records.size, 0); assert.equal(f.state.calls.length, 0);
  }
});
