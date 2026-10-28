#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, origin, save, sleep } from './common.mjs';
import { parseTapAmount, formatTapAmount } from '../rules/src/index.js';
import { patternName } from '../kit/lib/pattern-names.mjs';
const previous=process.argv.includes('--resume')?JSON.parse(await readFile(join(DATA,'tour.json'),'utf8')):null;
const token=(await readFile(join(DATA,'control.token'),'utf8')).trim(),steps=previous?.steps??[];
const tag=previous?.tag??Date.now().toString(36),artifacts=previous?.artifacts??{};
const checkpoint=()=>save(join(DATA,'tour.json'),{state:'running',tag,steps,artifacts});
async function request(path,body) {
  const r=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const b=await r.json();assert.ok(r.ok,JSON.stringify(b));return b;
}
async function firstMatch(path,key,predicate=()=>true) {
  const url=new URL(path,origin+'/api/');url.searchParams.set('limit','200');
  for(;;){const page=await request(url.pathname.slice(5)+url.search),row=page[key].find(predicate);if(row||!page.next)return row;url.searchParams.set('cursor',page.next);}
}
async function job(path,args={}) {
  const start=await request(path,args),until=Date.now()+1800000;
  while(Date.now()<until){const j=await request('jobs/'+start.id);if(j.state==='complete')return j.result;if(j.state==='failed')throw Error(path+': '+j.error);await sleep(250);}throw Error('job timeout: '+path);
}
function requireRequest(result){assert.ok(result.request?.id,`Deploy ${result.asset??'this asset'} from the console mint flow, then resume this tour.`);}
async function step(name,fn){const old=steps.find(s=>s.name===name);if(old){console.log(name+': retained');return old.result;}const start=Date.now();const result=await fn();steps.push({name,ms:Date.now()-start,result});console.log(name+': '+JSON.stringify(result));await checkpoint();return result;}
try{
  const initial=await request('status');assert.equal(initial.state,'ready');
  await job('mining',{enabled:false});await job('bots',{paused:true});
  const owner=(await request('player')).address;
  await step('Funded kit player and all local components',async()=>{const p=await request('player');assert.ok(BigInt(p.wallets.bitcoin.tap)>0n);assert.ok(BigInt(p.wallets.ethereum.balance)>0n);assert.ok(initial.components.every(c=>c.state==='ready'));return {address:owner,tip:initial.tip,components:initial.components.length};});
  await step('Header, claims and real draw credits',async()=>{
    await job('mine',{count:1});await job('player/header');await job('player/claim');await job('mine',{count:2});
    const finds=await request('finds?owner='+owner+'&limit=1');assert.ok(finds.total);return {finds:finds.total};
  });
  const discovery=await step('Commit and reveal a pattern',async()=>{
    let proposal;
    for(const digit of ['1','2','3','4','5','6','7','8','9','0'])if(!await firstMatch('patterns','patterns',p=>p.pat===digit&&p.fld===4)){proposal={name:patternName({pat:digit,fld:4,dt:'n'}),pat:digit,fld:4,dt:'n'};break;}
    assert.ok(proposal,'No unused tour digit pattern');
    const occupied=[];
    while(await firstMatch('patterns?q='+encodeURIComponent(proposal.name),'patterns',p=>p.name===proposal.name)){occupied.push({name:proposal.name});proposal.name=patternName(proposal,occupied);}
    await job('mine',{count:1});const actionId='tour-discovery-'+tag;
    const committed=await job('player/discovery/commit',{actionId,proposal});await job('mine',{count:2});const reveal=await job('player/discovery/reveal',{actionId});
    await job('mine',{count:1});const accepted=await firstMatch('patterns?q='+encodeURIComponent(proposal.name),'patterns',p=>p.name===proposal.name);assert.ok(accepted,'Discovery must actually be accepted');return {commitment:committed.commitment,phase:reveal.phase,asset:accepted.asset,rarity:accepted.rarity,discoverer:accepted.discoverer};
  });
  await step('Discovered pattern mint and discoverer share',async()=>{
    let intent=artifacts.discoveryMint;
    if(!intent){
      let right;
      for(let i=0;i<4&&!right;i++){
        await job('mine',{count:1});await job('player/claim',{patterns:[Number(discovery.asset.slice(1))]});await job('mine',{count:2});
        right=await firstMatch('player/mintRights?asset='+discovery.asset,'mintRights',r=>r.allowed||r.rightAllowed);
      }
      assert.ok(right,'A witnessed draw must fund the discovered element');intent=artifacts.discoveryMint={asset:right.asset,block:right.block,amount:right.amount};await checkpoint();
    }
    if(!intent.id){const pending=await job('player/mint',{actionId:'tour-discovered-'+tag,...intent,kind:'tap'});requireRequest(pending);intent.id=pending.request.id;await checkpoint();}
    const paid=await job('player/pay',{id:intent.id});assert.equal(paid.request.state,'minted');
    const quote=await job('player/mint/quote',{asset:intent.asset,block:intent.block,kind:'tap'});assert.ok(BigInt(quote.split.discoverer)>0n);return {id:intent.id,inscription:paid.request.inscription,discovererShare:quote.split.discoverer};
  });
  const crafted=await step('Craft a compound',async()=>{await job('mine',{count:1});const r=await job('player/craft',{actionId:'tour-craft-'+tag,recipe:'fusion',inputs:[['p0','1'],['p1','1']]});assert.ok(BigInt((await firstMatch('player/balances?asset='+r.compound.id,'balances'))?.amount??'0')>=1n);return {asset:r.compound.id};});
  const bots=(await request('bots')).agents;assert.ok(bots.length,'Tour uses a funded bot as a transfer recipient');const to=bots[0].address;
  await step('TNK transfer',async()=>job('player/transfer',{actionId:'tour-transfer-'+tag,to,assets:[['p0','1']]}));
  for(const kind of ['tap','ethereum'])await step(kind+' make-real and native fee burn',async()=>{
    let intent=artifacts[kind];
    if(!intent){const right=await firstMatch('player/mintRights?asset=p0&allowed=true','mintRights');assert.ok(right,'Owner needs a mintable p0 find');intent=artifacts[kind]={asset:right.asset,block:right.block,amount:right.amount};await checkpoint();}
    const quote=intent.quote??await job('player/mint/quote',{asset:intent.asset,block:intent.block,kind});intent.quote=quote;await checkpoint();
    const pending=intent.id?{request:{id:intent.id}}:await job('player/mint',{actionId:'tour-mint-'+kind+'-'+tag,...intent,quote:undefined,kind});requireRequest(pending);intent.id=pending.request.id;await checkpoint();
    const paid=await job('player/pay',{id:pending.request.id,type:'mint'});assert.equal(paid.request.state,'minted');assert.ok(paid.request.inscription);const minted=(await request(`world?from=${intent.block}&to=${intent.block}`)).plots[0];assert.equal(minted.minted,true);assert.equal(minted.finds.find(f=>f.asset===intent.asset)?.minted,true);return {kind,block:intent.block,price:quote.price,split:quote.split,id:paid.id,inscription:paid.request.inscription};
  });
  await step('Compound make-real',async()=>{const pending=await job('player/compound/mint',{actionId:'tour-compound-'+tag,asset:crafted.asset,amount:'1',kind:'tap'});requireRequest(pending);const paid=await job('player/pay',{id:pending.request.id});assert.equal(paid.request.state,'minted');return {asset:crafted.asset,inscription:paid.request.inscription};});
  await step('Real Bitmap and permanent paid link',async()=>{const plot=await firstMatch('world?from=1&to=511&linked=false','plots');assert.ok(plot);const bitmap=await job('player/bitmap',{height:plot.height});assert.deepEqual(await firstMatch('player/bitmaps?height='+plot.height,'bitmaps'),{height:plot.height,inscription:bitmap.inscription,linked:false});const intent=await job('player/link',{actionId:'tour-link-'+tag,height:plot.height});const paid=await job('player/pay',{id:intent.request.id,type:'link'});assert.ok((await request('blocks/'+plot.height)).link);assert.equal((await firstMatch('player/bitmaps?height='+plot.height,'bitmaps'))?.linked,true);return {height:plot.height,bitmap:bitmap.inscription,payment:paid.paymentId};});
  await step('Live base price',async()=>{const before=(await request('status')).feePolicy.baseFee;const changed=await job('fee',{baseFee:'200'});assert.equal((await request('status')).feePolicy.baseFee,parseTapAmount('200'));await job('fee',{baseFee:formatTapAmount(before)});return changed;});
  await step('Finder window and 2016-block region travel',async()=>{const before=await request('status');const advance=Math.max(1009,(Math.floor(before.tip/2016)+1)*2016-before.tip+1);const result=await job('time-travel',{blocks:advance});assert.ok(result.counted-before.counted>=1009);assert.ok(Math.floor(result.tip/2016)>Math.floor(before.tip/2016));return result;});
  await step('Reorg depths 1 and 7',async()=>{await job('mine',{count:10});const one=await job('reorg',{depth:1}),seven=await job('reorg',{depth:7});assert.notEqual(one.oldHash,one.newHash);assert.notEqual(seven.oldHash,seven.newHash);return {one,seven};});
  await step('On-chain results and direct payouts',async()=>{const r=await request('results');assert.ok((await request('results/mints?state=minted&limit=1')).total>=3);assert.ok(r.counts.ethereum);return {mints:r.counts.mints,ethereum:r.counts.ethereum,payouts:r.counts.payouts,treasury:r.treasury,burn:r.burn};});
  await save(join(DATA,'tour.json'),{state:'complete',tag,steps,artifacts,completed:Date.now()});console.log(`PASS: ${steps.length} mechanics checks. Evidence: playground/.data/tour.json`);
}catch(error){await save(join(DATA,'tour.json'),{state:'failed',tag,steps,artifacts,error:error.message});console.error(error.message);process.exitCode=1;}
