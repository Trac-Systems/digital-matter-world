import test from 'node:test';
import assert from 'node:assert/strict';
import { MintRefundTap } from '../src/mint-refund-source.mjs';
import { MintSenderBitcoin } from '../src/mint-sender-source.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { hash } from '../src/util.mjs';
import { requestKey, btc } from '../src/mint-sender-keys.mjs';
import { hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
const settings = mintSenderSettings({ refundsEnabled: true });
function fixture() {
  const text = JSON.stringify({ p: 'tap', op: 'token-auth', redeem: { items: [] } });
  const id = '11'.repeat(32) + 'i0', address = 'float-address', payer = 'payer-address';
  const authority = { plan: { inscriptionId: id, revealTxid: id.slice(0, 64), textHash: hash(text) }, payload: { auth: ['tap'] } };
  const item = { tick: 'tap', address: payer, amt: '1.5', dta: 'refund-data' };
  const row = { plan: authority.plan, payload: { redeem: { items: [item] } }, amounts: { tap: '1500000000000000000' } };
  const transfers = [{ ins: id, tick: 'tap', addr: address, taddr: payer, dta: item.dta, amt: row.amounts.tap, fail: false, int: true, blck: 100 }];
  let blockHash = '22'.repeat(32), height = '100', cancelled = false, confirmed = true, content = text, balance = row.amounts.tap;
  const output = { indexed: true, spent: false, value: 10000, inscriptions: [], runes: {} };
  const reads = [], http = { async request(path) {
    reads.push(path);
    if (path === '/r/tap/getCurrentBlock') return { result: height };
    if (path.startsWith('/r/blockhash/')) return blockHash;
    if (path.startsWith('/content/')) return content;
    if (path.startsWith('/output/')) return output;
    if (path.startsWith('/r/tap/getAccountRedeemListLength/')) return { result: 0 };
    if (path.startsWith('/r/tap/getBalance/')) return { result: balance };
    if (path.startsWith('/r/tap/getAccountAuthList/')) return { result: [{ ins: id, addr: address, auth: ['tap'] }] };
    if (path.startsWith('/r/tap/getAuthCancelled/')) return { result: cancelled };
    if (path.startsWith('/r/tap/getTransferredList/')) return { result: transfers };
    throw Error('unexpected path');
  } };
  const bitcoin = { http: { async request() { return '22'.repeat(32); } }, async transaction() { return { confirmed, height: 100 }; } };
  return { http, source: new MintRefundTap({ http, bitcoin, settings }), row, authority, address, transfers, output, reads, bitcoin,
    fork: () => { blockHash = '33'.repeat(32); }, height: n => { height = n; }, cancel: () => { cancelled = true; }, unconfirm: () => { confirmed = false; }, content: s => { content = s; }, balance: n => { balance = n; } };
}
test('float reads atomic TAP balance, confirms the exact authority content and observes cancellation', async () => {
  const f = fixture(), result = await f.source.float(f.address, f.authority);
  assert.equal(result.value.balances.tap, '1500000000000000000'); assert.equal(result.value.authority.state, 'active');
  f.cancel(); assert.equal((await f.source.float(f.address, f.authority)).value.authority.state, 'cancelled');
  f.balance('1.5'); await assert.rejects(f.source.float(f.address, f.authority), /tap_balance/);
});
test('refund confirmation requires Bitcoin plus every exact successful indexed TAP transfer', async () => {
  const f = fixture(); assert.equal((await f.source.confirmed(f.row, f.address)).txid, f.row.plan.revealTxid);
  for (const [key, value] of [['fail', true], ['int', false], ['addr', 'treasury'], ['taddr', 'wrong-payer'], ['amt', '1'], ['dta', 'another-refund'], ['blck', 99]]) {
    const old = f.transfers[0][key]; f.transfers[0][key] = value;
    await assert.rejects(f.source.confirmed(f.row, f.address), /transfer_binding/); f.transfers[0][key] = old;
  }
  f.unconfirm(); assert.equal(await f.source.confirmed(f.row, f.address), null);
});
test('an unindexed redeem, lagging index, fork, changed content or partial transfers never mark paid', async () => {
  let f = fixture(); f.transfers.length = 0; assert.equal(await f.source.confirmed(f.row, f.address), null);
  f = fixture(); f.height('99'); assert.equal(await f.source.confirmed(f.row, f.address), null);
  f = fixture(); f.fork(); await assert.rejects(f.source.confirmed(f.row, f.address), /tap_canonical/);
  f = fixture(); f.content('{}'); await assert.rejects(f.source.confirmed(f.row, f.address), /redeem_content/);
  f = fixture(); f.row.payload.redeem.items.push({ tick: 'another' }); await assert.rejects(f.source.confirmed(f.row, f.address), /transfer_count/);
});
test('authority creation accepts only confirmed, indexed, unspent, asset-free float BTC', async () => {
  const f = fixture(), coin = { txid: '11'.repeat(32), vout: 1, value: '10000', confirmed: true };
  assert.deepEqual(await f.source.cardinal([coin, { ...coin, confirmed: false }]), [coin]);
  f.output.inscriptions.push('33'.repeat(32) + 'i0'); assert.deepEqual(await f.source.cardinal([coin]), []);
  f.output.inscriptions.length = 0; f.output.runes = { token: 1 }; assert.deepEqual(await f.source.cardinal([coin]), []);
  delete f.output.runes; await assert.rejects(f.source.cardinal([coin]), /float_coin_unknown/);
});
test('funding is tied to the accepted payment parent, excluding another payment for the same request', async () => {
  const key = requestKey(new Uint8Array(32).fill(47), 'ab'.repeat(32), 'regtest'), script = btc.p2tr(unhex(key.publicKey).slice(1)).script;
  const parent = '11'.repeat(32), payment = new btc.Transaction();
  payment.addInput({ txid: parent, index: 0, witnessUtxo: { script, amount: 10000n }, tapInternalKey: unhex(key.publicKey).slice(1) });
  payment.addOutputAddress(key.address, 9000n, networkFor('regtest')); payment.sign(key.privateKey); payment.finalize();
  const source = new MintSenderBitcoin({ settings, network: 'regtest', http: { async request(path) { assert.equal(path, '/tx/' + payment.id + '/hex'); return payment.hex; } } });
  const coin = { txid: parent, vout: 1, value: '10000' }, other = { ...coin, txid: '22'.repeat(32) };
  source.utxos = async () => [coin, other];
  assert.deepEqual(await source.paymentFunding(key.address, payment.id + 'i0'), [coin]); key.privateKey.fill(0);
});

test('a third-party relay of the exact signed redeem is recognized using a bounded account read', async () => {
  const f = fixture(), copy = '77'.repeat(32) + 'i0';
  Object.assign(f.row.payload, { p: 'tap', op: 'token-auth', hash: '44'.repeat(32), salt: 'fixture', sig: { v: '0', r: '1', s: '2' } });
  f.content(JSON.stringify(f.row.payload)); f.transfers[0].ins = copy;
  f.bitcoin.transaction = async id => ({ confirmed: id === copy.slice(0, 64), height: 100 });
  const request = f.http.request;
  f.http.request = async path => {
    if (path.includes('getAccountRedeemListLength/')) return { result: 200 };
    if (path.includes('getAccountRedeemList/')) {
      assert.ok(path.endsWith('?offset=150&max=50'));
      return { result: [{ ins: copy, addr: f.address, hash: f.row.payload.hash, slt: f.row.payload.salt, sig: f.row.payload.sig }] };
    }
    return request(path);
  };
  assert.equal((await f.source.confirmed(f.row, f.address)).inscriptionId, copy);
  f.row.payload.sig.r = '3';
  await assert.rejects(f.source.confirmed(f.row, f.address), /redeem_content/);
});
