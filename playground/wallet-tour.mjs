#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA,origin,save,sleep } from './common.mjs';
import { bitcoin,rpc } from '../local/common.mjs';
const token=(await readFile(join(DATA,'control.token'),'utf8')).trim();
const m=JSON.parse(await readFile(join(DATA,'manifest.json'))),stack=JSON.parse(await readFile(join(m.directory,'stack/manifest.json')));
const file=join(DATA,'wallet-tour.json');let evidence={state:'running'};
async function api(path,body){const r=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const b=await r.json();assert.ok(r.ok,JSON.stringify(b));return b;}
async function job(path,body={}){const j=await api(path,body),end=Date.now()+300000;while(Date.now()<end){const r=await api('jobs/'+j.id);if(r.state==='complete')return r.result;if(r.state==='failed')throw Error(r.error);await sleep(250);}throw Error('wallet job timeout');}
try{
  assert.equal(await rpc(stack.ethereum.rpc,'eth_chainId'),'0x7a69');
  await job('mining',{enabled:false});await job('bots',{paused:true});
  const btc=await bitcoin(stack,'getnewaddress',['','bech32m'],'faucet'),eth=stack.ethereum.accounts[4];
  const funded=await job('wallets/fund',{bitcoin:btc,ethereum:eth});assert.equal(funded.state,'complete');
  const tap=(await(await fetch(stack.ord.url+'/r/tap/getBalance/'+btc+'/tap')).json()).result;
  assert.equal(String(tap),'10000');
  const again=await job('wallets/fund',{bitcoin:btc,ethereum:eth});assert.equal(again.btcTx,funded.btcTx);
  evidence.funding={bitcoin:btc,ethereum:eth,tap:String(tap),btcTx:funded.btcTx};await save(file,evidence);
  const right=(await api('player/mintRights?asset=p0&allowed=true&limit=1')).mintRights[0];assert.ok(right);
  const request=await job('player/mint',{actionId:'external-eth-'+Date.now().toString(36),asset:right.asset,block:right.block,amount:right.amount,kind:'ethereum',payer:eth});
  assert.ok(request.request?.id,'Deploy p0 through the console mint flow before running the wallet tour');evidence.request=request.request.id;await save(file,evidence);
  await assert.rejects(job('player/pay',{id:evidence.request}),/external_payer_use_payment_submission/);
  const plan=await api('payment-plan/'+evidence.request);assert.equal(plan.payer.toLowerCase(),eth.toLowerCase());
  for(const tx of plan.transactions){const hash=await rpc(stack.ethereum.rpc,'eth_sendTransaction',[{...tx,gas:'0x7a1200'}]);const receipt=await rpc(stack.ethereum.rpc,'eth_getTransactionReceipt',[hash]);assert.equal(receipt.status,'0x1');}
  await job('player/payment',{id:evidence.request,paymentId:evidence.request});
  let row,release;
  for(let i=0;i<30;i++){
    row=await api('gateway/mint/'+evidence.request);
    if(row.state==='permit_issued')break;
    if(row.ethereumRelease&&!release){const r=row.ethereumRelease;release=await rpc(stack.ethereum.rpc,'eth_sendTransaction',[{from:eth,to:r.to,data:r.data,gas:'0x7a1200'}]);const receipt=await rpc(stack.ethereum.rpc,'eth_getTransactionReceipt',[release]);assert.equal(receipt.status,'0x1');}
    await job('mine',{count:1});await sleep(150);
  }
  assert.equal(row.state,'permit_issued');assert.ok(row.mintContent);
  evidence={...evidence,state:'permit_issued',release,receiver:row.receiver,mintContent:row.mintContent};await save(file,evidence);console.log('PASS: external wallet funding, payer isolation, escrow payment and permanent mint permit. The receiver wallet can now inscribe mintContent and report the inscription ID.');
}catch(error){await save(file,{...evidence,state:'failed',error:error.message});console.error(error.message);process.exitCode=1;}
