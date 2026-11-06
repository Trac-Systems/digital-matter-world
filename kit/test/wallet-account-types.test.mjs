import test from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { buildInscription, walletPayer, networkFor, acceptSignedCommit } from '../lib/inscription-core.mjs';

const hex = b => Buffer.from(b).toString('hex');
// A TAP Wallet account of every type funds the mint commit from its own coins.
for (const type of ['tr', 'wpkh', 'sh', 'pkh']) test(`mint commit from a ${type} TAP Wallet account signs and finalizes`, () => {
  const key = secp256k1.utils.randomPrivateKey(), pub = secp256k1.getPublicKey(key), net = networkFor('regtest');
  const address = type === 'tr' ? btc.p2tr(pub.slice(1), undefined, net).address : type === 'wpkh' ? btc.p2wpkh(pub, net).address
    : type === 'sh' ? btc.p2sh(btc.p2wpkh(pub, net), net).address : btc.p2pkh(pub, net).address;
  const payer = walletPayer(hex(pub), address, 'regtest');
  assert.equal(payer.type, type); assert.equal(payer.address, address);
  // A previous transaction paying the account, for the legacy input's nonWitnessUtxo.
  const prev = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  prev.addOutput({ script: payer.script, amount: 200000n });
  prev.addInput({ txid: '11'.repeat(32), index: 0, finalScriptSig: new Uint8Array([0]) });
  const utxo = { txid: prev.id, vout: 0, value: '200000', script: hex(payer.script), confirmed: true, cardinal: true, ...(type === 'pkh' ? { rawTx: prev.hex } : {}) };
  const plan = buildInscription({ text: '{"p":"tap"}', receiver: address, publicKey: hex(pub), payerAddress: address, network: 'regtest', utxos: [utxo], feeRate: 2, maxFeeSats: '100000' });
  assert.equal(plan.payer, address);
  const commit = btc.Transaction.fromPSBT(Buffer.from(plan.commitPsbt, 'hex'));
  commit.sign(key); commit.finalize();
  if (type === 'pkh') assert.ok(plan.revealAfterCommitSignature && !plan.revealHex, 'a legacy reveal waits for the commit signature');
  else assert.equal(commit.id, plan.commitTxid, 'signatures do not change the planned commit');
  assert.ok(commit.fee >= BigInt(Math.ceil(commit.vsize * 2)), `fee covers the real ${type} input size`);
  const accepted = acceptSignedCommit(plan, hex(commit.toPSBT(0)));
  assert.equal(accepted.commitTxid, commit.id);
  const reveal = btc.Transaction.fromRaw(Buffer.from(accepted.revealHex, 'hex'), { allowUnknownInputs: true });
  assert.equal(hex(reveal.getInput(0).txid), commit.id, 'the reveal spends the real signed commit');
  if (type === 'pkh') assert.throws(() => acceptSignedCommit(JSON.parse(JSON.stringify(plan)), hex(commit.toPSBT(0))), /Rebuild this inscription/);
});
test('a wallet account that the key does not own is refused', () => {
  const pub = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey()), other = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey()), net = networkFor('regtest');
  for (const address of [btc.p2wpkh(other, net).address, btc.p2pkh(other, net).address, btc.p2sh(btc.p2wpkh(other, net), net).address])
    assert.throws(() => walletPayer(hex(pub), address, 'regtest'), /matches its public key/);
});
