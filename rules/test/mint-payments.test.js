import test from 'node:test';
import { Address, NETWORK, TEST_NETWORK, OutScript } from '@scure/btc-signer';
import assert from 'node:assert/strict';
import {mintFeeItems,walletFeeItems,paymentProgress,paymentItemKey,splitFee,TAP_BURN,tapBurnAddress,tapPaymentLock} from '../src/index.js';
test('payer discount retains full split and uses exact TAP burn address',()=>{
 const split=splitFee('100',{linked:true,discovered:true});
 const fees=mintFeeItems(split,{finder:'payer',landowner:'l',discoverer:'d',treasury:'t'},null,'payer');
 assert.equal(fees.reduce((n,f)=>n+BigInt(f.amount),0n),70n);assert.equal(split.finder,'30');assert.equal(split.treasury,'30');
 assert.deepEqual(fees.at(-1),{role:'burn',to:TAP_BURN,ticker:'tap',amount:'20',tt:'a'});assert.equal(walletFeeItems(fees).at(-1).address,TAP_BURN);
 assert.deepEqual(mintFeeItems(split,{finder:'payer',landowner:'l',discoverer:'d',treasury:'t'},null,'payer','ethereum').at(-1),{role:'burn',to:null,ticker:'tap',amount:'20',tt:'b'});
});
test('final partial items accumulate exact amounts; duplicates, used credit and wrong destinations cannot complete',()=>{
 const fee={role:'treasury',to:'t',ticker:'tap',tt:'a',amount:'9007199254740993'};
 const receipt=(i,amount,extra={})=>({...fee,key:paymentItemKey('tap',i),amount,confirmations:6,accepted:true,...extra});
 const rows=[receipt('one','9007199254740992'),receipt('two','1')];
 assert.equal(paymentProgress([fee],rows).final,true);assert.equal(paymentProgress([fee],rows.slice(0,1)).missing[0].amount,'1');
 assert.throws(()=>paymentProgress([fee],[rows[0],rows[0]]),/payment_duplicate/);
 assert.equal(paymentProgress([fee],[rows[0],{...rows[1],used:'1'}]).final,false);
 assert.equal(paymentProgress([fee],[rows[0],{...rows[1],to:'other'}]).final,false);
 assert.equal(paymentProgress([fee],[receipt('mempool',fee.amount,{confirmations:0})]).seen,true);
});

test('every Bitcoin network burns to the same P2PKH script and rejects another network encoding', () => {
 const main = Address(NETWORK).decode(TAP_BURN);
 assert.equal(main.type, 'pkh');
 assert.equal(tapBurnAddress('mainnet'), '1BitcoinEaterAddressDontSendf59kuE');
 for (const network of ['mainnet', 'regtest', 'testnet', 'signet']) {
  const burn = tapBurnAddress(network), decoded = Address(network === 'mainnet' ? NETWORK : TEST_NETWORK).decode(burn);
  assert.deepEqual(decoded.hash, main.hash);
  assert.deepEqual(OutScript.encode(decoded), OutScript.encode(main));
  const split = splitFee('100'), destinations = { finder: 'f', treasury: 't' };
  const fees = mintFeeItems(split, destinations, 'ab'.repeat(32), null, 'tap', network);
  assert.equal(fees.at(-1).to, burn);
  assert.equal(walletFeeItems(fees, network).at(-1).address, burn);
  assert.equal(tapPaymentLock({ split, destinations, payer: 'p', hash: 'ab'.repeat(32), expiry: 100, bitcoinNetwork: network }).al.at(-1).to, burn);
  const wrong = tapBurnAddress(network === 'mainnet' ? 'regtest' : 'mainnet');
  assert.throws(() => walletFeeItems(fees.map(f => f.role === 'burn' ? { ...f, to: wrong } : f), network), /tap_payment_item/);
  assert.equal(paymentProgress(fees, fees.map((f, i) => ({ ...f, to: f.role === 'burn' ? wrong : f.to, key: paymentItemKey('tap', String(i)), accepted: true, confirmations: 1 }))).final, false);
 }
 assert.throws(() => tapBurnAddress('unknown'), /tap_burn_network/);
});
