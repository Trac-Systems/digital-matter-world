import test from 'node:test';
import assert from 'node:assert/strict';
import { requestKey, fundingAmount, fundingQuote, btc, validDestination } from '../src/mint-sender-keys.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { buildInscription, signCommit, hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
const seed = new Uint8Array(32).fill(7), id = 'ab'.repeat(32), settings = mintSenderSettings();
test('request derivation is deterministic, network-separated, and preserves high id bits', () => {
  const a = requestKey(seed, id, 'mainnet'), b = requestKey(seed, id, 'mainnet');
  assert.equal(a.address, b.address); assert.match(a.address, /^bc1p/);
  assert.notEqual(a.address, requestKey(seed, '2b' + id.slice(2), 'mainnet').address);
  assert.notEqual(a.address, requestKey(seed, id, 'regtest').address);
  assert.notDeepEqual(a.privateKey, requestKey(seed, id, 'mainnet', 1).privateKey);
  assert.throws(() => requestKey(seed, '../bad', 'mainnet'));
});
test('funding calculation uses shared builder, margin, postage, and operator cap', () => {
  assert.equal(fundingAmount(settings), 6388);
  assert.ok(fundingAmount({ ...settings, feeMargin: 3 }) > fundingAmount(settings));
  assert.ok(fundingAmount({ ...settings, contentBytes: 6000 }) > fundingAmount(settings));
  assert.throws(() => fundingAmount({ ...settings, maxFundingSats: 600 }), /funding_cap/);
  assert.equal(fundingQuote(seed, id, 'mainnet', settings).label, 'your mint inscription');
  assert.throws(() => mintSenderSettings({ feeMargin: 0 }));
  assert.throws(() => mintSenderSettings({ enabled: true }));
});
test('explicit server options spend unconfirmed set-aside and send only payer change and receiver postage', () => {
  const signer = requestKey(seed, id, 'regtest'), payer = requestKey(seed, 'cd'.repeat(32), 'regtest'), receiver = requestKey(seed, 'ef'.repeat(32), 'regtest');
  const coin = { txid: '11'.repeat(32), vout: 2, value: '10000', script: hex(btc.p2tr(unhex(signer.publicKey).slice(1)).script), cardinal: true, confirmed: false };
  const input = { text: 'permit', receiver: receiver.address, publicKey: signer.publicKey, network: 'regtest', utxos: [coin], feeRate: 2, maxFeeSats: '9000' };
  assert.throws(() => buildInscription(input), /confirmed cardinal/);
  const plan = signCommit(buildInscription({ ...input, changeAddress: payer.address, allowUnconfirmed: true, allowNoChange: true }), signer.privateKey);
  const tx = btc.Transaction.fromRaw(unhex(plan.commitHex));
  assert.equal(hex(tx.getOutput(1).script), hex(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(payer.address))));
  const reveal = btc.Transaction.fromRaw(unhex(plan.revealHex), { allowUnknownInputs: true });
  assert.equal(reveal.getOutput(0).amount, 546n);
  assert.equal(validDestination(receiver.address, 'regtest'), true);
  assert.equal(validDestination(receiver.address, 'mainnet'), false);
});

test('standard legacy payer/receiver addresses remain eligible while funding itself stays P2TR', () => {
  const key = requestKey(seed, id, 'mainnet'), publicKey = unhex(key.publicKey);
  for (const address of [btc.p2pkh(publicKey).address, btc.p2sh(btc.p2wpkh(publicKey)).address]) {
    assert.equal(validDestination(address, 'mainnet'), true);
    assert.equal(validDestination(address, 'regtest'), false);
  }
  assert.match(fundingQuote(seed, id, 'mainnet', settings).address, /^bc1p/);
});

test('refund reserve is operator-configured and returned in a winning mint commit', async () => {
  const { refundFloatKey } = await import('../src/mint-sender-keys.mjs');
  const enabled = mintSenderSettings({ refundsEnabled: true });
  assert.equal(enabled.refundReserveSats, 3000);
  assert.equal(fundingAmount(enabled) - fundingAmount(settings), enabled.refundReserveSats);
  assert.throws(() => fundingAmount({ ...enabled, refundReserveSats: 1 }), /refund_reserve/);
  const float = refundFloatKey(seed, 'regtest'), signer = requestKey(seed, id, 'regtest');
  assert.notEqual(float.address, signer.address); assert.match(float.path, /\/2\/0$/);
  const coin = { txid: '11'.repeat(32), vout: 0, value: String(fundingAmount(enabled)), script: hex(btc.p2tr(unhex(signer.publicKey).slice(1)).script), cardinal: true, confirmed: true };
  const plan = signCommit(buildInscription({ text: 'mint', receiver: signer.address, changeAddress: signer.address, publicKey: signer.publicKey, network: 'regtest', utxos: [coin], feeRate: 2, maxFeeSats: '90000' }), signer.privateKey);
  const tx = btc.Transaction.fromRaw(unhex(plan.commitHex));
  assert.equal(tx.outputsLength, 2); assert.ok(tx.getOutput(1).amount >= BigInt(enabled.refundReserveSats));
  assert.equal(tx.getOutput(1).amount, BigInt(coin.value) - BigInt(plan.postage) - BigInt(plan.feeSats));
});
