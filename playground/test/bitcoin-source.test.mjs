import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { regtestBitcoinSource } from '../bitcoin-source.mjs';
import { fundingAddress } from '../../kit/lib/inscription-core.mjs';
const require=createRequire(new URL('../../kit/package.json',import.meta.url)),btc=require('@scure/btc-signer');
const { secp256k1 }=require('@noble/curves/secp256k1');
const txid='ab'.repeat(32), key=Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(1))).toString('hex');
const address=fundingAddress(key,'regtest');
const manifest={bitcoin:{network:'regtest'}};

test('local signer selects only explicit confirmed outputs and verifies their scripts',async()=>{
  const {networkFor}=await import('../../kit/lib/inscription-core.mjs');
  const script=Buffer.from(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(address))).toString('hex');
  let output={confirmations:1,value:0.01,scriptPubKey:{hex:script}};
  const source=regtestBitcoinSource({manifest,funding:[{txid,vout:0}],rpc:async(method,args)=>{assert.equal(method,'gettxout');assert.equal(args[0],txid);return output;}});
  assert.equal((await source.utxos(address))[0].value,'1000000');
  output={...output,confirmations:0};assert.deepEqual(await source.utxos(address),[]);
  output={...output,confirmations:1,scriptPubKey:{hex:'0014'+'00'.repeat(20)}};await assert.rejects(source.utxos(address),/does not belong/);
  output=null;assert.deepEqual(await source.utxos(address),[]);
  assert.throws(()=>source.addFunding([{txid,vout:0}]),/saved cardinal/);
});

test('local broadcasts keep a known transaction and do not hide RPC outages',async()=>{
  const calls=[];let known=false;
  const source=regtestBitcoinSource({manifest,rpc:async(method)=>{calls.push(method);if(method==='getrawtransaction'&&!known)throw Object.assign(Error('absent'),{rpcCode:-5});known=true;return txid;}});
  assert.equal(await source.broadcast('00',txid),txid);assert.equal(await source.broadcast('00',txid),txid);
  assert.equal(calls.filter(m=>m==='sendrawtransaction').length,1);
  const broken=regtestBitcoinSource({manifest,rpc:async()=>{throw Error('offline')}});await assert.rejects(broken.hasTransaction(txid),/offline/);
  assert.throws(()=>regtestBitcoinSource({manifest:{bitcoin:{network:'mainnet'}}}),/regtest/);
});
