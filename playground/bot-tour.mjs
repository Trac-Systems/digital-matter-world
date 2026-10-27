#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA,origin,save,sleep } from './common.mjs';
const token=(await readFile(join(DATA,'control.token'),'utf8')).trim();
const path=join(DATA,'bot-tour.json');
const saved=process.argv.includes('--resume')?JSON.parse(await readFile(path)):{};
const actions=new Set(saved.actions??[]),wanted=['discovery/commit','discovery/reveal','craft','compound/mint','transfer','mint','link'];
async function api(path,body){const r=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const b=await r.json();assert.ok(r.ok,JSON.stringify(b));return b;}
async function firstMatch(path,key,predicate=()=>true){const url=new URL(path,origin+'/api/');url.searchParams.set('limit','200');for(;;){const page=await api(url.pathname.slice(5)+url.search),row=page[key].find(predicate);if(row||!page.next)return row;url.searchParams.set('cursor',page.next);}}
async function job(path,body={}){const j=await api(path,body),end=Date.now()+300000;while(Date.now()<end){const r=await api('jobs/'+j.id);if(r.state==='complete')return r.result;if(r.state==='failed')throw Error(r.error);await sleep(250);}throw Error('bot job timeout');}
let before;
try{
  before=await api('bots');await job('mining',{enabled:false});await job('bots',{count:3,paused:true});
  for(let i=0;i<80;i++){
    const state=await job('bots/step');
    for(const a of state.agents){if(a.error)throw Error(a.name+': '+a.error);if(a.lastAction?.action&&!actions.has(a.lastAction.action)){actions.add(a.lastAction.action);console.log(a.name+': '+a.lastAction.action);}}
    await save(path,{state:'running',actions:[...actions],round:i});
    if(wanted.every(a=>actions.has(a))){assert.ok(await firstMatch('patterns?discoverer='+state.agents[1].address,'patterns'),'Bot discovery must be accepted');assert.ok(await firstMatch('compounds?firstMaker='+state.agents[2].address,'compounds',c=>BigInt(c.madeReal)>0n),'Bot compound must be made real');await save(path,{state:'complete',actions:[...actions],round:i});console.log('PASS: all three bot strategies exercised.');break;}
    await job('mine',{count:1});
    if(i===79)throw Error('Bot strategies did not finish in 80 rounds');
  }
}catch(error){await save(path,{state:'failed',actions:[...actions],error:error.message});console.error(error.message);process.exitCode=1;}
finally{if(before)await job('bots',{count:before.count,paused:true}).catch(()=>{});}
